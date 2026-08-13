function syncGlobalHeaderHeight(){
  const appEl = document.getElementById('app');
  if (!appEl) return null;
  const h = Math.max(0, Math.round(appEl.offsetTop));
  document.documentElement.style.setProperty('--global-header-h', h + 'px');
  return appEl;
}
document.addEventListener('DOMContentLoaded', () => {
  syncGlobalHeaderHeight();
  requestAnimationFrame(syncGlobalHeaderHeight); // after layout settles
});
window.addEventListener('load', syncGlobalHeaderHeight);      // after images/fonts finish loading
window.addEventListener('resize', syncGlobalHeaderHeight);
if (document.fonts && document.fonts.ready){
  document.fonts.ready.then(syncGlobalHeaderHeight).catch(()=>{}); // web font swap can change header height
}
if (window.ResizeObserver){
  // Watching <body> itself catches any size change anywhere above #app
  // (header.js content loading late, wrapping differently, swapping fonts,
  // etc.) without needing to know its internal structure.
  new ResizeObserver(syncGlobalHeaderHeight).observe(document.body);
}
// Catch header.js injecting/replacing/resizing its markup at any point,
// including after DOMContentLoaded/load already fired.
new MutationObserver(syncGlobalHeaderHeight).observe(document.body, { childList:true, subtree:true });

function syncStickyOffsets(){
  const topbar = document.querySelector('.am-topbar');
  const topbarH = topbar ? Math.ceil(topbar.getBoundingClientRect().height) : 0;
  document.documentElement.style.setProperty('--topbar-h', topbarH + 'px');
  syncMaintTheadOffset();
}

function syncMaintTheadOffset(){
  const stickyTop = document.querySelector('.maint-sticky-top');

  if (!stickyTop){
    document.documentElement.style.setProperty('--maint-thead-top', '0px');
    return;
  }

  const stickyStyle = getComputedStyle(stickyTop);
  const stickyInsetTop = parseFloat(stickyStyle.top) || 0;
  const stickyHeight = Math.ceil(stickyTop.getBoundingClientRect().height);

  const theadTop = Math.max(
    0,
    Math.ceil(stickyInsetTop + stickyHeight)
  );

  document.documentElement.style.setProperty(
    '--maint-thead-top',
    theadTop + 'px'
  );
}
let maintTheadRaf = null;
function scheduleMaintTheadSync(){
  if (maintTheadRaf) return;
  maintTheadRaf = requestAnimationFrame(() => {
    maintTheadRaf = null;
    syncMaintTheadOffset();
  });
}
window.addEventListener('scroll', scheduleMaintTheadSync, { passive: true });
window.addEventListener('resize', scheduleMaintTheadSync);
document.addEventListener('DOMContentLoaded', () => {
  syncStickyOffsets();
  requestAnimationFrame(syncStickyOffsets);
});
window.addEventListener('load', syncStickyOffsets);
window.addEventListener('resize', syncStickyOffsets);
if (document.fonts && document.fonts.ready){
  document.fonts.ready.then(syncStickyOffsets).catch(()=>{});
}
if (window.ResizeObserver){
  const stickyResizeObserver = new ResizeObserver(syncStickyOffsets);
  const topbarEl = document.querySelector('.am-topbar');
  if (topbarEl) stickyResizeObserver.observe(topbarEl); // also fires when #app flips from display:none to visible
}

// ---------- data loading (external JSON / GitHub) ----------
let ENC_STORE = null;
let githubConfig = null;
let githubToken = null;
let githubSha = null;
let lastSyncedState = null;

function cloneSyncState(v){
  return v == null
    ? v
    : JSON.parse(JSON.stringify(v));
}

function currentSyncState(){
  return {
    salt: ENC_STORE.salt,
    iterations: ENC_STORE.iterations,

    records: cloneSyncState(records || []),
    users: cloneSyncState(users || []),
    maintenanceLogs: cloneSyncState(maintenanceLogs || []),
    auditLogs: cloneSyncState(auditLogs || [])
  };
}

// Hardcoded default repo location.
const DEFAULT_GITHUB_CONFIG = {
  repo: 'etech-symantec/ma',
  branch: 'main',
  path: 'data.json'
};

const _ok = 'etechMA26-restricted'; // xor key — also just visible text, not a secret
const _ot = [
  'Ah0RCx0vHkJXWS1UQjYoLjcwMyU=',
  'VUIoWl8pDAtvQQQnHCsTAi84FjU=',
  'P009WiE4LnB5QBkMNTYjEyUlIhY=',
  'Kh4pNhECE1VSfgU8HUIHH1s6IzA=',
  'IjI9Il8PGFpCWjkWBQ==',
];
function _xorB64(b64, key){
  const raw = atob(b64);
  let out = '';
  for (let i = 0; i < raw.length; i++) out += String.fromCharCode(raw.charCodeAt(i) ^ key.charCodeAt(i % key.length));
  return out;
}
function _decodeAuth(){
  try{
    if (!_ot.length) return null;
    return _ot.map(part => _xorB64(part, _ok)).join('');
  }catch(e){ return null; }
}

let autoSyncTimer = null;
let autoSyncInFlight = false;
let autoSyncQueued = false;
let hasUnsyncedChanges = false;

function setSyncStatus(state, msg){
  const el = document.getElementById('githubSyncStatus');
  if (!el) return;

  if (state === 'pending'){
    el.textContent = '저장 대기';
    el.title = '변경사항 GitHub 동기화 대기 중';
    el.className = 'sync-status pending';
  }
  else if (state === 'syncing'){
    el.textContent = '동기화 중…';
    el.title = 'GitHub에 데이터를 저장하고 있습니다.';
    el.className = 'sync-status syncing';
  }
  else if (state === 'synced'){
    const time = new Date().toLocaleTimeString('ko-KR');
    el.textContent = '✓ 저장됨';
    el.title = `GitHub 동기화 완료 · ${time}`;
    el.className = 'sync-status synced';
  }
  else if (state === 'error'){
    el.textContent = '⚠ 저장 실패';
    el.title = 'GitHub 동기화 실패: ' + (msg || '');
    el.className = 'sync-status error';
  }
  else if (state === 'offline'){
    el.textContent = '';
    el.title = '';
    el.className = 'sync-status';
  }
}

function scheduleAutoSync(){
  captureAuditFromStateDiff();
  hasUnsyncedChanges = true;

  if (!githubConfig || !githubToken){
    setSyncStatus('error', 'GitHub 연결 정보가 없습니다.');
    return;
  }

  setSyncStatus('pending');
  clearTimeout(autoSyncTimer);
  autoSyncTimer = setTimeout(() => {
    autoSyncTimer = null;
    runAutoSync();
  }, 1200);
}

/* =========================================================
   GitHub 동시 저장 충돌 방지 - 3-way merge
   ========================================================= */

function syncEqual(a, b){
  return JSON.stringify(a ?? null) ===
         JSON.stringify(b ?? null);
}


function mergeObject3Way(base, local, remote){

  /*
    BASE에는 있었는데 LOCAL에서 삭제됨
    → 내가 삭제한 것으로 판단
  */
  if (base && !local){
    return null;
  }


  /*
    REMOTE에서 삭제됐고
    나는 해당 데이터를 수정하지 않았다면
    상대방의 삭제를 유지
  */
  if (
    base &&
    !remote &&
    syncEqual(local, base)
  ){
    return null;
  }


  /* 내가 새로 추가 */
  if (!base && local && !remote){
    return cloneSyncState(local);
  }


  /* 상대방이 새로 추가 */
  if (!base && !local && remote){
    return cloneSyncState(remote);
  }


  /* 둘 다 없음 */
  if (!local && !remote){
    return null;
  }


  /*
    REMOTE에는 없지만
    나는 해당 데이터를 수정했다면 LOCAL 유지
  */
  if (!remote){
    return local
      ? cloneSyncState(local)
      : null;
  }


  if (!local){
    return cloneSyncState(remote);
  }


  const result = {};

  const keys = new Set([
    ...Object.keys(base || {}),
    ...Object.keys(local || {}),
    ...Object.keys(remote || {})
  ]);


  keys.forEach(key => {

    const b = base?.[key];
    const l = local?.[key];
    const r = remote?.[key];


    /*
      나는 이 필드를 수정하지 않음
      → GitHub 최신값 사용
    */
    if (syncEqual(l, b)){
      result[key] = cloneSyncState(r);
      return;
    }


    /*
      상대방은 이 필드를 수정하지 않음
      → 내 변경값 사용
    */
    if (syncEqual(r, b)){
      result[key] = cloneSyncState(l);
      return;
    }


    /*
      둘 다 동일한 값으로 변경
    */
    if (syncEqual(l, r)){
      result[key] = cloneSyncState(l);
      return;
    }


    /*
      작업 이력 배열은 배열 전체를 덮지 않고
      각 작업 이력 ID를 기준으로 다시 병합
    */
    if (
      key === 'work_log' ||
      key === 'deleted_work_log'
    ){
      result[key] = mergeArrayById3Way(
        b || [],
        l || [],
        r || []
      );

      return;
    }


    /*
      같은 필드를 나와 상대방이 동시에 서로 다르게 수정한 경우
      현재 사용자가 수정한 LOCAL 값을 우선.
    */
    result[key] = cloneSyncState(l);

  });


  return result;
}


function mergeArrayById3Way(
  baseArray,
  localArray,
  remoteArray
){

  const getId = item =>
    String(
      item?.id ??
      item?.history_id ??
      ''
    );


  const baseMap = new Map(
    (baseArray || [])
      .filter(x => getId(x))
      .map(x => [
        getId(x),
        x
      ])
  );


  const localMap = new Map(
    (localArray || [])
      .filter(x => getId(x))
      .map(x => [
        getId(x),
        x
      ])
  );


  const remoteMap = new Map(
    (remoteArray || [])
      .filter(x => getId(x))
      .map(x => [
        getId(x),
        x
      ])
  );


  const ids = new Set([
    ...baseMap.keys(),
    ...localMap.keys(),
    ...remoteMap.keys()
  ]);


  const result = [];


  ids.forEach(id => {

    const merged = mergeObject3Way(
      baseMap.get(id),
      localMap.get(id),
      remoteMap.get(id)
    );


    if (merged){
      result.push(merged);
    }

  });


  return result;
}


function mergeStateArray(
  baseArray,
  localArray,
  remoteArray,
  idFn
){

  const baseMap = new Map(
    (baseArray || []).map(x => [
      String(idFn(x)),
      x
    ])
  );


  const localMap = new Map(
    (localArray || []).map(x => [
      String(idFn(x)),
      x
    ])
  );


  const remoteMap = new Map(
    (remoteArray || []).map(x => [
      String(idFn(x)),
      x
    ])
  );


  const ids = new Set([
    ...baseMap.keys(),
    ...localMap.keys(),
    ...remoteMap.keys()
  ]);


  const result = [];


  ids.forEach(id => {

    const merged = mergeObject3Way(
      baseMap.get(id),
      localMap.get(id),
      remoteMap.get(id)
    );


    if (merged){
      result.push(merged);
    }

  });


  return result;
}


function mergeSyncStates(
  base,
  local,
  remote
){

  base = base || {
    records:[],
    users:[],
    maintenanceLogs:[],
    auditLogs:[]
  };


  return {

    salt:
      remote?.salt ||
      local?.salt ||
      base?.salt,

    iterations:
      remote?.iterations ||
      local?.iterations ||
      base?.iterations,


    records:
      mergeStateArray(
        base.records || [],
        local.records || [],
        remote.records || [],
        r => r.id
      ),


    users:
      mergeStateArray(
        base.users || [],
        local.users || [],
        remote.users || [],
        u => u.id
      ),


    maintenanceLogs:
      mergeStateArray(
        base.maintenanceLogs || [],
        local.maintenanceLogs || [],
        remote.maintenanceLogs || [],
        m =>
          m.id ||
          `${m.group}|${m.ym}`
      ),


    auditLogs:
      mergeStateArray(
        base.auditLogs || [],
        local.auditLogs || [],
        remote.auditLogs || [],
        a => a.id
      )

  };
}

async function runAutoSync(){
  if (!githubConfig || !githubToken){
    return;
  }
  if (autoSyncInFlight){
    autoSyncQueued = true;
    return;
  }
  autoSyncInFlight = true;
  autoSyncQueued = false;
  setSyncStatus('syncing');

  try{
    const localState =
      currentSyncState();

    let mergedState = null;
    let savedSha = null;
    const MAX_RETRY = 5;

    for (
      let attempt = 1;
      attempt <= MAX_RETRY;
      attempt++
    ){
      const {
        json: remoteState,
        sha: remoteSha
      } =
        await githubApiGet(
          githubConfig,
          githubToken
        );
      mergedState =
        mergeSyncStates(
          lastSyncedState,
          localState,
          remoteState
        );
      try{
        savedSha =
          await githubApiPut(
            githubConfig,
            githubToken,
            mergedState,
            remoteSha,

            '자산 데이터 자동 병합 동기화 - ' +
            new Date().toLocaleString('ko-KR')
          );
        break;
      }
      catch(e){
        if (
          (
            e.status === 409 ||
            e.status === 422
          ) &&
          attempt < MAX_RETRY
        ){
          console.warn(
            `GitHub 동시 저장 충돌 - 자동 재병합 ${attempt}/${MAX_RETRY}`
          );
          await new Promise(
            resolve =>
              setTimeout(
                resolve,
                250 * attempt
              )
          );
          continue;
        }
        throw e;
      }
    }
    if (!savedSha || !mergedState){
      throw new Error(
        'GitHub 동시 저장 충돌을 자동으로 해결하지 못했습니다.'
      );
    }
    suppressAuditCapture = true;
    try{
      records =
        cloneSyncState(
          mergedState.records || []
        );
      users =
        cloneSyncState(
          mergedState.users || []
        );
      maintenanceLogs =
        cloneSyncState(
          mergedState.maintenanceLogs || []
        );
      auditLogs =
        cloneSyncState(
          mergedState.auditLogs || []
        );
      githubSha =
        savedSha;
      lastSyncedState =
        cloneSyncState(
          mergedState
        );
      refreshAuditSnapshot();
    }
    finally{
      suppressAuditCapture = false;
    }
    hasUnsyncedChanges = false;
    setSyncStatus('synced');
  }
  catch(e){
    hasUnsyncedChanges = true;
    console.error(
      '자동 동기화 실패:',
      e
    );
    setSyncStatus(
      'error',
      e.message
    );
  }
  finally{
    autoSyncInFlight = false;
    if (autoSyncQueued){
      runAutoSync();
    }
  }
}

window.addEventListener('beforeunload', (e) => {
  const syncPending = hasUnsyncedChanges || autoSyncInFlight || autoSyncTimer !== null;
  if (!syncPending) return;
  e.preventDefault();
  e.returnValue = '';
});

githubConfig = loadGithubConfigFromStorage() || DEFAULT_GITHUB_CONFIG;

const dataReady = (async () => {
  const cfg = githubConfig;
  const token = loadRememberedToken() || _decodeAuth();
  if (cfg && cfg.repo && token){
    try{
      const { json, sha } = await githubApiGet(cfg, token);
      ENC_STORE = json;
      records = ENC_STORE.records.map(r => ({...r}));
      users = (ENC_STORE.users || []).map(u => ({...u}));
      maintenanceLogs = (ENC_STORE.maintenanceLogs || []).map(m => ({...m}));
      auditLogs = (ENC_STORE.auditLogs || []).map(a => ({...a}));
      githubConfig = cfg;
      githubToken = token;
      githubSha = sha;
      
      lastSyncedState = currentSyncState();
      
      return;
    }catch(e){
      console.warn('GitHub 자동 불러오기 실패, 로컬 data.json으로 대체합니다:', e);
    }
  }
  const r = await fetch('data.json');
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const json = await r.json();
  ENC_STORE = json;
  records = ENC_STORE.records.map(r => ({...r}));
  users = (ENC_STORE.users || []).map(u => ({...u}));
  maintenanceLogs = (ENC_STORE.maintenanceLogs || []).map(m => ({...m}));
  auditLogs = (ENC_STORE.auditLogs || []).map(a => ({...a}));
  lastSyncedState = currentSyncState();
})().catch(err => {
  console.error('데이터 로드 실패:', err);
});

let sessionKey = null;
let viewOnly = false;
let records = [];
let users = [];
let maintenanceLogs = [];
let auditLogs = [];
let auditSnapshot = null;
let expandedGroups = new Set();
let activeStatusFilters = new Set(['ok','warn','na']);
let activeCountryFilter = null;
let activeSkuKeywordFilters = new Set();
let activeMyAssetsFilter = false;
let workLogRecordIds = [];
let workLogEditId = null;
let editingRecordId = null;
let addAssetTargetGid = null;

function skuTagLabel(r){
  const tags = skuKeywordMatches(r.sku);
  return tags.length ? tags.join('/') : '미지정';
}

// ---------- SKU category tags ----------
const SKU_CATEGORIES = [
  // -- prefix rules --
  { match:'prefix', value:'ISG-Pro',     color:'#A78BFA' }, // ISG family (violet)
  { match:'prefix', value:'ISG-MA',      color:'#8B5CF6' }, // ISG family
  { match:'prefix', value:'ISG-MC',      color:'#7C3AED' }, // ISG family
  { match:'prefix', value:'MA-CAS',      color:'#2DD4BF' }, // CAS family (teal)
  { match:'prefix', value:'CLD-',        color:'#60A5FA' }, // network/security family (blue)
  { match:'prefix', value:'ASG-',        color:'#3B82F6' }, // network/security family
  { match:'prefix', value:'SG-S',        color:'#D97706' }, // endpoint family (amber) — checked before generic SG-prefixed rules
  { match:'prefix', value:'SG900',       color:'#22C55E' }, // misc hardware family (green)
  { match:'prefix', value:'MC-',         color:'#FBBF24' }, // endpoint family
  { match:'prefix', value:'IS-',         color:'#F59E0B' }, // endpoint family
  { match:'prefix', value:'CPOS-',       color:'#F472B6' }, // POS/hardware family (pink)
  { match:'prefix', value:'SW_Flash-',   color:'#EC4899' }, // POS/hardware family
  { match:'prefix', value:'PS-S',        color:'#DB2777' }, // POS/hardware family
  { match:'prefix', value:'VIP-',        color:'#4ADE80' }, // misc hardware family (green)
  { match:'prefix', value:'ELK',         color:'#16A34A' }, // misc hardware family
  // -- contains rules --
  { match:'contains', value:'ISG-PR-',   color:'#6D28D9' }, // ISG family
  { match:'contains', value:'ISG-CA',    color:'#5B21B6' }, // ISG family
  { match:'contains', value:'CAS-',      color:'#14B8A6' }, // CAS family
  { match:'contains', value:'FI-',       color:'#2563EB' }, // network/security family
  { match:'contains', value:'RP-',       color:'#22D3EE' }, // RP/BC family (cyan)
  { match:'contains', value:'BCWF',      color:'#06B6D4' }, // RP/BC family
  { match:'contains', value:'SW-E-TAP',  color:'#0891B2' }, // RP/BC family
  { match:'contains', value:'SSP-S',     color:'#FB7185' }, // SSP/WSS family (rose)
  { match:'contains', value:'WSS',       color:'#F43F5E' }, // SSP/WSS family
  { match:'contains', value:'CA-VA',     color:'#E11D48' }, // SSP/WSS family
  // -- exact rules --
  { match:'exact', value:'WEB-PROTECT-SUB', color:'#94A3B8' }, // standalone (slate)
];

function skuCategory(sku){
  if (!sku) return null;
  for (const c of SKU_CATEGORIES){
    if (c.match==='prefix' && sku.startsWith(c.value)) return c;
    if (c.match==='contains' && sku.includes(c.value)) return c;
    if (c.match==='exact' && sku===c.value) return c;
  }
  return null;
}
function skuBadge(sku){
  const label = esc(sku) || '—';
  if (!sku) return label;
  const cat = skuCategory(sku);
  if (!cat) return label;
  return `<span class="sku-tag" style="color:${cat.color}; border-color:${cat.color}55; background:${cat.color}1a;">
    <span class="sku-dot" style="background:${cat.color}"></span>${label}
  </span>`;
}

// ---------- SKU keyword tags (filterable/searchable) ----------
const SKU_TAG_RULES = [
  { key:'BCIS', test: sku => sku.toUpperCase().startsWith('IS-') },
  { key:'PAC', test: sku => sku.toUpperCase().startsWith('PAC') },
  { key:'ASG',  test: sku => sku.toUpperCase().includes('ASG') },
  { key:'MC',   test: sku => sku.toUpperCase().startsWith('MC-') || sku.toUpperCase().includes('-MC') },
  { key:'RP',   test: sku => sku.toUpperCase().includes('RP') },
  { key:'ISG',  test: sku => sku.toUpperCase().startsWith('SSP-S') },
  { key:'SG', test: sku => {
      const s = sku.toUpperCase();
  
      return s.startsWith('ISG-PR') ||
             (
               s.includes('SG') &&
               !s.includes('ISG-') &&
               !s.startsWith('ASG-S')
             );
  }},
  { key:'PS',   test: sku => sku.toUpperCase().includes('PS') },
  { key:'VA', test: sku => {
      const s = sku.toUpperCase();
  
      return (
        s.includes('-VA') ||
        s.includes('-V')
      );
  }},
  { key:'ELK',  test: sku => sku.toUpperCase().includes('ELK') },
  { key:'CLD',  test: sku => sku.toUpperCase().includes('CLD') },
  { key:'BCWF', test: sku => sku.toUpperCase().includes('BCWF') },
  { key:'WSS',  test: sku => sku.toUpperCase().includes('WSS') },
  { key:'WPS',  test: sku => sku.toUpperCase() === 'WEB-PROTECT-SUB' },
  { key:'CA', test: sku => {
      const s = sku.toUpperCase();
      return s.startsWith('CAS-') || s.startsWith('ISG-CA');
  }},
  { key:'MA', test: sku => {
      const s = sku.toUpperCase();
      return s.startsWith('MA-') || s.startsWith('ISG-MA');
  }},
  { key:'AV', test: sku => sku.toUpperCase().startsWith('FI-') },
];
const SKU_TAG_KEYS = SKU_TAG_RULES.map(r => r.key);

function skuKeywordMatches(sku){
  if (!sku) return [];
  return SKU_TAG_RULES.filter(r => r.test(sku)).map(r => r.key);
}

function skuKeywordTagsHtml(sku){
  const kws = skuKeywordMatches(sku);
  if (!kws.length) return '';
  return `<div class="sku-kw-tags">${kws.map(k=>`<span class="sku-kw-tag${activeSkuKeywordFilters.has(k)?' active':''}" data-kwtag="${esc(k)}">${esc(k)}</span>`).join('')}</div>`;
}

// ---------- crypto helpers ----------
function b64ToBuf(b64){ return Uint8Array.from(atob(b64), c => c.charCodeAt(0)).buffer; }
function bufToB64(buf){
  const bytes = new Uint8Array(buf);
  let binary = '';
  const chunkSize = 0x8000; // 32768 — avoid spreading huge arrays into fromCharCode (call stack limit)
  for (let i = 0; i < bytes.length; i += chunkSize){
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

async function deriveKey(passphrase, saltB64, iterations){
  const enc = new TextEncoder();
  const baseKey = await crypto.subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name:'PBKDF2', salt: b64ToBuf(saltB64), iterations, hash:'SHA-256' },
    baseKey,
    { name:'AES-GCM', length:256 },
    true,
    ['encrypt','decrypt']
  );
}

async function hashPassword(password, saltB64, iterations){
  const enc = new TextEncoder();
  const baseKey = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name:'PBKDF2', salt: b64ToBuf(saltB64), iterations, hash:'SHA-256' },
    baseKey,
    256
  );
  return bufToB64(bits);
}

async function decryptField(field){
  if (!field || !sessionKey) return '';
  try{
    const iv = b64ToBuf(field.iv);
    const ct = new Uint8Array(b64ToBuf(field.ct));
    const tag = new Uint8Array(b64ToBuf(field.tag));
    const combined = new Uint8Array(ct.length + tag.length);
    combined.set(ct,0); combined.set(tag, ct.length);
    const plainBuf = await crypto.subtle.decrypt({name:'AES-GCM', iv}, sessionKey, combined.buffer);
    return new TextDecoder().decode(plainBuf);
  }catch(e){ return '⚠️ 복호화 실패'; }
}

async function encryptField(plain){
  if (!plain) return null;
  return encryptWithKey(plain, sessionKey);
}

async function decryptWithKey(field, key){
  const iv = b64ToBuf(field.iv);
  const ct = new Uint8Array(b64ToBuf(field.ct));
  const tag = new Uint8Array(b64ToBuf(field.tag));
  const combined = new Uint8Array(ct.length + tag.length);
  combined.set(ct,0); combined.set(tag, ct.length);
  const plainBuf = await crypto.subtle.decrypt({name:'AES-GCM', iv}, key, combined.buffer);
  return new TextDecoder().decode(plainBuf);
}
async function encryptWithKey(plain, key){
  if (!plain) return null;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const enc = new TextEncoder().encode(plain);
  const buf = await crypto.subtle.encrypt({name:'AES-GCM', iv}, key, enc);
  const full = new Uint8Array(buf);
  const ct = full.slice(0, full.length-16);
  const tag = full.slice(full.length-16);
  return { iv: bufToB64(iv.buffer), ct: bufToB64(ct.buffer), tag: bufToB64(tag.buffer) };
}

const MASTER_KEY_CACHE_KEY = 'bcAssetMasterKeyCache';
const MASTER_KEY_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24시간

function saveMasterKeyCache(key, saltB64, iterations){
  crypto.subtle.exportKey('raw', key).then(raw => {
    try{
      localStorage.setItem(MASTER_KEY_CACHE_KEY, JSON.stringify({
        keyB64: bufToB64(raw),
        salt: saltB64,
        iterations,
        expiresAt: Date.now() + MASTER_KEY_CACHE_TTL_MS
      }));
    }catch(e){}
  }).catch(()=>{});
}

function clearMasterKeyCache(){
  try{ localStorage.removeItem(MASTER_KEY_CACHE_KEY); }catch(e){}
}

async function tryUnlockFromCache(){
  let cached;
  try{ cached = JSON.parse(localStorage.getItem(MASTER_KEY_CACHE_KEY) || 'null'); }catch(e){ cached = null; }
  if (!cached || !cached.keyB64 || !cached.expiresAt) return false;
  if (Date.now() > cached.expiresAt){ clearMasterKeyCache(); return false; }
  if (!ENC_STORE || cached.salt !== ENC_STORE.salt || cached.iterations !== ENC_STORE.iterations){ clearMasterKeyCache(); return false; }
  try{
    const key = await crypto.subtle.importKey('raw', b64ToBuf(cached.keyB64), {name:'AES-GCM', length:256}, false, ['encrypt','decrypt']);
    const probe = ENC_STORE.records.find(r => r.ip_enc || r.id_enc || r.pw_enc || r.enable_pw_enc);
    if (probe){
      const f = probe.ip_enc || probe.id_enc || probe.pw_enc || probe.enable_pw_enc;
      const iv = b64ToBuf(f.iv);
      const ct = new Uint8Array(b64ToBuf(f.ct));
      const tag = new Uint8Array(b64ToBuf(f.tag));
      const combined = new Uint8Array(ct.length+tag.length); combined.set(ct,0); combined.set(tag,ct.length);
      await crypto.subtle.decrypt({name:'AES-GCM', iv}, key, combined.buffer);
    }
    sessionKey = key;
    return true;
  }catch(e){ clearMasterKeyCache(); return false; }
}

async function tryUnlock(passphrase){
  const key = await deriveKey(passphrase, ENC_STORE.salt, ENC_STORE.iterations);
  const probe = ENC_STORE.records.find(r => r.ip_enc || r.id_enc || r.pw_enc || r.enable_pw_enc);
  if (probe){
    const f = probe.ip_enc || probe.id_enc || probe.pw_enc || probe.enable_pw_enc;
    try{
      const iv = b64ToBuf(f.iv);
      const ct = new Uint8Array(b64ToBuf(f.ct));
      const tag = new Uint8Array(b64ToBuf(f.tag));
      const combined = new Uint8Array(ct.length+tag.length); combined.set(ct,0); combined.set(tag,ct.length);
      await crypto.subtle.decrypt({name:'AES-GCM', iv}, key, combined.buffer);
    }catch(e){ return false; }
  }
  sessionKey = key;
  saveMasterKeyCache(key, ENC_STORE.salt, ENC_STORE.iterations);
  return true;
}

// ---------- boot ----------
document.getElementById('unlockBtn').onclick = async () => {
  const pass = document.getElementById('passInput').value;
  const errEl = document.getElementById('lockError');
  if (!pass){ errEl.textContent = '비밀번호를 입력해 주세요.'; return; }
  errEl.textContent = '데이터 불러오는 중…';
  await dataReady;
  if (!ENC_STORE){ errEl.textContent = 'data.json을 불러오지 못했습니다. 로컬 웹서버로 열어주세요.'; return; }
  errEl.textContent = '확인 중…';
  const ok = await tryUnlock(pass);
  if (!ok){ errEl.textContent = '비밀번호가 올바르지 않습니다.'; return; }
  errEl.textContent = '';
  viewOnly = false;
  boot();
};
document.getElementById('passInput').addEventListener('keydown', e => { if (e.key==='Enter') document.getElementById('unlockBtn').click(); });
document.getElementById('viewOnlyBtn').onclick = async () => {
  const errEl = document.getElementById('lockError');
  errEl.textContent = '데이터 불러오는 중…';
  await dataReady;
  if (!ENC_STORE){ errEl.textContent = 'data.json을 불러오지 못했습니다. 로컬 웹서버로 열어주세요.'; return; }
  errEl.textContent = '';
  viewOnly = true; sessionKey = null; boot();
};
document.getElementById('howBtn').onclick = () => {
  alert('마스터 비밀번호는 이 페이지를 만들 때 채팅으로 전달된 문자열입니다. 안전한 곳(비밀번호 관리자 등)에 보관하세요.');
};

function boot(){
  document.getElementById('lockOverlay').style.display = 'none';
  document.getElementById('app').classList.add('ready');
  updateUserBtnLabel();
  suppressAuditCapture = true;
  const entitiesFixed = migrateStrayHtmlEntities();
  const brokenGroupFixed = repairKnownBrokenGeneratedGroups();
  const shellFixed = migrateEmptyGroupPlaceholders();
  const shellSupportFixed = normalizeShellSupportDefaults();
  const ownerFixed = migrateOwnerConsistencyWithinGroups();
  migrateCustContactRoleLabels();
  const migrated = enforceParentsHaveNoDirectAssets();
  refreshAuditSnapshot();
  suppressAuditCapture = false;
  render();
  requestAnimationFrame(() => { syncGlobalHeaderHeight(); syncStickyOffsets(); });
  if ((migrated || entitiesFixed || brokenGroupFixed || shellFixed || shellSupportFixed || ownerFixed) && !viewOnly && sessionKey){
    buildFilters();
    scheduleAutoSync();
  }
}

// ---------- date / status ----------
const GROUP_COMMON_SCALAR_FIELDS = [
  'flag','owner','country','location','check_method','config_mode',
  'owner_primary','owner_secondary','group_remarks','cust_memo','group_parent','is_parent'
];
function migrateOwnerConsistencyWithinGroups(){
  let changed = false;
  groupRecords(records).forEach((items) => {
    const meta = groupMeta(items);
    items.forEach(r => {
      GROUP_COMMON_SCALAR_FIELDS.forEach(f => {
        if (f === 'owner' && meta.owner === '(법인명 미확인)') return;
        const target = meta[f];
        if (r[f] !== target && !(!r[f] && !target)){ r[f] = target; changed = true; }
      });
    });
  });
  return changed;
}

function unescapeStrayHtmlEntities(s){
  if (!s || typeof s !== 'string') return s;
  if (!/&(amp|lt|gt|quot|#39);/.test(s)) return s;
  return s.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'");
}
const STRAY_ENTITY_FIELDS = ['owner','country','location','check_method','config_mode','owner_primary','owner_secondary','group_remarks','cust_memo','remarks','sku','sn'];
function migrateStrayHtmlEntities(){
  let changed = false;
  records.forEach(r => {
    STRAY_ENTITY_FIELDS.forEach(f => {
      if (typeof r[f] === 'string'){
        const fixed = unescapeStrayHtmlEntities(r[f]);
        if (fixed !== r[f]){ r[f] = fixed; changed = true; }
      }
    });
    if (Array.isArray(r.cust_contacts)){
      r.cust_contacts.forEach(c => {
        if (!c) return;
        ['role','name','org','phone','email'].forEach(f => {
          if (typeof c[f] === 'string'){
            const fixed = unescapeStrayHtmlEntities(c[f]);
            if (fixed !== c[f]){ c[f] = fixed; changed = true; }
          }
        });
      });
    }
  });
  return changed;
}

function migrateCustContactRoleLabels(){
  records.forEach(r => {
    if (Array.isArray(r.cust_contacts)){
      r.cust_contacts.forEach(c => { if (c && c.role === '운용') c.role = '운영'; });
    }
  });
}

function parseDate(s){
  if (!s || s === '-' ) return null;
  const parts = s.replace(/\s/g,'').split('.').map(Number);
  if (parts.length < 3 || parts.some(isNaN)) return null;
  return new Date(parts[0], parts[1]-1, parts[2]);
}
function licenseStatus(rec){
  const end = parseDate(rec.end);
  if (!end) return 'na';
  const now = new Date();
  const days = (end - now) / 86400000;
  if (days < 0) return 'crit';
  if (days <= 90) return 'warn';
  return 'ok';
}

function collectSubtreeLicenseStatuses(gid, groupsMap, visited){
  visited = visited || new Set();
  if (visited.has(gid)) return [];
  visited.add(gid);
  const items = groupsMap.get(gid) || [];
  let statuses = items.filter(r => !r.is_group_shell).map(r => licenseStatus(r));
  groupChildrenOf(gid).filter(cg => groupsMap.has(cg)).forEach(cg => {
    statuses = statuses.concat(collectSubtreeLicenseStatuses(cg, groupsMap, visited));
  });
  return statuses;
}

function aggregateLicenseStatus(statuses){
  if (!statuses.length) return 'na';
  const hasCrit = statuses.includes('crit');
  const hasNonCrit = statuses.some(s => s !== 'crit');
  if (hasCrit && hasNonCrit) return 'partial';
  if (hasCrit) return 'crit';
  if (statuses.includes('warn')) return 'warn';
  if (statuses.includes('ok')) return 'ok';
  return 'na';
}
function statusBadgeVisual(s){
  if (s === 'crit') return { cls:'tag-x', color:'var(--red)' };
  if (s === 'warn') return { cls:'', color:'var(--amber)' };
  if (s === 'partial') return { cls:'tag-partial', color:'#B45309' };
  if (s === 'ok') return { cls:'tag-o', color:'var(--green)' };
  return { cls:'tag-o', color:'var(--text-faint)' };
}
function licenseBarPct(rec){
  const start = parseDate(rec.start), end = parseDate(rec.end);
  if (!start || !end || end <= start) return 100;
  const now = new Date();
  const pct = ((now-start)/(end-start))*100;
  return Math.max(0, Math.min(100, pct));
}

function daysUntilEnd(rec){
  const end = parseDate(rec.end);
  if (!end) return null;
  const now = new Date();
  const endMid = new Date(end.getFullYear(), end.getMonth(), end.getDate());
  const nowMid = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((endMid - nowMid) / 86400000);
}
function daysLabel(rec){
  const d = daysUntilEnd(rec);
  if (d === null) return '';
  if (d > 0) return `D-${d}`;
  if (d === 0) return 'D-day';
  return `D+${Math.abs(d)}`;
}

// ---------- rendering ----------
function esc(s){
  if (s===null || s===undefined) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function groupRecords(list){
  const map = new Map();
  list.forEach(r => {
    if (!map.has(r.group)) map.set(r.group, []);
    map.get(r.group).push(r);
  });
  return map;
}


// ---------- 안정적인 레코드 / 그룹 ID 생성 ----------
function nextRecordId(){
  let maxId = 0;
  const used = new Set(records.map(r => String(r.id)));
  records.forEach(r => {
    const n = Number(r.id);
    if (Number.isFinite(n) && n >= 0) maxId = Math.max(maxId, Math.floor(n));
  });
  let candidate = maxId + 1;
  while (used.has(String(candidate))) candidate++;
  return candidate;
}

function makeUniqueGroupId(prefix='custom'){
  const used = new Set(records.map(r => String(r.group || '')));
  const base = `${prefix}-${Date.now().toString(36)}`;
  let gid = base;
  let seq = 1;
  while (used.has(gid)) gid = `${base}-${seq++}`;
  return gid;
}

function isAssetPayloadEmpty(r){
  if (!r) return true;
  const scalar = [r.sku,r.sn,r.qty,r.start,r.end,r.os_ver,r.remarks,r.deploy_date,r.mode];
  const hasScalar = scalar.some(v => v !== null && v !== undefined && String(v).trim() !== '');
  const hasSecret = !!(r.ip_enc || r.id_enc || r.pw_enc || r.enable_pw_enc);
  const hasLog = Array.isArray(r.work_log) && r.work_log.length > 0;
  return !hasScalar && !hasSecret && !hasLog;
}

function migrateEmptyGroupPlaceholders(){
  let changed = false;
  records.forEach(r => {
    if (!r.is_group_shell && isAssetPayloadEmpty(r)){
      r.is_group_shell = true;
      changed = true;
    }
  });
  return changed;
}

function normalizeShellSupportDefaults(){
  let changed = false;
  const gids = [...new Set(records.map(r => r.group))];
  gids.forEach(gid => {
    const items = records.filter(r => r.group === gid);
    const shells = items.filter(r => r.is_group_shell);
    const real = items.filter(r => !r.is_group_shell);
    if (!shells.length || !real.length) return;

    const shell = shells.find(r => (r.support_id||'').trim()) || shells[0];
    const shellSid = (shell.support_id||'').trim();
    if (!shellSid) return;

    const realSids = new Set(real.map(r => (r.support_id||'').trim()).filter(Boolean));
    if (realSids.size <= 1){
      real.forEach(r => {
        if ((r.support_id||'').trim() !== shellSid){ r.support_id = shellSid; changed = true; }
        if (shell.build_engineer && r.build_engineer !== shell.build_engineer){ r.build_engineer = shell.build_engineer; changed = true; }
        if (shell.build_date && r.build_date !== shell.build_date){ r.build_date = shell.build_date; changed = true; }
      });
    }
  });
  return changed;
}

function repairKnownBrokenGeneratedGroups(){
  let changed = false;
  const badGroups = [...new Set(records.map(r=>String(r.group||'')))]
    .filter(g => /^(custom|dup)-NaN(?:-|$)/.test(g));

  badGroups.forEach(gid => {
    const items = records.filter(r => String(r.group||'') === gid);
    if (items.length <= 1) return;

    const ownerBuckets = new Map();
    items.forEach(r => {
      const key = String(r.owner || '').trim() || '__EMPTY_OWNER__';
      if (!ownerBuckets.has(key)) ownerBuckets.set(key, []);
      ownerBuckets.get(key).push(r);
    });

    if (ownerBuckets.size > 1){
      let first = true;
      ownerBuckets.forEach(bucket => {
        if (first){ first = false; return; }
        const newGid = makeUniqueGroupId('recovered');
        bucket.forEach(r => { r.group = newGid; r.group_parent = ''; });
        changed = true;
      });
      return;
    }

    const placeholders = items.filter(isAssetPayloadEmpty);
    if (placeholders.length > 1){
      placeholders.slice(1).forEach(r => {
        r.group = makeUniqueGroupId('recovered');
        r.group_parent = '';
        changed = true;
      });
    }
  });
  return changed;
}

function getGroupCustContacts(items){
  const withArr = items.find(i => Array.isArray(i.cust_contacts) && i.cust_contacts.length);
  if (withArr) return withArr.cust_contacts.slice(0,5);
  const legacy = items.map(i => ({name:i.cust_contact||'', phone:i.cust_phone||'', email:i.cust_email||''}))
    .find(c => c.name || c.phone || c.email);
  return legacy ? [legacy] : [];
}

function groupMeta(items){
  const head = items.find(r => r.owner) || items[0];
  return {
    flag: head.flag || '',
    owner: head.owner || '(법인명 미확인)',
    location: items.map(i=>i.location).find(Boolean) || '',
    country: items.map(i=>i.country).find(Boolean) || '',
    check_method: items.map(i=>i.check_method).find(Boolean) || '',
    config_mode: items.map(i=>i.config_mode).find(Boolean) || '',
    owner_primary: items.map(i=>i.owner_primary).find(Boolean) || '',
    owner_secondary: items.map(i=>i.owner_secondary).find(Boolean) || '',
    cust_contacts: getGroupCustContacts(items),
    cust_memo: items.map(i=>i.cust_memo).find(Boolean) || '',
    group_remarks: items.map(i=>i.group_remarks).find(Boolean) || '',
    group_parent: items.map(i=>i.group_parent).find(Boolean) || '',
    is_parent: items.some(i => !!i.is_parent)
  };
}

function allGroupIds(){
  return [...new Set(records.map(r=>r.group))];
}
function groupParentOf(gid){
  const parent = records.filter(r=>r.group===gid).map(i=>i.group_parent).find(Boolean) || '';
  if (parent && !records.some(r=>r.group===parent)) return '';
  return parent;
}

function groupChildrenOf(gid){
  return allGroupIds().filter(g => g!==gid && groupParentOf(g)===gid);
}

function groupDescendantIds(gid){
  const result = new Set();
  const stack = [...groupChildrenOf(gid)];
  while (stack.length){
    const cur = stack.pop();
    if (result.has(cur)) continue;
    result.add(cur);
    groupChildrenOf(cur).forEach(c => stack.push(c));
  }
  return result;
}

function groupDescendantConfigModes(gid){
  const modes = [];
  const seen = new Set();

  groupDescendantIds(gid).forEach(childGid => {
    const childItems = records.filter(r => r.group === childGid);
    if (!childItems.length) return;
    const mode = (groupMeta(childItems).config_mode || '').trim();
    if (mode && !seen.has(mode)){
      seen.add(mode);
      modes.push(mode);
    }
  });

  return modes.join(', ');
}

function groupTotalItemCount(gid){
  const ids = new Set([gid, ...groupDescendantIds(gid)]);
  return records.filter(r => ids.has(r.group) && !r.is_group_shell).length;
}

function groupFamilyIds(gid){
  const visited = new Set();
  const stack = [gid];
  while (stack.length){
    const cur = stack.pop();
    if (visited.has(cur)) continue;
    visited.add(cur);
    const parent = groupParentOf(cur);
    if (parent && !visited.has(parent)) stack.push(parent);
    groupChildrenOf(cur).forEach(c => { if (!visited.has(c)) stack.push(c); });
  }
  return visited;
}

function enforceParentsHaveNoDirectAssets(){
  let changed = false;
  allGroupIds().forEach(gid => {
    const children = groupChildrenOf(gid);
    if (!children.length) return;
    records.filter(r => r.group === gid).forEach(r => { r.is_parent = true; });
    const ownRecs = records.filter(r => r.group === gid && !r.is_group_shell);
    if (!ownRecs.length) return;
    const parentMetaSnapshot = groupMeta(records.filter(r=>r.group===gid));

    const sortedChildren = children.slice().sort((a,b) => {
      const an = groupMeta(records.filter(r=>r.group===a)).owner;
      const bn = groupMeta(records.filter(r=>r.group===b)).owner;
      return an.localeCompare(bn, 'ko');
    });
    const targetGid = sortedChildren[0];
    const targetItems = records.filter(r=>r.group===targetGid);
    if (!targetItems.length) return;
    const meta = groupMeta(targetItems);
    ownRecs.forEach(rec => {
      rec.group = targetGid;
      rec.flag = meta.flag;
      rec.owner = meta.owner;
      rec.country = meta.country;
      rec.location = meta.location;
      rec.check_method = meta.check_method;
      rec.config_mode = meta.config_mode;
      rec.owner_primary = meta.owner_primary;
      rec.owner_secondary = meta.owner_secondary;
      rec.cust_contacts = JSON.parse(JSON.stringify(meta.cust_contacts || []));
      rec.cust_memo = meta.cust_memo || '';
      rec.cust_contact = ''; rec.cust_phone = ''; rec.cust_email = '';
      rec.group_remarks = meta.group_remarks;
      rec.group_parent = meta.group_parent;
      rec.is_parent = meta.is_parent;
    });

    if (!records.some(r => r.group === gid)){
      records.push({
        id: nextRecordId(),
        group: gid,
        is_group_shell: true,
        flag: parentMetaSnapshot.flag || '',
        owner: parentMetaSnapshot.owner,
        country: parentMetaSnapshot.country,
        location: parentMetaSnapshot.location,
        check_method: parentMetaSnapshot.check_method,
        config_mode: parentMetaSnapshot.config_mode,
        owner_primary: parentMetaSnapshot.owner_primary,
        owner_secondary: parentMetaSnapshot.owner_secondary,
        cust_contacts: JSON.parse(JSON.stringify(parentMetaSnapshot.cust_contacts || [])),
        cust_memo: parentMetaSnapshot.cust_memo || '',
        cust_contact: '', cust_phone: '', cust_email: '',
        group_remarks: parentMetaSnapshot.group_remarks,
        group_parent: parentMetaSnapshot.group_parent,
        is_parent: true,
        support_id: '', sku: '', sn: '', qty: '', start: '', end: '', os_ver: '',
        work_log: []
      });
    }
    changed = true;
  });
  return changed;
}

function groupHasFamily(gid){
  return groupFamilyIds(gid).size > 1;
}

function expandGroupWithAncestors(gid){
  let cur = gid;
  const guard = new Set();
  while (cur && !guard.has(cur)){
    guard.add(cur);
    expandedGroups.add(cur);
    cur = groupParentOf(cur);
  }
}

function expandGroupWithDescendants(gid){
  expandedGroups.add(gid);
  groupDescendantIds(gid).forEach(cg => expandedGroups.add(cg));
}

function collapseGroupWithDescendants(gid){
  expandedGroups.delete(gid);
  groupDescendantIds(gid).forEach(cg => expandedGroups.delete(cg));
}

function familySupportIds(gid){
  const fam = groupFamilyIds(gid);
  const ids = new Set();
  fam.forEach(fg => {
    ownSupportIds(records.filter(r => r.group === fg)).forEach(sid => ids.add(sid));
  });
  return [...ids].sort((a,b)=>a.localeCompare(b,'ko'));
}

function ownSupportIds(items){
  const realItems = items.filter(r => !r.is_group_shell);
  const source = realItems.length ? realItems : items.filter(r => r.is_group_shell);
  const ids = new Set();
  source.forEach(r => { if ((r.support_id||'').trim()) ids.add(r.support_id.trim()); });
  return [...ids].sort((a,b)=>a.localeCompare(b,'ko'));
}

function displaySupportIds(gid, items){
  return groupHasFamily(gid) ? familySupportIds(gid) : ownSupportIds(items);
}

// ---------- Support ID 단위 하위 그룹 (같은 법인 안에서 Support ID가 여러 개인 경우) ----------
function subGroupMeta(items){
  return {
    support_id: items.map(i=>i.support_id).find(Boolean) || '',
    build_engineer: items.map(i=>i.build_engineer).find(Boolean) || '',
    build_date: items.map(i=>i.build_date).find(Boolean) || ''
  };
}
function assetOrderValue(rec){
  const n = Number(rec.asset_order);
  return Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER;
}

function sortAssetsByOrder(items){
  return items
    .map((rec, originalIndex) => ({rec, originalIndex}))
    .sort((a,b) => {
      const diff = assetOrderValue(a.rec) - assetOrderValue(b.rec);
      return diff !== 0 ? diff : a.originalIndex - b.originalIndex;
    })
    .map(x => x.rec);
}

function buildSubGroups(items){
  const realItems = items.filter(r => !r.is_group_shell);
  const sourceItems = realItems.length ? realItems : items.filter(r => r.is_group_shell);
  const map = new Map();
  for (const it of sourceItems){
    const key = (it.support_id||'').trim();
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(it);
  }
  const arr = [...map.entries()].map(([sid, its]) => {
    const sortedItems = sortAssetsByOrder(its);
    return { sid, items: sortedItems, meta: subGroupMeta(sortedItems) };
  });
  arr.sort((a,b) => {
    if (!a.sid && b.sid) return 1;
    if (a.sid && !b.sid) return -1;
    return a.sid.localeCompare(b.sid, 'ko');
  });
  return arr;
}

function secretField(rec, kind){
  const encKey = kind+'_enc';
  if (!rec[encKey]) return `<span class="sec-val empty">—</span>`;
  const id = rec.id + '_' + kind;
  const extraCls = (kind === 'ip' || kind === 'id' || kind === 'pw') ? ' sec-val-ip' : '';
  return `<span class="sec-val${extraCls}" id="disp_${id}" data-copy-id="${rec.id}" data-copy-kind="${kind}" title="클릭하여 복사">…</span>`;
}

function renderMultiValueChips(wrapEl, val){
  wrapEl.classList.remove('sec-val', 'locked', 'empty');
  wrapEl.classList.add('ip-chip-list');
  wrapEl.removeAttribute('title');
  const vals = (val||'').split(/[\n,]+/).map(s=>s.trim()).filter(Boolean);
  if (!vals.length){
    wrapEl.innerHTML = `<span class="ip-chip-empty">—</span>`;
    wrapEl.onclick = null;
    return;
  }
  wrapEl.innerHTML = vals.map(v => `<span class="ip-chip" title="클릭하여 복사">${esc(v)}</span>`).join('');
  wrapEl.querySelectorAll('.ip-chip').forEach(chip=>{
    chip.onclick = async (e) => {
      e.stopPropagation();
      try{
        await navigator.clipboard.writeText(chip.textContent);
        flashCopied(chip);
      }catch(err){
        alert('클립보드 복사에 실패했습니다. 브라우저 권한을 확인해 주세요.');
      }
    };
  });
  
  wrapEl.onclick = null;
}

function renderIpChips(wrapEl, val){ renderMultiValueChips(wrapEl, val); }

function flashCopied(el){
  const original = el.textContent;
  el.classList.add('copied');
  el.textContent = '✓ 복사됨';
  setTimeout(()=>{
    if (el.isConnected){ el.textContent = original; el.classList.remove('copied'); }
  }, 1000);
}

async function populateSecretFields(){
  const spans = Array.from(document.querySelectorAll('.sec-val[data-copy-id]'));
  for (const el of spans){
    if (viewOnly || !sessionKey){
      el.textContent = '🔒';
      el.classList.add('locked');
      el.title = '마스터 비밀번호로 잠금을 해제하면 볼 수 있습니다.';
      continue;
    }
    const id = el.dataset.copyId, kind = el.dataset.copyKind;
    const rec = records.find(r=>String(r.id)===String(id));
    if (!rec) continue;
    const val = await decryptField(rec[kind+'_enc']);
    if (kind === 'ip' || kind === 'id' || kind === 'pw'){
      renderMultiValueChips(el, val);
      continue;
    }
    el.textContent = val;
    el.dataset.plain = val;
    el.classList.remove('locked');
    el.title = '클릭하여 복사';
  }
}
function pencilSvg(){ return `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>`; }
function trashSvg(){ return `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>`; }
function clipboardSvg(){ return `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="2" width="8" height="4" rx="1"/><path d="M9 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2h-3"/><path d="M9 12h6"/><path d="M9 16h6"/></svg>`; }
function moveSvg(){ return `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m16 3 4 4-4 4"/><path d="M20 7H4"/><path d="m8 21-4-4 4-4"/><path d="M4 17h16"/></svg>`; }
function chevExpandSvg(){ return `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>`; }
function chevCollapseSvg(){ return `<svg width="15" height="15" viewBox="0 0 24 24" fill="var(--accent)" stroke="none"><circle cx="12" cy="12" r="11"/><path d="M8.5 13.5l3.5-3.5 3.5 3.5" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`; }

// ---------- 대시보드 (OS 버전별 / 태그별 / 위치별 / 국가별 / SKU별 현황 한눈에 보기) ----------
let dashboardMode = false;
let maintenanceMode = false;

function bucketGroups(arr, keyFn){
  const map = new Map();
  arr.forEach(item => {
    const raw = keyFn(item);
    const k = (raw && String(raw).trim()) ? String(raw).trim() : '미상';
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(item);
  });
  return [...map.entries()]
    .map(([label, items]) => [label, items.length, items])
    .sort((a,b) => b[1]-a[1]);
}

function countryOf(r){
  const c = (r.country||'').trim();
  if (c) return c;
  const s = (r.location||'').trim();
  if (!s) return '';
  return s.split(/\s+/)[0];
}

function osVersionTag(osVer){
  const s = (osVer||'').trim();
  if (!s) return null;
  const m = s.match(/\d+(?:\.\d+){0,3}/);
  return m ? m[0] : null;
}

const DASH_VISIBLE_ROWS = 16;

function dashboardCompanyListHtml(items){
  const ownerMap = new Map();

  items.forEach(r => {
    const owner = (r.owner || '').trim();
    if (!owner) return;

    if (!ownerMap.has(owner)){
      ownerMap.set(owner, {
        owner,
        count: 0,
        gid: r.group
      });
    }

    ownerMap.get(owner).count++;
  });

  const owners = [...ownerMap.values()]
    .sort((a, b) => a.owner.localeCompare(b.owner, 'ko'));

  if (!owners.length){
    return `<div class="dash-empty">법인 정보가 없습니다.</div>`;
  }

  return `
    <ul class="dash-company-list">
      ${owners.map(({owner, count, gid}) => `
        <li class="dash-company-jump"
            data-dash-company="${esc(owner)}"
            data-dash-gid="${esc(gid)}"
            title="${esc(owner)} 자산 페이지로 이동">
          <span class="dash-company-name">${esc(owner)}</span>
          <span class="dash-company-count">${count}건</span>
        </li>
      `).join('')}
    </ul>`;
}

function dashboardSectionHtml(sectionKey, title, colorClass, data, clickable){
  const max = data.length ? data[0][1] : 1;
  const rowsHtml = data.map(([label, count, items], idx) => {
    const detailId = `dashDetail_${sectionKey}_${idx}`;
    const row = `
    <div class="dash-row${clickable?' dash-row-clickable':''}"${clickable?` data-dash-toggle="${detailId}"`:''}>
      <span class="dash-row-label" title="${esc(label)}">${esc(label)}</span>
      <div class="dash-bar-track"><div class="dash-bar-fill ${colorClass}" style="width:${Math.max(5, Math.round(count/max*100))}%"></div></div>
      <span class="dash-row-count">${count}</span>
      ${clickable?'<span class="dash-row-caret">▾</span>':''}
    </div>`;
    const detail = clickable ? `<div class="dash-row-detail" id="${detailId}" style="display:none;">${dashboardCompanyListHtml(items)}</div>` : '';
    return row + detail;
  });

  const top = rowsHtml.slice(0, DASH_VISIBLE_ROWS).join('');
  const rest = rowsHtml.slice(DASH_VISIBLE_ROWS);
  let restHtml = '', moreBtnHtml = '';
  if (rest.length){
    const restId = `dashRest_${sectionKey}`;
    restHtml = `<div class="dash-more-rows" id="${restId}" style="display:none;">${rest.join('')}</div>`;
    moreBtnHtml = `<button type="button" class="dash-more-btn" data-dash-more-toggle="${restId}" data-more-label="외 ${rest.length}개 더보기" data-less-label="접기">외 ${rest.length}개 더보기</button>`;
  }
  return `
    <div class="dash-card">
      <h4>${esc(title)}</h4>
      ${top || '<div class="dash-empty">데이터가 없습니다.</div>'}
      ${restHtml}
      ${moreBtnHtml}
    </div>`;
}

function bucketByTags(arr){
  const map = new Map();
  arr.forEach(item => {
    const tags = skuKeywordMatches(item.sku);
    const keys = tags.length ? tags : ['태그 없음'];
    keys.forEach(k => {
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(item);
    });
  });
  return [...map.entries()]
    .map(([label, items]) => [label, items.length, items])
    .sort((a,b) => b[1]-a[1]);
}

function renderDashboard(){
  const wrap = document.getElementById('dashboardView');
  if (!wrap) return;
  const assetRecords = records.filter(r=>!r.is_group_shell);
  const total = assetRecords.length;
  const groupCount = new Set(records.map(r=>r.group)).size;
  const validOsRecords = assetRecords.filter(r => osVersionTag(r.os_ver));
  const osTagGroups = SKU_TAG_KEYS
    .map(tag => ({ tag, items: validOsRecords.filter(r => skuKeywordMatches(r.sku).includes(tag)) }))
    .filter(g => g.items.length > 0)
    .sort((a,b) => b.items.length - a.items.length);
  const osNoTagItems = validOsRecords.filter(r => skuKeywordMatches(r.sku).length === 0);

  const osTagCardsHtml = osTagGroups.map(g =>
    dashboardSectionHtml(`os_${g.tag}`, `${g.tag} 태그 · 버전별`, 'dash-c1', bucketGroups(g.items, r => osVersionTag(r.os_ver)), true)
  ).join('');
  const osNoTagCardHtml = osNoTagItems.length
    ? dashboardSectionHtml('os_none', '태그 없음 · 버전별', 'dash-c1', bucketGroups(osNoTagItems, r => osVersionTag(r.os_ver)), true)
    : '';

  const byTag = bucketByTags(assetRecords)
    .filter(([label]) => label !== 'SSP');  
  const bySku = bucketGroups(assetRecords, r => {
    const sku = (r.sku || '').trim();
    const s = sku.toUpperCase();
  
    if (s.startsWith('ISG-PROXY'))    return 'ISG-Proxy';
    if (s.startsWith('SSP-S210-10'))  return 'SSP-S210-10';
    if (s.startsWith('SSP-S410-20B')) return 'SSP-S410-20B';
    if (s.startsWith('SSP-S410-40B')) return 'SSP-S410-40B';
    if (s.startsWith('SSP-S410-10-')) return 'SSP-S410-10';
    if (s.startsWith('SSP-S410-20-')) return 'SSP-S410-20';
    if (s.startsWith('SSP-S410-40-')) return 'SSP-S410-40';
    if (s.startsWith('ASG-S400'))     return 'ASG-S400';
    if (s.startsWith('SG-S200'))      return 'SG-S200';
    if (s.startsWith('SG-S400'))      return 'SG-S400';
    if (s.startsWith('SG-S500'))      return 'SG-S500';
    if (s.startsWith('MC-S400'))      return 'MC-S400';
    if (s.startsWith('RP-S500'))      return 'RP-S500';
    if (s.startsWith('MC-V'))         return 'MC-VA';
    if (s.startsWith('RP-V'))         return 'RP-VA';
    if (s.startsWith('ISG-CA'))       return 'ISG-CA';
    if (s.startsWith('ISG-MA'))       return 'ISG-MA';
    if (s.startsWith('PAC'))          return 'PAC';
    if (s.startsWith('BCWF'))         return 'BCWF';
    if (s.includes('-BCWF-'))         return 'BCWF';
    if (s.startsWith('IS-'))          return 'BCIS';
  
    return sku;
  });

  wrap.innerHTML = `
    <div class="dash-header">
      <h2>자산 현황 대시보드</h2>
      <p class="dash-sub">전체 자산 ${total}건 · ${groupCount}개 법인 기준</p>
    </div>

    <div class="dash-section-title">OS 버전별 (장비 태그별 · 버전 정보 있는 항목만) · 클릭하면 사용 법인 표시</div>
    <div class="dash-grid dash-grid-os">
      ${osTagCardsHtml || '<div class="dash-empty">태그가 붙은 장비 중 버전 정보가 있는 항목이 없습니다.</div>'}
      ${osNoTagCardHtml}
    </div>

    <div class="dash-grid" style="margin-top:16px;">
      ${dashboardSectionHtml(
        'tag',
        '태그별 · 클릭하면 사용 법인 표시',
        'dash-c2',
        byTag,
        true
      )}
    
      ${dashboardCountryLocationSectionHtml(assetRecords)}
    
      ${dashboardSectionHtml(
        'sku',
        'SKU별 · 클릭하면 사용 법인 표시',
        'dash-c5',
        bySku,
        true
      )}
    </div>
  `;
}

let currentViewMode = 'list'; // 'list' | 'dashboard' | 'maintenance' | 'history'
function setViewMode(mode){
  currentViewMode = mode;
  dashboardMode = (mode === 'dashboard');
  maintenanceMode = (mode === 'maintenance');
  const contentEl = document.getElementById('content');
  const dashEl = document.getElementById('dashboardView');
  const maintEl = document.getElementById('maintenanceView');
  const histEl = document.getElementById('workHistoryView');
  const dashBtn = document.getElementById('dashboardToggle');
  const maintBtn = document.getElementById('maintenanceToggle');
  const histBtn = document.getElementById('workHistoryToggle');
  if (contentEl) contentEl.style.display = (mode === 'list') ? '' : 'none';
  if (dashEl) dashEl.style.display = (mode === 'dashboard') ? '' : 'none';
  if (maintEl) maintEl.style.display = (mode === 'maintenance') ? '' : 'none';
  if (histEl) histEl.style.display = (mode === 'history') ? '' : 'none';
  if (dashBtn){
    dashBtn.classList.toggle('on', mode === 'dashboard');
    dashBtn.title = mode === 'dashboard' ? '대시보드 닫기 (다시 클릭)' : '대시보드 보기';
  }
  if (maintBtn){
    maintBtn.classList.toggle('on', mode === 'maintenance');
    maintBtn.title = mode === 'maintenance' ? '유지보수 점검 관리 닫기 (다시 클릭)' : '유지보수 점검 관리';
  }
  if (histBtn){
    histBtn.classList.toggle('on', mode === 'history');
    histBtn.title = mode === 'history' ? '작업 이력 전체보기 닫기 (다시 클릭)' : '작업 이력 전체보기';
  }
  if (mode === 'dashboard') renderDashboard();
  if (mode === 'maintenance') renderMaintenance();
  if (mode === 'history') renderWorkHistoryPage();
}

function setDashboardMode(on){ setViewMode(on ? 'dashboard' : 'list'); }

document.getElementById('dashboardToggle').onclick = () => setViewMode(dashboardMode ? 'list' : 'dashboard');
document.getElementById('maintenanceToggle').onclick = () => setViewMode(maintenanceMode ? 'list' : 'maintenance');
document.getElementById('workHistoryToggle').onclick = () => setViewMode(currentViewMode === 'history' ? 'list' : 'history');
document.getElementById('dashboardView').addEventListener('click', (e) => {
  const companyJump = e.target.closest('[data-dash-company]');
  if (companyJump){
    e.stopPropagation();

    const owner = companyJump.dataset.dashCompany;
    const gid = companyJump.dataset.dashGid;

    // 다른 필터 때문에 대상 법인이 안 보이는 문제 방지
    activeStatusFilters = new Set(['ok', 'warn', 'crit', 'na']);
    activeSkuKeywordFilters = new Set();
    activeMyAssetsFilter = false;

    Object.keys(topFieldFilters).forEach(k => {
      topFieldFilters[k] = '';
    });

    const searchInput = document.getElementById('searchInput');
    if (searchInput) searchInput.value = '';

    // 해당 법인만 표시
    activeCountryFilter = owner;

    // 해당 법인을 펼친 상태로 전환
    expandGroupWithAncestors(gid);

    // 자산 목록 화면으로 이동
    setViewMode('list');
    render();

    // 해당 법인 위치로 자동 스크롤 + 강조
    requestAnimationFrame(() => {
      const target = document.querySelector(
        `.group-card[data-gid="${CSS.escape(gid)}"]`
      );

      if (target){
        target.scrollIntoView({
          behavior: 'smooth',
          block: 'center'
        });

        target.classList.add('activity-highlight-flash');

        setTimeout(() => {
          target.classList.remove('activity-highlight-flash');
        }, 1800);
      }
    });

    return;
  }

  const hierarchyToggle = e.target.closest(
    '[data-dash-hierarchy-toggle]'
  );
  
  if (hierarchyToggle){
    const target = document.getElementById(
      hierarchyToggle.dataset.dashHierarchyToggle
    );
  
    if (target){
      const opening = target.style.display === 'none';
  
      target.style.display = opening ? 'block' : 'none';
      hierarchyToggle.classList.toggle('open', opening);
    }
  
    return;
  }

  const toggleRow = e.target.closest('[data-dash-toggle]');
  if (toggleRow){
    const detail = document.getElementById(toggleRow.dataset.dashToggle);
    if (detail){
      const opening = detail.style.display === 'none';
      detail.style.display = opening ? 'block' : 'none';
      toggleRow.classList.toggle('open', opening);
    }
    return;
  }
  const moreBtn = e.target.closest('[data-dash-more-toggle]');
  if (moreBtn){
    const restEl = document.getElementById(moreBtn.dataset.dashMoreToggle);
    if (restEl){
      const opening = restEl.style.display === 'none';
      restEl.style.display = opening ? 'block' : 'none';
      moreBtn.textContent = opening ? moreBtn.dataset.lessLabel : moreBtn.dataset.moreLabel;
    }
  }
});

// ---------- 유지보수(법인별 월간 점검) 페이지 ----------
let maintenanceTab = 'entry';
let maintenanceYear = null;
let maintenanceEditTarget = null;

function pad2(n){ return String(n).padStart(2, '0'); }
function currentYm(){
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth()+1)}`;
}
function ymLabel(ym){
  if (!ym) return '';
  const [y, m] = ym.split('-');
  return `${y}년 ${Number(m)}월`;
}

function monthsFrom202601To(ym){
  const target = ym && /^\d{4}-\d{2}$/.test(ym) ? ym : currentYm();
  const [ey, em] = target.split('-').map(Number);
  const out = [];
  let y = 2026, m = 1;
  if (ey < 2026){ return ['2026-01']; }
  while (y < ey || (y === ey && m <= em)){
    out.push(`${y}-${pad2(m)}`);
    m++;
    if (m > 12){ m = 1; y++; }
  }
  return out;
}

function maintenanceGroupList(){
  return allGroupIds()
    .map(gid => {
      const items = records.filter(r => r.group === gid);
      const meta = groupMeta(items);
      const realItems = items.filter(r => !r.is_group_shell);
      return { gid, meta, realItems };
    })
    .filter(g => !g.meta.group_parent && (g.meta.is_parent || g.realItems.length > 0))
    .sort((a, b) => a.meta.owner.localeCompare(b.meta.owner, 'ko'));
}
function maintenanceLogFor(gid, ym){
  return maintenanceLogs.find(m => m.group === gid && m.ym === ym) || null;
}
function maintenanceLogsForGroup(gid){
  return maintenanceLogs.filter(m => m.group === gid);
}

function maintenanceVisibleGroupList(){
  const groups = maintenanceGroupList();
  if (!activeMyAssetsFilter) return groups;
  const me = currentUserName();
  if (!me) return groups;
  return groups.filter(g => g.meta.owner_primary === me);
}

function setMaintenanceTab(tab){
  maintenanceTab = tab;
  renderMaintenance();
}

function maintenanceOwnerColors(name){
  name = String(name || '').trim();
  if (!name){
    return { fg:'#7A8494', bg:'#F2F4F7', border:'#D9DEE6', accent:'#AAB2BE' };
  }
  let hash = 0;
  for (let i = 0; i < name.length; i++){
    hash = (name.charCodeAt(i) + ((hash << 5) - hash)) | 0;
  }
  const hue = ((hash % 360) + 360) % 360;
  return {
    fg:`hsl(${hue} 48% 34%)`,
    bg:`hsl(${hue} 72% 94%)`,
    border:`hsl(${hue} 48% 78%)`,
    accent:`hsl(${hue} 55% 53%)`
  };
}

const MAINT_MONTHS = [1,2,3,4,5,6,7,8,9,10,11,12];

function maintenanceEntryTabHtml(){
  if (!maintenanceYear) maintenanceYear = Math.max(2026, currentYm().split('-').map(Number)[0]);
  const groups = maintenanceVisibleGroupList();
  const thisYm = currentYm();

  const bodyRows = groups.map(g => {
    let ddayHtml = `<span class="maint-dday na">-</span>`;
    let soonest = null;
    const familyGids = new Set([g.gid, ...groupDescendantIds(g.gid)]);
    records.filter(r => familyGids.has(r.group) && !r.is_group_shell).forEach(r => {
      const d = daysUntilEnd(r);
      if (d === null) return;
      if (soonest === null || d < soonest) soonest = d;
    });
    if (soonest !== null){
      const cls = soonest < 0 ? 'crit' : (soonest <= 90 ? 'warn' : 'ok');
      const label = soonest > 0 ? `D-${soonest}` : (soonest === 0 ? 'D-day' : `D+${Math.abs(soonest)}`);
      ddayHtml = `<span class="maint-dday ${cls}">${label}</span>`;
    }

    const ownerColors = maintenanceOwnerColors(g.meta.owner_primary);
    const engineerHtml = g.meta.owner_primary
      ? `<span class="maint-owner-badge" style="--owner-fg:${ownerColors.fg};--owner-bg:${ownerColors.bg};--owner-border:${ownerColors.border};">${esc(g.meta.owner_primary)}</span>`
      : '<span class="maint-td-empty">-</span>';

    const monthCellsHtml = MAINT_MONTHS.map(m => {
      const ym = `${maintenanceYear}-${pad2(m)}`;
      const log = maintenanceLogFor(g.gid, ym);
      const isCurrent = ym === thisYm;
      const isUncontracted = !!(log && log.uncontracted);
      if (isUncontracted){
        return `
          <td class="maint-cell maint-cell-uncontracted ${isCurrent?'is-current':''}"
              data-maint-cell="${esc(g.gid)}|${ym}"
              title="${esc(ymLabel(ym))} · 미계약">
      
            <span class="maint-cell-uncontracted-label">
              미계약
            </span>
      
          </td>
        `;
      }
      const hasDate = log && (log.date || '').trim();
      const isIncomplete = !!(log && log.incomplete);
      if (isIncomplete){
        const tipBits = [
          `${ymLabel(ym)} 미완료`
        ];
        if (log.manager){
          tipBits.push(`담당 ${log.manager}`);
        }
        if (log.note){
          tipBits.push(log.note);
        }
        const noteHtml = log.note
        ? `<div class="maint-cell-note maint-cell-note-incomplete"
                title="${esc(log.note)}">
             ${esc(log.note)}
           </div>`
        : '';
      
      return `
        <td class="maint-cell maint-cell-incomplete ${isCurrent ? 'is-current' : ''}"
            data-maint-cell="${esc(g.gid)}|${ym}"
            title="${esc(tipBits.join(' · '))}">
      
          <div class="maint-cell-main">
            <span class="maint-cell-incomplete-label">미완료</span>
          </div>
      
          ${noteHtml}
        </td>
      `;
      }
      if (hasDate){
        const d = parseDate(log.date);
        const dayNum = d ? d.getDate() : '';
        const isDone = !!log.done;
        const tipBits = [`${ymLabel(ym)} 점검일 ${log.date}`, isDone ? '완료' : '예약'];
        if (log.manager) tipBits.push(`담당 ${log.manager}`);
        if (log.note) tipBits.push(log.note);
        const statusCls = isDone ? 'maint-cell-done' : 'maint-cell-reserved';
        const statusTag = isDone ? '완' : '예';
        const noteHtml = log.note
          ? `<div class="maint-cell-note" title="${esc(log.note)}">${esc(log.note)}</div>`
          : '';
        
        return `
          <td class="maint-cell ${statusCls} ${isCurrent?'is-current':''}"
              data-maint-cell="${esc(g.gid)}|${ym}"
              title="${esc(tipBits.join(' · '))}">
        
            <div class="maint-cell-main">
              <span class="maint-cell-day">${esc(String(dayNum))}</span>
              <span class="maint-cell-tag">${statusTag}</span>
            </div>
        
            ${noteHtml}
          </td>
        `;
      }
      return `<td class="maint-cell maint-cell-blank ${isCurrent?'is-current':''}" data-maint-cell="${esc(g.gid)}|${ym}" title="${esc(ymLabel(ym))} 점검 등록">
        <span class="maint-cell-dash">–</span>
      </td>`;
    }).join('');

    return `
      <tr class="maint-owner-row" style="--maint-owner-color:${ownerColors.accent};">
        <td class="maint-cell-owner" data-label="사업장">
          <span class="maint-row-owner">${esc(g.meta.owner)}</span>${g.meta.location ? `<span class="maint-row-location"> · ${esc(g.meta.location)}</span>` : ''}
        </td>
        <td data-label="계약만료 D-Day">${ddayHtml}</td>
        <td data-label="담당">${engineerHtml}</td>
        ${monthCellsHtml}
      </tr>`;
  }).join('');

  return `
    <div class="maint-toolbar">
      <div class="maint-year-field">
        <label>연도</label>
        <div class="maint-year-control">
          <button type="button" class="maint-ym-nav-btn" id="maintYearPrevBtn" title="이전 연도" ${maintenanceYear<=2026?'disabled':''}>‹</button>
          <span class="maint-year-value">${maintenanceYear}년</span>
          <button type="button" class="maint-ym-nav-btn" id="maintYearNextBtn" title="다음 연도">›</button>
        </div>
      </div>
      <p class="maint-year-hint">각 달 칸을 클릭하면 점검일 · 점검 담당자 · 비고를 등록/수정할 수 있습니다. (완료 체크 안 하면 예약, 체크하면 완료로 표시)</p>
    </div>
    <div class="maint-table-caption">점검일자 (${maintenanceYear})</div>
    <div class="maint-table-wrap maint-year-table-wrap">
      <table class="maint-table maint-year-table">
        <thead>
          <tr>
            <th class="maint-th-owner">사업장</th>
            <th class="maint-th-dday">계약만료 D-Day</th>
            <th>담당</th>
            ${MAINT_MONTHS.map(m => `<th class="maint-th-month">${m}월</th>`).join('')}
          </tr>
        </thead>
        <tbody>${bodyRows || `<tr><td colspan="15"><div class="maint-empty">등록된 법인이 없습니다. 먼저 좌측 ＋ 버튼으로 법인을 등록해 주세요.</div></td></tr>`}</tbody>
      </table>
    </div>`;
}

function maintenanceAvgDayBuckets(groups){
  const buckets = Array.from({length:31}, () => []);
  groups.forEach(g => {
    const days = maintenanceLogsForGroup(g.gid)
      .map(l => parseDate(l.date))
      .filter(Boolean)
      .map(d => d.getDate());
    if (!days.length) return;
    const avg = days.reduce((a,b)=>a+b, 0) / days.length;
    const day = Math.min(31, Math.max(1, Math.round(avg)));
    buckets[day-1].push({ owner: g.meta.owner, avg });
  });
  return buckets;
}

function maintenanceDayChartHtml(groups){
  const buckets = maintenanceAvgDayBuckets(groups);
  const maxCount = Math.max(1, ...buckets.map(b => b.length));
  const cols = buckets.map((entries, idx) => {
    const day = idx + 1;
    const hasData = entries.length > 0;
    const heightPct = hasData ? Math.max(8, Math.round((entries.length / maxCount) * 100)) : 2;
    const sortedEntries = entries.slice().sort((a,b)=>a.avg-b.avg);
    const names = sortedEntries.map(e => `${e.owner} · 평균 ${e.avg.toFixed(1)}일`).join('\n');
    const tip = hasData ? `${day}일 (${entries.length}개 법인)\n${names}` : `${day}일 · 데이터 없음`;
    const edgeCls = day <= 5 ? ' tip-start' : (day >= 27 ? ' tip-end' : '');
    return `
      <div class="maint-day-col${edgeCls}" data-tip="${esc(tip)}">
        <div class="maint-day-bar ${hasData?'':'empty'}" style="height:${heightPct}%;">${hasData?`<span class="maint-day-count">${entries.length}</span>`:''}</div>
        <div class="maint-day-daylabel ${day%5===0||day===1?'strong':''}">${day}</div>
      </div>`;
  }).join('');
  return `<div class="maint-day-chart">${cols}</div>`;
}

function maintenanceUserSummaryData(){
  const groups = maintenanceGroupList();
  const users = new Map();
  const ensure = (name) => {
    if (!users.has(name)) users.set(name, { methods: new Map(), primaryGroups: [], secondaryGroups: [] });
    return users.get(name);
  };
  groups.forEach(g => {
    const method = (g.meta.check_method || '').trim() || '미지정';
    const primary = (g.meta.owner_primary || '').trim();
    const secondary = (g.meta.owner_secondary || '').trim();
    if (primary){
      const u = ensure(primary);
      const m = u.methods.get(method) || { primary: 0, secondary: 0 };
      m.primary += 1;
      u.methods.set(method, m);
      u.primaryGroups.push({
        gid: g.gid,
        owner: g.meta.owner,
        method: g.meta.check_method || '미지정'
      });
    }
    if (secondary){
      const u = ensure(secondary);
      const m = u.methods.get(method) || { primary: 0, secondary: 0 };
      m.secondary += 1;
      u.methods.set(method, m);
      u.secondaryGroups.push({
        gid: g.gid,
        owner: g.meta.owner,
        method: g.meta.check_method || '미지정'
      });
    }
  });
  return users;
}

function maintenanceUserSummaryHtml(){
  const users = maintenanceUserSummaryData();
  if (!users.size) return '<div class="dash-empty">담당자가 지정된 법인이 없습니다.</div>';

  const rows = [...users.entries()].map(([name, u]) => {
    const totalPrimary = u.primaryGroups.length;
    const totalSecondary = u.secondaryGroups.length;
    return { name, u, total: totalPrimary + totalSecondary, totalPrimary, totalSecondary };
  }).sort((a, b) => b.total - a.total || a.name.localeCompare(b.name, 'ko'));

  const cardsHtml = rows.map(({ name, u, totalPrimary, totalSecondary }) => {
    const methodChips = [...u.methods.entries()]
      .sort((a, b) => a[0].localeCompare(b[0], 'ko'))
      .map(([method, cnt]) => {
        const bits = [];
        if (cnt.primary) bits.push(`정 ${cnt.primary}`);
        if (cnt.secondary) bits.push(`부 ${cnt.secondary}`);
        return `<span class="maint-method-chip">${esc(method)} · ${bits.join(' / ')}</span>`;
      }).join('');

    const primaryChips = u.primaryGroups.length
      ? u.primaryGroups
          .slice()
          .sort((a, b) => a.owner.localeCompare(b.owner, 'ko'))
          .map(g => `
            <div class="maint-site-listitem primary maint-site-clickable"
                 data-maint-site-gid="${esc(g.gid)}"
                 title="${esc(g.owner)} 자산 목록으로 이동">
    
              <span class="maint-site-name">${esc(g.owner)}</span>
    
              <span class="maint-site-method"
                    data-method="${esc(g.method)}">
                ${esc(g.method)}
              </span>
            </div>
          `).join('')
      : `<span class="maint-td-empty">-</span>`;
    const secondaryChips = u.secondaryGroups.length
      ? u.secondaryGroups
          .slice()
          .sort((a, b) => a.owner.localeCompare(b.owner, 'ko'))
          .map(g => `
            <div class="maint-site-listitem secondary maint-site-clickable"
                 data-maint-site-gid="${esc(g.gid)}"
                 title="${esc(g.owner)} 자산 목록으로 이동">
    
              <span class="maint-site-name">${esc(g.owner)}</span>
    
              <span class="maint-site-method"
                    data-method="${esc(g.method)}">
                ${esc(g.method)}
              </span>
            </div>
          `).join('')
      : `<span class="maint-td-empty">-</span>`;

    return `
      <div class="maint-user-card">
        <div class="maint-user-card-head">
          <span class="maint-user-name">${esc(name)}</span>
          <span class="maint-user-total">정 ${totalPrimary} · 부 ${totalSecondary}</span>
        </div>
        <div class="maint-method-chips">${methodChips}</div>
        <div class="maint-user-site-group">
          <div class="maint-user-site-label">정 담당 법인</div>
          <div class="maint-site-list">${primaryChips}</div>
        </div>
        <div class="maint-user-site-group">
          <div class="maint-user-site-label">부 담당 법인</div>
          <div class="maint-site-list">${secondaryChips}</div>
        </div>
      </div>`;
  }).join('');

  return `<div class="maint-user-summary-list">${cardsHtml}</div>`;
}

function jumpToAssetGroup(gid){
  if (!gid) return;

  // 다른 필터 때문에 대상 법인이 사라지지 않도록 초기화
  activeStatusFilters = new Set(['ok', 'warn', 'crit', 'na']);
  activeSkuKeywordFilters = new Set();
  activeMyAssetsFilter = false;
  activeCountryFilter = null;

  Object.keys(topFieldFilters).forEach(k => {
    topFieldFilters[k] = '';
  });

  const searchInput = document.getElementById('searchInput');
  if (searchInput){
    searchInput.value = '';
  }

  // 대상 법인 + 상위 법인까지 펼치기
  expandGroupWithAncestors(gid);

  // 자산 목록 화면으로 전환
  setViewMode('list');

  render();

  // 해당 법인 위치로 이동
  requestAnimationFrame(() => {
    const target = document.querySelector(
      `.group-card[data-gid="${CSS.escape(gid)}"]`
    );

    if (!target) return;

    target.scrollIntoView({
      behavior: 'smooth',
      block: 'center'
    });

    target.classList.add('activity-highlight-flash');

    setTimeout(() => {
      target.classList.remove('activity-highlight-flash');
    }, 1800);
  });
}

function maintenanceStatsTabHtml(){
  const groups = maintenanceVisibleGroupList();
  const months = monthsFrom202601To(currentYm());

  const trendRows = months.slice().reverse().map(ym => {
    const doneCount = groups.filter(g => {
      const log = maintenanceLogFor(g.gid, ym);
      return log && (log.date||'').trim();
    }).length;
    const pct = groups.length ? Math.round(doneCount/groups.length*100) : 0;
    const fillCls = pct >= 80 ? '' : (pct >= 50 ? 'mid' : 'low');
    return `
      <div class="maint-trend-row">
        <span class="maint-trend-label">${esc(ymLabel(ym))}</span>
        <div class="maint-trend-track"><div class="maint-trend-fill ${fillCls}" style="width:${Math.max(3,pct)}%"></div></div>
        <span class="maint-trend-pct">${doneCount}/${groups.length} (${pct}%)</span>
      </div>`;
  }).join('');

  return `
    <div class="maint-trend-row-2col">
      <div class="maint-trend-card">
        <h4>월별 점검 완료율 (2026.01 ~ ${esc(ymLabel(currentYm()))})</h4>
        ${trendRows || '<div class="dash-empty">데이터가 없습니다.</div>'}
      </div>
      <div class="maint-trend-card">
        <h4>법인별 평균 점검일 분포</h4>
        <p class="maint-day-hint">법인마다 평균 점검일을 배치한 막대그래프입니다. 막대에 마우스를 올리면 어떤 법인이 해당하는지 볼 수 있습니다.</p>
        ${groups.length ? maintenanceDayChartHtml(groups) : '<div class="dash-empty">데이터가 없습니다.</div>'}
      </div>
    </div>
    <div class="maint-trend-card">
      <h4>담당자별 사이트 요약</h4>
      <p class="maint-day-hint">담당자별로 정/부 담당 중인 법인 수를 점검 방식별로 모아 보여줍니다. 개인 필터(My)와 무관하게 전체 담당자 기준입니다.</p>
      ${maintenanceUserSummaryHtml()}
    </div>`;
}

function renderMaintenance(){
  const wrap = document.getElementById('maintenanceView');
  if (!wrap) return;
  if (!maintenanceYear) maintenanceYear = Math.max(2026, Number(currentYm().split('-')[0]));
  wrap.innerHTML = `
    <div class="maint-sticky-top">
      <div class="maint-header">
        <div class="maint-header-row">
          <h2>유지보수 점검 관리</h2>
        
          <div class="maint-header-actions">
        
            <a class="maint-license-notice-btn"
               href="https://etech-sym.notion.site/license-expiry"
               target="_blank"
               rel="noopener noreferrer"
               title="라이선스 만료 2달 전 공지글 새 탭에서 열기">
              <span class="maint-license-notice-icon">🔔</span>
              <span>라이선스 만료 2달 전 공지글</span>
            </a>
        
          </div>
        </div>
        <p class="maint-sub">등록된 법인들의 월별 점검 이력을 관리합니다 · 2026년 1월부터</p>
      </div>
      <div class="maint-tabs">
        <button type="button" class="maint-tab-btn ${maintenanceTab==='entry'?'active':''}" data-maint-tab="entry">점검지</button>
        <button type="button" class="maint-tab-btn ${maintenanceTab==='stats'?'active':''}" data-maint-tab="stats">통계</button>
      </div>
    </div>
    <div id="maintTabBody">${maintenanceTab==='entry' ? maintenanceEntryTabHtml() : maintenanceStatsTabHtml()}</div>
  `;

  wrap.querySelectorAll('[data-maint-tab]').forEach(btn => {
    btn.onclick = () => setMaintenanceTab(btn.dataset.maintTab);
  });

  const yearPrevBtn = document.getElementById('maintYearPrevBtn');
  if (yearPrevBtn){
    yearPrevBtn.onclick = () => {
      if (maintenanceYear <= 2026) return;
      maintenanceYear -= 1;
      renderMaintenance();
    };
  }
  const yearNextBtn = document.getElementById('maintYearNextBtn');
  if (yearNextBtn){
    yearNextBtn.onclick = () => {
      maintenanceYear += 1;
      renderMaintenance();
    };
  }

  wrap.querySelectorAll('[data-maint-cell]').forEach(cell => {
    cell.onclick = () => {
      const [gid, ym] = cell.dataset.maintCell.split('|');
      openMaintenanceLogModal(gid, ym);
    };
  });

  wrap.querySelectorAll('[data-maint-site-gid]').forEach(site => {
    site.onclick = () => {
      jumpToAssetGroup(site.dataset.maintSiteGid);
    };
  });

  syncMaintTheadOffset();
  requestAnimationFrame(syncMaintTheadOffset);
}

function openMaintenanceLogModal(gid, ym){
  const groups = maintenanceGroupList();
  const g = groups.find(x => x.gid === gid);
  if (!g) return;
  maintenanceEditTarget = { gid, ym };
  const log = maintenanceLogFor(gid, ym);
  document.getElementById('mlModalTitle').textContent = `${g.meta.owner} · ${ymLabel(ym)} 점검 등록`;
  document.getElementById('ml_date').value =
    log && !log.incomplete
      ? (log.date || todayDots())
      : (log ? '' : todayDots());
  
  document.getElementById('ml_manager').value =
    log
      ? (log.manager || '')
      : (currentUserName() || g.meta.owner_primary || '');
  
  document.getElementById('ml_done').checked =
    log ? !!log.done : false;
  
  document.getElementById('ml_incomplete').checked =
    log ? !!log.incomplete : false;
  
  document.getElementById('ml_uncontracted').checked =
    log ? !!log.uncontracted : false;
  
  document.getElementById('ml_note').value =
    log ? (log.note || '') : '';
  
  syncMaintenanceStatusControls();
  document.getElementById('mlError').textContent = '';
  document.getElementById('mlDeleteBtn').style.display = log ? '' : 'none';
  document.getElementById('maintenanceLogModal').classList.add('open');
}

function closeMaintenanceLogModal(){
  document.getElementById('maintenanceLogModal').classList.remove('open');
  maintenanceEditTarget = null;
}

function syncMaintenanceStatusControls(){
  const doneEl = document.getElementById('ml_done');
  const incompleteEl = document.getElementById('ml_incomplete');
  const uncontractedEl = document.getElementById('ml_uncontracted');

  const dateEl = document.getElementById('ml_date');
  const datePicker = document.getElementById('ml_date_picker');
  const dateBtn = document.getElementById('ml_date_pick_btn');

  const noteEl = document.getElementById('ml_note');

  const dateRow = document.getElementById('mlDateRow');
  const requiredHint = document.getElementById('mlNoteRequired');

  if (!doneEl || !incompleteEl || !uncontractedEl) return;

  const incomplete = incompleteEl.checked;
  const uncontracted = uncontractedEl.checked;

  /* 미완료 또는 미계약이면 날짜 비활성화 */
  const disableDate = incomplete || uncontracted;

  dateEl.disabled = disableDate;
  datePicker.disabled = disableDate;
  dateBtn.disabled = disableDate;

  /* 미계약은 비고/내용까지 비활성화 */
  noteEl.disabled = uncontracted;

  if (dateRow){
    dateRow.classList.toggle('is-incomplete', incomplete);
    dateRow.classList.toggle('is-uncontracted', uncontracted);
  }

  /* 미완료일 때만 비고 필수 */
  if (requiredHint){
    requiredHint.style.display = incomplete ? 'inline' : 'none';
  }

  if (uncontracted){
    /* 미계약은 날짜와 내용 자체를 비움 */
    dateEl.value = '';
    datePicker.value = '';
    noteEl.value = '';
  }
  else if (incomplete){
    /* 미완료는 날짜만 비움, 비고는 입력 가능 */
    dateEl.value = '';
    datePicker.value = '';
  }
  else if (!dateEl.value.trim()){
    dateEl.value = todayDots();
  }
}

document.getElementById('ml_done').addEventListener('change', () => {
  const doneEl = document.getElementById('ml_done');

  if (doneEl.checked){
    document.getElementById('ml_incomplete').checked = false;
    document.getElementById('ml_uncontracted').checked = false;
  }

  syncMaintenanceStatusControls();
});

document.getElementById('ml_incomplete').addEventListener('change', () => {
  const incompleteEl = document.getElementById('ml_incomplete');

  if (incompleteEl.checked){
    document.getElementById('ml_done').checked = false;
    document.getElementById('ml_uncontracted').checked = false;
  }

  syncMaintenanceStatusControls();
});

document.getElementById('ml_uncontracted').addEventListener('change', () => {
  const uncontractedEl = document.getElementById('ml_uncontracted');

  if (uncontractedEl.checked){
    document.getElementById('ml_done').checked = false;
    document.getElementById('ml_incomplete').checked = false;
  }

  syncMaintenanceStatusControls();
});

document.getElementById('cancelMlBtn').onclick = closeMaintenanceLogModal;

document.getElementById('ml_date_pick_btn').onclick = () => {
  const picker = document.getElementById('ml_date_picker');
  if (picker.showPicker) picker.showPicker();
  else picker.click();
};
document.getElementById('ml_date_picker').addEventListener('change', (e) => {
  document.getElementById('ml_date').value = fmtDateDots(e.target.value);
});

document.getElementById('saveMlBtn').onclick = () => {
  if (!maintenanceEditTarget) return;
  const { gid, ym } = maintenanceEditTarget;
  let date = document.getElementById('ml_date').value.trim();
  const manager = document.getElementById('ml_manager').value.trim();
  let note = document.getElementById('ml_note').value.trim();
  
  const done = document.getElementById('ml_done').checked;
  const incomplete = document.getElementById('ml_incomplete').checked;
  const uncontracted = document.getElementById('ml_uncontracted').checked;
  const errEl = document.getElementById('mlError');
  if (uncontracted){
    date = '';
    note = '';
  }
  else if (incomplete){
    date = '';
    if (!note){
      errEl.textContent = '미완료 사유를 반드시 입력해 주세요.';
      document.getElementById('ml_note').focus();
      return;
    }
  } else {
    if (!date){
      errEl.textContent = '점검일을 입력해 주세요.';
      return;
    }
    if (parseDate(date) === null){
      errEl.textContent =
        '점검일 형식이 올바르지 않습니다. 예: 2026.8.10';
      return;
    }
  }
  errEl.textContent = '';

  let log = maintenanceLogFor(gid, ym);
  if (!log){
    log = { id: Date.now(), group: gid, ym };
    maintenanceLogs.push(log);
  }
  log.date = date;
  log.manager = manager;
  log.note = note;
  log.done = uncontracted ? false : done;
  log.incomplete = uncontracted ? false : incomplete;
  log.uncontracted = uncontracted;
  log.author = currentUserName() || log.author || '';
  log.updated_at = Date.now();

  closeMaintenanceLogModal();
  renderMaintenance();
  scheduleAutoSync();
};

document.getElementById('mlDeleteBtn').onclick = () => {
  if (!maintenanceEditTarget) return;
  if (!confirm('이 달의 점검 등록을 취소하시겠습니까?')) return;
  const { gid, ym } = maintenanceEditTarget;
  maintenanceLogs = maintenanceLogs.filter(m => !(m.group === gid && m.ym === ym));
  closeMaintenanceLogModal();
  renderMaintenance();
  scheduleAutoSync();
};

let topFieldFilters = { country:'', location:'', support_id:'', check_method:'', config_mode:'', engineer:'', cust_contact:'' };

function uniqueValues(arr, keyFn){
  const set = new Set();
  arr.forEach(item => {
    const v = keyFn(item);
    if (v && String(v).trim()) set.add(String(v).trim());
  });
  return [...set].sort((a,b)=>a.localeCompare(b,'ko'));
}
function uniqueValuesMulti(arr, keyFn){
  const set = new Set();
  arr.forEach(item => {
    (keyFn(item)||[]).forEach(v => { if (v && String(v).trim()) set.add(String(v).trim()); });
  });
  return [...set].sort((a,b)=>a.localeCompare(b,'ko'));
}
function custContactNamesOf(r){
  if (r.cust_contacts && r.cust_contacts.length) return r.cust_contacts.map(c=>c.name);
  return r.cust_contact ? [r.cust_contact] : [];
}

function topFilterBarHtml(){
  const fields = [
    { key:'support_id',   label:'Support ID',    cls:'tf-support',  values: uniqueValues(records, r=>r.support_id) },
    { key:'country',      label:'국가',          cls:'tf-country',  values: uniqueValues(records, r=>r.country) },
    { key:'location',     label:'위치',          cls:'tf-location', values: uniqueValues(records, r=>r.location) },
    { key:'check_method', label:'점검 방식',     cls:'tf-check',    values: uniqueValues(records, r=>r.check_method) },
    { key:'config_mode',  label:'구성방식',      cls:'tf-config',   values: uniqueValues(records, r=>r.config_mode) },
    { key:'engineer',     label:'담당 엔지니어', cls:'tf-engineer', values: uniqueValuesMulti(records, r=>[r.owner_primary, r.owner_secondary]) },
    { key:'cust_contact', label:'고객사 담당자', cls:'tf-cust',     values: uniqueValuesMulti(records, r=>custContactNamesOf(r)) },
  ];
  const selectsHtml = fields.map(f => `
    <div class="tf-field ${f.cls}">
      <label>${esc(f.label)}</label>
      <select data-topfilter="${f.key}">
        <option value="">전체</option>
        ${f.values.map(v => `<option value="${esc(v)}" ${topFieldFilters[f.key]===v?'selected':''}>${esc(v)}</option>`).join('')}
      </select>
    </div>`).join('');
  const hasActive = Object.values(topFieldFilters).some(Boolean);
  const resetBtn = hasActive ? `<button type="button" class="tf-reset-btn" id="tfResetBtn">필터 초기화</button>` : '';
  return selectsHtml + resetBtn;
}

function groupCardHtml(gid, items, groupsMap, depth, visited){
  visited = visited ? new Set(visited) : new Set();
  if (visited.has(gid)) return '';
  visited.add(gid);

  const meta = groupMeta(items);
  const isOpen = expandedGroups.has(gid);
  const isChild = depth > 0;
  const realItems = items.filter(r => !r.is_group_shell);
  const worst = aggregateLicenseStatus(collectSubtreeLicenseStatuses(gid, groupsMap, new Set()));
  const subGroups = buildSubGroups(realItems);
  const collapseSubHead = subGroups.length <= 1;
  const soloSubGroup = collapseSubHead ? (subGroups[0] || null) : null;
  const editableSid = soloSubGroup ? soloSubGroup.sid : null;

  const isParentGroup = groupChildrenOf(gid).length > 0;
  const isParentDisplay = isParentGroup || meta.is_parent;
  const displayItemCount = isParentDisplay ? groupTotalItemCount(gid) : realItems.length;
  const displayConfigMode = isParentDisplay
    ? groupDescendantConfigModes(gid)
    : meta.config_mode;

  const subgroupsHtml = subGroups.map(sg => `
          <div class="subgroup-block">
            ${sg === soloSubGroup ? '' : `
            <div class="subgroup-head">
              <span class="sg-support-chip"><span class="meta-label">Support ID</span><span class="meta-value">${esc(sg.sid)||'미지정'}</span></span>
              ${buildEngineerInlineHtml(sg.meta)}
              <span class="sg-count-chip">${sg.items.length}건</span>
              ${isCurrentUserAdmin() ? `<button class="wl-action-btn icon-only sg-edit-btn" data-subgroup-gid="${esc(gid)}" data-subgroup-sid="${esc(sg.sid)}" title="Support ID / 구축 엔지니어 / 구축 일자 수정">${pencilSvg()}</button>` : ''}
            </div>`}
            <table>
              <thead><tr>
                ${canSelectAssets() ? '<th class="col-select"></th>' : ''}
                <th class="col-sku">SKU / 제품</th><th class="col-sn">S/N</th><th class="col-qty">수량</th><th class="col-license">라이선스 기간</th>
                <th>IP</th><th>ID</th><th>PW</th><th>OS 버전</th><th>비고</th><th>작업이력</th><th>관리</th>
              </tr></thead>
              <tbody>
                ${sg.items.map(r=>rowHtml(r, sg.sid)).join('')}
              </tbody>
            </table>
          </div>`).join('');

  const childGids = groupChildrenOf(gid).filter(cg => groupsMap.has(cg));
  const childrenHtml = childGids
    .map(cg => groupCardHtml(cg, groupsMap.get(cg), groupsMap, depth + 1, visited))
    .join('');

  return `
      <div class="group-card ${isChild ? 'group-card--child' : ''}" data-gid="${gid}">
        <div class="group-head ${isOpen?'expanded':''}" data-toggle="${gid}">
          <div class="group-head-left">
            ${isChild ? `<span class="child-branch" title="상위 법인에 속한 자회사">↳</span>` : ''}
            <div class="group-title">
              <div class="title-row">
                <h3 class="group-title-name">${esc(meta.owner)}</h3>
                ${supportIdTitleHtml(gid, items, isChild, editableSid)}
                <span class="meta-chip meta-chip-country"><span class="meta-label">국가</span><span class="meta-value">${esc(meta.country)||'—'}</span></span>
                <span class="meta-chip meta-chip-location"><span class="meta-label">위치</span><span class="meta-value">${esc(meta.location)||'—'}</span></span>
                ${isChild ? '' : `<span class="meta-chip meta-chip-check"><span class="meta-label">점검 방식</span><span class="meta-value">${esc(meta.check_method)||'—'}</span></span>`}
                <span class="meta-chip meta-chip-config"><span class="meta-label">구성방식</span><span class="meta-value">${esc(displayConfigMode)||'—'}</span></span>
                <span class="meta-chip"><span class="meta-label">항목</span><span class="meta-value">${displayItemCount}건</span></span>
                ${soloSubGroup ? buildEngineerInlineHtml(soloSubGroup.meta) : ''}
                ${isChild ? '' : managerNamesInlineHtml(meta)}
                ${isChild ? '' : custContactsSummaryHtml(gid, meta)}
              </div>
              ${groupRemarksHtml(meta)}
            </div>
          </div>
          <div class="group-badges">
            <div class="group-title-actions">
              ${currentUserName() && !(isParentGroup || meta.is_parent) ? `<button class="wl-action-btn icon-only" data-group-add-asset="${gid}" title="이 법인에 자산 추가">＋</button>` : ''}
              ${isCurrentUserAdmin() && (isParentGroup || meta.is_parent) ? `<button class="wl-action-btn icon-only" data-group-add-child="${gid}" title="이 법인을 상위 법인으로 하는 하위 법인 추가">↳＋</button>` : ''}
              ${currentUserName() ? `<button class="wl-action-btn icon-only" data-group-edit="${gid}" title="${isCurrentUserAdmin() ? '법인 정보 수정' : '고객사 담당자 / 비고 수정'}">${pencilSvg()}</button>` : ''}
              ${isCurrentUserAdmin() ? `<button class="wl-action-btn icon-only" data-group-duplicate="${gid}" title="이 법인의 자산을 그대로 복사해서 바로 아래에 새 법인으로 추가">${clipboardSvg()}</button>` : ''}
              ${isCurrentUserAdmin() ? `<button class="wl-action-btn icon-only danger" data-group-delete="${gid}" title="법인 전체 삭제">${trashSvg()}</button>` : ''}
            </div>
            <span class="badge ${statusBadgeVisual(worst).cls}" style="color:${statusBadgeVisual(worst).color}">${statusLabel(worst)}</span>
            <span class="chev ${isOpen?'open':''}" title="${isOpen?'접기':'펼치기'}">${isOpen ? chevCollapseSvg() : chevExpandSvg()}</span>
          </div>
        </div>
        <div class="items ${isOpen?'open':''}">
          ${subgroupsHtml}
          ${childrenHtml ? `<div class="child-groups">${childrenHtml}</div>` : ''}
        </div>
      </div>`;
}

function render(){
  const q = document.getElementById('searchInput').value.trim().toLowerCase();
  const mySiteGroupIds = getMySiteGroupIds();

  /* 라이선스 상태 필터는 실제 자산만 기준으로 계산 */
  const licenseMatchedGroupIds = new Set(
    records
      .filter(r => !r.is_group_shell && activeStatusFilters.has(licenseStatus(r)))
      .map(r => r.group)
  );
  const licenseVisibleGroupIds = new Set(licenseMatchedGroupIds);
  [...licenseMatchedGroupIds].forEach(gid => {
    let parentGid = groupParentOf(gid);
    while (parentGid){
      if (licenseVisibleGroupIds.has(parentGid)) break;
      licenseVisibleGroupIds.add(parentGid);
      parentGid = groupParentOf(parentGid);
    }
  });

  // 좌측 사이트에서 상위 법인을 선택한 경우
  // 상위 법인 + 모든 하위 법인까지 필터 대상에 포함
  let activeSiteGroupIds = null;

  if (activeCountryFilter){
    const selectedGid = allGroupIds().find(gid => {
      const items = records.filter(r => r.group === gid);
      if (!items.length) return false;

      const meta = groupMeta(items);

      return !meta.group_parent &&
             meta.owner === activeCountryFilter;
    });

    if (selectedGid){
      activeSiteGroupIds = new Set([
        selectedGid,
        ...groupDescendantIds(selectedGid)
      ]);
    }
  }

  let list = records.filter(r => {
    if (r.is_group_shell){
      if (!licenseVisibleGroupIds.has(r.group)) return false;
    } else {
      if (!activeStatusFilters.has(licenseStatus(r))) return false;
    }
    if (activeSkuKeywordFilters.size){
      const kws = skuKeywordMatches(r.sku);
      if (!kws.some(k => activeSkuKeywordFilters.has(k))) return false;
    }
    if (activeMyAssetsFilter){
      if (!mySiteGroupIds.has(r.group)) return false;
    }
    if (activeCountryFilter){
      if (!activeSiteGroupIds || !activeSiteGroupIds.has(r.group)){
        return false;
      }
    }
    if (topFieldFilters.country && (r.country||'').trim() !== topFieldFilters.country) return false;
    if (topFieldFilters.location && (r.location||'').trim() !== topFieldFilters.location) return false;
    if (topFieldFilters.support_id && (r.support_id||'').trim() !== topFieldFilters.support_id) return false;
    if (topFieldFilters.check_method && (r.check_method||'').trim() !== topFieldFilters.check_method) return false;
    if (topFieldFilters.config_mode && (r.config_mode||'').trim() !== topFieldFilters.config_mode) return false;
    if (topFieldFilters.engineer){
      const eng = topFieldFilters.engineer;
      if ((r.owner_primary||'').trim() !== eng && (r.owner_secondary||'').trim() !== eng) return false;
    }
    if (topFieldFilters.cust_contact){
      const names = custContactNamesOf(r).map(n=>(n||'').trim());
      if (!names.includes(topFieldFilters.cust_contact)) return false;
    }
    if (q){
      const custBits = (r.cust_contacts||[]).flatMap(c=>[c.name,c.phone,c.email]);
      const hay = [r.owner,r.country,r.location,r.sku,r.sn,r.support_id,r.check_method,r.owner_primary,r.owner_secondary,r.cust_contact,...custBits,r.remarks,r.group_remarks,skuKeywordMatches(r.sku).join(' ')].join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  const groups = groupRecords(list);
  const listArea = document.getElementById('assetListArea');
  const topFilterBarEl = document.getElementById('topFilterBar');
  if (topFilterBarEl) topFilterBarEl.innerHTML = topFilterBarHtml();

  if (groups.size === 0){
    listArea.innerHTML = `<div class="empty-state"><h3>조건에 맞는 자산이 없습니다</h3><p>검색어나 필터를 조정해 보세요.</p></div>`;
  } else {
    let html = '';
    for (const [gid, items] of groups){
      const parentGid = groupParentOf(gid);
      if (parentGid && groups.has(parentGid)) continue;
      html += groupCardHtml(gid, items, groups, 0);
    }
    listArea.innerHTML = html;
  }

  document.querySelectorAll('#topFilterBar [data-topfilter]').forEach(sel=>{
    sel.onchange = () => {
      topFieldFilters[sel.dataset.topfilter] = sel.value;
      render();
    };
  });
  const tfResetBtn = document.getElementById('tfResetBtn');
  if (tfResetBtn){
    tfResetBtn.onclick = () => {
      Object.keys(topFieldFilters).forEach(k => topFieldFilters[k] = '');
      render();
    };
  }

  document.querySelectorAll('[data-toggle]').forEach(el=>{
    el.onclick = () => {
      const gid = el.dataset.toggle;
      if (expandedGroups.has(gid)) collapseGroupWithDescendants(gid); else expandGroupWithDescendants(gid);
      render();
    };
  });

  document.querySelectorAll('[data-group-edit]').forEach(btn=>{
    btn.onclick = (e) => { e.stopPropagation(); openGroupEditModal(btn.dataset.groupEdit); };
  });
  document.querySelectorAll('[data-group-add-asset]').forEach(btn=>{
    btn.onclick = (e) => { e.stopPropagation(); openAddAssetToGroup(btn.dataset.groupAddAsset); };
  });
  document.querySelectorAll('[data-group-add-child]').forEach(btn=>{
    btn.onclick = (e) => { e.stopPropagation(); openAddGroupModal(btn.dataset.groupAddChild); };
  });
  document.querySelectorAll('[data-subgroup-gid]').forEach(btn=>{
    btn.onclick = (e) => { e.stopPropagation(); openSubGroupEditModal(btn.dataset.subgroupGid, btn.dataset.subgroupSid); };
  });
  document.querySelectorAll('[data-group-duplicate]').forEach(btn=>{
    btn.onclick = (e) => { e.stopPropagation(); duplicateGroup(btn.dataset.groupDuplicate); };
  });
  document.querySelectorAll('[data-group-delete]').forEach(btn=>{
    btn.onclick = (e) => { e.stopPropagation(); deleteGroup(btn.dataset.groupDelete); };
  });
  document.querySelectorAll('[data-cust-summary]').forEach(el=>{
    el.onclick = (e) => { e.stopPropagation(); openCustContactsModal(el.dataset.custSummary); };
  });
  document.querySelectorAll('[data-kwtag]').forEach(tag=>{
    tag.onclick = (e) => {
      e.stopPropagation();
      const k = tag.dataset.kwtag;
      if (activeSkuKeywordFilters.has(k)) activeSkuKeywordFilters.delete(k); else activeSkuKeywordFilters.add(k);
      render();
    };
  });
  document.querySelectorAll('.sec-val[data-copy-id]').forEach(el=>{
    el.onclick = async (e) => {
      e.stopPropagation();
      if (viewOnly || !sessionKey){ alert('민감정보를 보려면 먼저 마스터 비밀번호로 잠금을 해제해야 합니다.'); return; }
      let text = el.dataset.plain;
      if (text === undefined){
        const id = el.dataset.copyId, kind = el.dataset.copyKind;
        const rec = records.find(r=>String(r.id)===String(id));
        text = rec ? await decryptField(rec[kind+'_enc']) : '';
        el.dataset.plain = text;
      }
      if (!text) return;
      try{
        await navigator.clipboard.writeText(text);
        flashCopied(el);
      }catch(err){
        alert('클립보드 복사에 실패했습니다. 브라우저 권한을 확인해 주세요.');
      }
    };
  });

  document.querySelectorAll('[data-worklog]').forEach(btn=>{
    btn.onclick = (e) => {
      e.stopPropagation();
      openWorkLogModal(btn.dataset.worklog);
    };
  });
  document.querySelectorAll('[data-delete-asset]').forEach(btn=>{
    btn.onclick = (e) => {
      e.stopPropagation();
      deleteAsset(btn.dataset.deleteAsset);
    };
  });
  document.querySelectorAll('[data-direct-edit]').forEach(btn=>{
    btn.onclick = (e) => {
      e.stopPropagation();
      openDirectEditModal(btn.dataset.directEdit);
    };
  });
  document.querySelectorAll('[data-move-asset]').forEach(btn=>{
    btn.onclick = (e) => {
      e.stopPropagation();
      openMoveAssetModal(btn.dataset.moveAsset);
    };
  });
  document.querySelectorAll('[data-select-asset]').forEach(cb=>{
    cb.onclick = (e) => e.stopPropagation();
    cb.onchange = () => {
      const id = String(cb.dataset.selectAsset);
      if (cb.checked) selectedAssetIds.add(id); else selectedAssetIds.delete(id);
      updateBulkMoveBar();
    };
  });
  updateBulkMoveBar();

  buildFilters();
  updateActivityBadge();
  populateSecretFields();
  bindAssetUpdateTooltips();
  bindAssetDragDrop();
}

// ---------- 자산 일괄 선택 이동 툴바 ----------
function bulkMoveBarEl(){
  let bar = document.getElementById('bulkMoveBar');
  if (!bar){
    bar = document.createElement('div');
    bar.id = 'bulkMoveBar';
    bar.className = 'bulk-move-bar';
    bar.innerHTML = `
      <span class="bmb-count" id="bmbCount"></span>
      <button type="button" class="btn btn-ghost" id="bmbClearBtn">선택 해제</button>
      <button type="button" class="btn btn-ghost" id="bmbWorklogBtn" style="display:none;">선택 항목 작업 이력 등록</button>
      <button type="button" class="btn btn-primary" id="bmbMoveBtn" style="display:none;">선택 항목 이동</button>
    `;
    document.body.appendChild(bar);
    document.getElementById('bmbClearBtn').onclick = () => {
      selectedAssetIds.clear();
      render();
    };
    document.getElementById('bmbMoveBtn').onclick = () => {
      if (!selectedAssetIds.size) return;
      openMoveAssetModal([...selectedAssetIds]);
    };
    document.getElementById('bmbWorklogBtn').onclick = () => {
      if (!selectedAssetIds.size) return;
      openWorkLogModal([...selectedAssetIds]);
    };
  }
  return bar;
}
function updateBulkMoveBar(){
  const validIds = new Set(records.map(r=>String(r.id)));
  [...selectedAssetIds].forEach(id => { if (!validIds.has(id)) selectedAssetIds.delete(id); });

  if (!canSelectAssets() || selectedAssetIds.size === 0){
    const bar = document.getElementById('bulkMoveBar');
    if (bar) bar.classList.remove('open');
    return;
  }
  const bar = bulkMoveBarEl();
  document.getElementById('bmbCount').textContent = `${selectedAssetIds.size}개 항목 선택됨`;
  document.getElementById('bmbMoveBtn').style.display = canBulkMove() ? '' : 'none';
  document.getElementById('bmbWorklogBtn').style.display = currentUserName() ? '' : 'none';
  bar.classList.add('open');
}

function statusLabel(s){ return {ok:'정상', warn:'만료임박', crit:'만료됨', partial:'일부 만료', na:'기간정보없음'}[s]; }
function statusColorVar(s){ return {ok:'var(--green)', warn:'var(--amber)', crit:'var(--red)', na:'var(--text-faint)'}[s]; }

function snLink(r, groupSupportId){
  const rawSn = String(r.sn || '').trim();
  const sn = esc(rawSn);
  if (!rawSn) return '—';
  const supportId = r.support_id || groupSupportId;
  if (!supportId) return sn;
  const linkSn = /^\d+$/.test(rawSn) ? rawSn.padStart(10, '0') : rawSn;
  const url = `https://support.broadcom.com/group/ecx/licensing?siteId=${encodeURIComponent(supportId)}&serialNumber=${encodeURIComponent(linkSn)}`;
  return `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${sn}</a>`;
}

function managerNamesInlineHtml(meta){
  if (!meta.owner_primary && !meta.owner_secondary) return '';
  const names = [];
  if (meta.owner_primary) names.push(`<span class="mgr-primary">${esc(meta.owner_primary)}</span>`);
  if (meta.owner_secondary) names.push(`<span class="mgr-secondary">${esc(meta.owner_secondary)}</span>`);
  return `<span class="meta-chip meta-chip-mgr">
    <span class="meta-label">담당 엔지니어</span>
    <span class="meta-value">${names.join(' ')}</span>
  </span>`;
}

function buildEngineerInlineHtml(sgMeta){
  if (!sgMeta.build_engineer) return '';
  return `<span class="sg-build-chip">
    <span class="meta-label">구축 엔지니어</span>
    <span class="meta-value">${esc(sgMeta.build_engineer)}${sgMeta.build_date ? ` <span class="build-eng-date">(${esc(sgMeta.build_date)})</span>` : ''}</span>
  </span>`;
}

function custContactsSummaryHtml(gid, meta){
  const list = (meta.cust_contacts||[]).filter(c=>c.name||c.org||c.phone||c.email);
  if (!list.length) return '';
  const firstName = list[0].name ? esc(list[0].name) : '(이름 미입력)';
  const label = list.length > 1 ? `${firstName} 외 ${list.length-1}명` : firstName;
  return `<span class="meta-chip meta-chip-cust" data-cust-summary="${esc(gid)}" title="클릭하면 전체 고객사 담당자 정보를 볼 수 있습니다">
    <span class="meta-label">고객사 담당자</span>
    <span class="meta-value meta-value-link">${label}</span>
  </span>`;
}

let custContactsViewGid = null;

function openCustContactsModal(gid){
  custContactsViewGid = gid;
  const items = records.filter(r=>r.group===gid);
  if (!items.length) return;
  const meta = groupMeta(items);
  const list = (meta.cust_contacts||[]).filter(c=>c.name||c.org||c.phone||c.email);
  document.getElementById('custContactsModalTitle').textContent = `${meta.owner} · 고객사 담당자 (${list.length}명)`;
  const wrap = document.getElementById('custContactsModalList');
  wrap.innerHTML = list.map(c=>{
    const roleTag = c.role
      ? `<span class="cust-role-tag" data-role="${esc(c.role)}">${esc(c.role)}</span>`
      : `<span class="cust-role-tag cust-role-none">미지정</span>`;
    const rows = [];
    if (c.org) rows.push(`<span class="ccm-field"><b>소속</b> ${esc(c.org)}</span>`);
    if (c.phone) rows.push(`<span class="ccm-field"><b>연락처</b> ${esc(c.phone)}</span>`);
    if (c.email) rows.push(`<span class="ccm-field"><b>이메일</b> ${esc(c.email)}</span>`);
    return `<div class="ccm-card">
      <div class="ccm-head">${roleTag}<span class="ccm-name">${esc(c.name||'(이름 미입력)')}</span></div>
      ${rows.length ? `<div class="ccm-details">${rows.join('')}</div>` : ''}
    </div>`;
  }).join('') || `<div class="user-list-empty">등록된 담당자가 없습니다.</div>`;

  const memoView = document.getElementById('custContactsMemoView');
  if (meta.cust_memo){
    memoView.innerHTML = `<b>공통 메모</b>${esc(meta.cust_memo)}`;
    memoView.style.display = '';
  } else {
    memoView.innerHTML = '';
    memoView.style.display = 'none';
  }

  // 고객사 담당자는 다른 자산 세부 정보와 달리 작업 이력 없이 누구나(로그인 시) 바로 수정할 수 있습니다.
  document.getElementById('custContactsEditBtn').style.display = currentUserName() ? '' : 'none';
  setCustContactsEditMode(false);
  document.getElementById('custContactsModal').classList.add('open');
}

function setCustContactsEditMode(isEdit){
  document.getElementById('custContactsModalList').style.display = isEdit ? 'none' : '';
  document.getElementById('custEditWrap').style.display = isEdit ? '' : 'none';
  document.getElementById('custContactsViewActions').style.display = isEdit ? 'none' : '';
  document.getElementById('custContactsEditActions').style.display = isEdit ? '' : 'none';
}

document.getElementById('custContactsEditBtn').onclick = () => {
  if (!currentUserName()){ alert('로그인 후 이용해 주세요.'); return; }
  if (!custContactsViewGid) return;
  const items = records.filter(r=>r.group===custContactsViewGid);
  if (!items.length) return;
  const meta = groupMeta(items);
  cceCustContacts = (meta.cust_contacts && meta.cust_contacts.length
    ? meta.cust_contacts.slice(0,5)
    : [{role:'',name:'',org:'',phone:'',email:''}]
  ).map(c=>({...c}));
  renderCceCustRows();
  document.getElementById('cce_cust_memo').value = meta.cust_memo || '';
  setCustContactsEditMode(true);
};

document.getElementById('custContactsCancelEditBtn').onclick = () => {
  if (custContactsViewGid) openCustContactsModal(custContactsViewGid);
};

document.getElementById('custContactsSaveEditBtn').onclick = () => {
  if (!currentUserName()){ alert('로그인 후 이용해 주세요.'); return; }
  if (!custContactsViewGid) return;
  captureCceCustContactsFromDom();
  const newContacts = cceCustContacts.filter(c => c.name || c.org || c.phone || c.email).slice(0,5);
  const newMemo = document.getElementById('cce_cust_memo').value.trim();
  records.forEach(r => {
    if (r.group === custContactsViewGid){
      r.cust_contacts = newContacts;
      r.cust_memo = newMemo;
      r.cust_contact = ''; r.cust_phone = ''; r.cust_email = '';
    }
  });
  render();
  buildFilters();
  scheduleAutoSync();
  openCustContactsModal(custContactsViewGid);
};

let cceCustContacts = [];

function renderCceCustRows(){
  const wrap = document.getElementById('cce_cust_list');
  const roleOptions = ['', '운영', '영업'];
  wrap.innerHTML = cceCustContacts.map((c,idx)=>`
    <div class="cust-contact-row" data-idx="${idx}">
      <div class="cc-row-top">
        <select class="cc-role">
          ${roleOptions.map(r=>`<option value="${esc(r)}" ${c.role===r?'selected':''}>${r?esc(r):'구분'}</option>`).join('')}
        </select>
        <input class="cc-name" placeholder="이름" value="${esc(c.name||'')}">
        <button type="button" class="cc-remove-btn" data-remove="${idx}" title="이 담당자 삭제">✕</button>
      </div>
      <div class="cc-row-bottom">
        <input class="cc-org" placeholder="소속" value="${esc(c.org||'')}">
        <input class="cc-phone" placeholder="연락처" value="${esc(c.phone||'')}">
        <input class="cc-email" placeholder="이메일" value="${esc(c.email||'')}">
      </div>
    </div>`).join('');
  wrap.querySelectorAll('[data-remove]').forEach(btn=>{
    btn.onclick = () => {
      captureCceCustContactsFromDom();
      cceCustContacts.splice(Number(btn.dataset.remove),1);
      renderCceCustRows();
    };
  });
  updateCceCustAddBtnState();
}

function captureCceCustContactsFromDom(){
  const rows = document.querySelectorAll('#cce_cust_list .cust-contact-row');
  cceCustContacts = Array.from(rows).map(row=>({
    role: row.querySelector('.cc-role').value,
    name: row.querySelector('.cc-name').value.trim(),
    org: row.querySelector('.cc-org').value.trim(),
    phone: row.querySelector('.cc-phone').value.trim(),
    email: row.querySelector('.cc-email').value.trim(),
  }));
}

function updateCceCustAddBtnState(){
  const btn = document.getElementById('cce_cust_add_btn');
  btn.style.display = cceCustContacts.length >= 5 ? 'none' : '';
}

document.getElementById('cce_cust_add_btn').onclick = () => {
  captureCceCustContactsFromDom();
  if (cceCustContacts.length >= 5) return;
  cceCustContacts.push({role:'', name:'', org:'', phone:'', email:''});
  renderCceCustRows();
};

document.getElementById('custContactsModalCloseBtn').onclick = () => {
  document.getElementById('custContactsModal').classList.remove('open');
};

function groupRemarksHtml(meta){
  if (!meta.group_remarks) return '';
  return `<div class="sub group-remarks">${esc(meta.group_remarks)}</div>`;
}

function supportIdTitleHtml(gid, items, isChild, editableSid){
  const ownSids = ownSupportIds(items);

  if (isChild || !groupHasFamily(gid)){
    return supportIdChipSimple(gid, ownSids, editableSid);
  }

  const familyAll = familySupportIds(gid);
  const extraCount = Math.max(0, familyAll.length - ownSids.length);
  if (!ownSids.length){
    if (!familyAll.length) return '';
    return `<span class="title-support-ids"><span class="family-sid-chip"><span class="meta-label">Support ID</span><span class="meta-value">${familyAll.map(s=>esc(s)).join(', ')}</span></span></span>`;
  }
  const singleEditable = ownSids.length === 1 && extraCount === 0 && editableSid && ownSids[0] === editableSid && isCurrentUserAdmin();
  const attrs = singleEditable
    ? ` data-subgroup-gid="${esc(gid)}" data-subgroup-sid="${esc(ownSids[0])}" title="Support ID / 구축 엔지니어 / 구축 일자 수정"`
    : '';
  const valueText = ownSids.map(s=>esc(s)).join(', ') + (extraCount > 0 ? ` 외 ${extraCount}개` : '');
  return `<span class="title-support-ids"><span class="family-sid-chip${singleEditable ? ' family-sid-chip--editable' : ''}"${attrs}><span class="meta-label">Support ID</span><span class="meta-value">${valueText}</span></span></span>`;
}

function supportIdChipSimple(gid, sids, editableSid){
  if (!sids.length) return '';
  if (sids.length === 1){
    const s = sids[0];
    const editable = editableSid && s === editableSid && isCurrentUserAdmin();
    const attrs = editable
      ? ` data-subgroup-gid="${esc(gid)}" data-subgroup-sid="${esc(s)}" title="Support ID / 구축 엔지니어 / 구축 일자 수정"`
      : '';
    return `<span class="title-support-ids"><span class="family-sid-chip${editable ? ' family-sid-chip--editable' : ''}"${attrs}><span class="meta-label">Support ID</span><span class="meta-value">${esc(s)}</span></span></span>`;
  }
  return `<span class="title-support-ids"><span class="family-sid-chip"><span class="meta-label">Support ID</span><span class="meta-value">${sids.map(s=>esc(s)).join(', ')}</span></span></span>`;
}

/* =========================================================
   자산 행 - 최근 업데이트 툴팁
   ========================================================= */
function assetRecentUpdateItems(rec){
  const items = [];
  (rec.work_log || []).forEach(entry => {
    items.push({ entry, deleted:false, ts:Number(entry.updated_at || entry.id || 0) });
  });
  (rec.deleted_work_log || []).forEach(entry => {
    items.push({ entry, deleted:true, ts:Number(entry.deleted_at || entry.updated_at || entry.history_id || entry.id || 0) });
  });
  return items.sort((a,b)=>b.ts-a.ts).slice(0,5);
}

function assetUpdateTooltipHtml(rec){
  const items = assetRecentUpdateItems(rec);
  if (!items.length) return '';
  return `
    <div class="asset-update-tooltip-title">최근 업데이트 <span>${items.length}건</span></div>
    <div class="asset-update-tooltip-list">
      ${items.map(({entry, deleted}) => {
        const date = entry.date || (entry.updated_at ? new Date(entry.updated_at).toLocaleDateString('ko-KR') : '');
        const manager = entry.manager || entry.author || '';
        const detail = entry.change_summary || entry.note || '내용 없음';
        return `
          <div class="asset-update-tooltip-item ${deleted ? 'is-deleted' : ''}">
            <div class="asset-update-tooltip-head">
              <span class="asset-update-tooltip-type">${esc(entry.type || '작업 이력')}</span>
              ${deleted ? '<span class="asset-update-tooltip-deleted">삭제됨</span>' : ''}
              <span class="asset-update-tooltip-date">${esc(date)}</span>
            </div>
            <div class="asset-update-tooltip-detail">${esc(detail)}</div>
            ${manager ? `<div class="asset-update-tooltip-manager">${esc(manager)}</div>` : ''}
          </div>`;
      }).join('')}
    </div>`;
}

function getAssetUpdateTooltip(){
  let tooltip = document.getElementById('assetUpdateTooltip');
  if (!tooltip){
    tooltip = document.createElement('div');
    tooltip.id = 'assetUpdateTooltip';
    tooltip.className = 'asset-update-tooltip';
    document.body.appendChild(tooltip);
  }
  return tooltip;
}

function positionAssetUpdateTooltip(tooltip, e){
  const gap = 14;
  let left = e.clientX + gap;
  let top = e.clientY + gap;
  const width = tooltip.offsetWidth || 380;
  const height = tooltip.offsetHeight || 200;
  if (left + width > window.innerWidth - 12) left = e.clientX - width - gap;
  if (top + height > window.innerHeight - 12) top = window.innerHeight - height - 12;
  if (left < 12) left = 12;
  if (top < 12) top = 12;
  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${top}px`;
}

function bindAssetUpdateTooltips(){
  const tooltip = getAssetUpdateTooltip();
  document.querySelectorAll('tbody tr[data-id]').forEach(row => {
    const rec = records.find(r => String(r.id) === String(row.dataset.id));
    if (!rec) return;
    const html = assetUpdateTooltipHtml(rec);
    if (!html) return;
    row.addEventListener('mouseenter', e => {
      tooltip.innerHTML = html;
      tooltip.classList.add('open');
      positionAssetUpdateTooltip(tooltip, e);
    });
    row.addEventListener('mousemove', e => {
      const interactive = e.target.closest('button, a, input, select, textarea, .sec-val, .ip-chip, .asset-drag-handle');
      if (interactive){ tooltip.classList.remove('open'); return; }
      if (!tooltip.classList.contains('open')){
        tooltip.innerHTML = html;
        tooltip.classList.add('open');
      }
      positionAssetUpdateTooltip(tooltip, e);
    });
    row.addEventListener('mouseleave', () => tooltip.classList.remove('open'));
  });
}

/* =========================================================
   같은 법인/Support ID 내 자산 순서 드래그 앤 드롭
   ========================================================= */
let draggingAssetId = null;

function canReorderAssets(){ return !!currentUserName(); }
function assetSupportKey(rec){ return String(rec?.support_id || '').trim(); }
function sameAssetOrderScope(a,b){
  return !!(a && b && String(a.group) === String(b.group) && assetSupportKey(a) === assetSupportKey(b));
}
function assetOrderScope(rec){
  if (!rec) return [];
  return sortAssetsByOrder(records.filter(r =>
    !r.is_group_shell && String(r.group) === String(rec.group) && assetSupportKey(r) === assetSupportKey(rec)
  ));
}
function clearAssetDragVisuals(){
  document.querySelectorAll('tr.asset-dragging, tr.asset-drop-before, tr.asset-drop-after').forEach(row => {
    row.classList.remove('asset-dragging','asset-drop-before','asset-drop-after');
  });
}
function reorderAssetRows(sourceId, targetId, insertAfter){
  const source = records.find(r => String(r.id) === String(sourceId));
  const target = records.find(r => String(r.id) === String(targetId));
  if (!source || !target || source === target || !sameAssetOrderScope(source,target)) return;
  const ordered = assetOrderScope(source);
  const sourceIndex = ordered.findIndex(r => String(r.id) === String(source.id));
  if (sourceIndex < 0) return;
  const [moved] = ordered.splice(sourceIndex,1);
  let targetIndex = ordered.findIndex(r => String(r.id) === String(target.id));
  if (targetIndex < 0) return;
  if (insertAfter) targetIndex++;
  ordered.splice(targetIndex,0,moved);
  ordered.forEach((rec,index) => { rec.asset_order = index + 1; });
  render();
  scheduleAutoSync();
}
function bindAssetDragDrop(){
  if (!canReorderAssets()) return;
  document.querySelectorAll('.asset-drag-handle').forEach(handle => {
    handle.addEventListener('dragstart', e => {
      const recId = String(handle.dataset.dragAsset || '');
      if (!recId){ e.preventDefault(); return; }
      draggingAssetId = recId;
      const row = handle.closest('tr[data-id]');
      if (row) row.classList.add('asset-dragging');
      if (e.dataTransfer){ e.dataTransfer.effectAllowed='move'; e.dataTransfer.setData('text/plain',recId); }
    });
    handle.addEventListener('dragend', () => { draggingAssetId=null; clearAssetDragVisuals(); });
  });
  document.querySelectorAll('tbody tr[data-id]').forEach(row => {
    row.addEventListener('dragover', e => {
      if (!draggingAssetId) return;
      const targetId = String(row.dataset.id || '');
      if (!targetId || targetId === draggingAssetId) return;
      const source = records.find(r => String(r.id) === draggingAssetId);
      const target = records.find(r => String(r.id) === targetId);
      if (!sameAssetOrderScope(source,target)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect='move';
      document.querySelectorAll('tr.asset-drop-before, tr.asset-drop-after').forEach(el => {
        if (el !== row) el.classList.remove('asset-drop-before','asset-drop-after');
      });
      const rect = row.getBoundingClientRect();
      const insertAfter = e.clientY > rect.top + rect.height/2;
      row.classList.toggle('asset-drop-before',!insertAfter);
      row.classList.toggle('asset-drop-after',insertAfter);
    });
    row.addEventListener('dragleave', e => {
      if (e.relatedTarget && row.contains(e.relatedTarget)) return;
      row.classList.remove('asset-drop-before','asset-drop-after');
    });
    row.addEventListener('drop', e => {
      if (!draggingAssetId) return;
      const targetId = String(row.dataset.id || '');
      if (!targetId || targetId === draggingAssetId) return;
      const source = records.find(r => String(r.id) === draggingAssetId);
      const target = records.find(r => String(r.id) === targetId);
      if (!sameAssetOrderScope(source,target)) return;
      e.preventDefault();
      const insertAfter = row.classList.contains('asset-drop-after');
      const sourceId = draggingAssetId;
      draggingAssetId = null;
      clearAssetDragVisuals();
      reorderAssetRows(sourceId,targetId,insertAfter);
    });
  });
}

function rowHtml(r, groupSupportId){
  const status = licenseStatus(r);
  const pct = licenseBarPct(r);
  const logCount = (r.work_log||[]).length;
  return `
  <tr data-id="${r.id}">
    ${canSelectAssets() ? `
      <td class="col-select" data-label="">
        <div class="asset-select-wrap">
          ${canReorderAssets() ? `
            <span
              class="asset-drag-handle"
              draggable="true"
              data-drag-asset="${r.id}"
              title="드래그하여 자산 순서 변경"
            >⋮</span>
          ` : ''}
          <input
            type="checkbox"
            class="asset-select-cb"
            data-select-asset="${r.id}"
            ${selectedAssetIds.has(String(r.id)) ? 'checked' : ''}
            title="일괄 이동/작업 이력 등록을 위해 선택"
          >
        </div>
      </td>
    ` : ''}
    <td class="sku col-sku" data-label="SKU / 제품">
      ${skuBadge(r.sku)}
      ${skuKeywordTagsHtml(r.sku)}
    </td>
    <td class="sn col-sn" data-label="S/N">${snLink(r, groupSupportId)}</td>
    <td class="col-qty" data-label="수량">${esc(r.qty)||''}</td>
    <td class="col-license" data-label="라이선스 기간">
      <div class="lic-bar-wrap">
        <div class="lic-dates">${esc(r.start)||'-'} → ${esc(r.end)||'-'}</div>
        <div class="lic-bar"><i style="width:${pct}%; background:${statusColorVar(status)}"></i></div>
        <div class="lic-status ${status}">${statusLabel(status)}${daysLabel(r)?` · ${daysLabel(r)}`:''}</div>
      </div>
    </td>
    <td data-label="IP">${secretField(r,'ip')}</td>
    <td data-label="ID">${secretField(r,'id')}</td>
    <td data-label="PW">
      <div class="pw-cell">
        <div class="pw-cell-row">${secretField(r,'pw')}</div>
        ${r.enable_pw_enc ? `<div class="pw-cell-row pw-cell-enable"><span class="en-badge" title="Enable 비밀번호">EN</span>${secretField(r,'enable_pw')}</div>` : ''}
      </div>
    </td>
    <td data-label="OS 버전">${esc(r.os_ver)||'—'}</td>
    <td class="remarks-cell" data-label="비고"><div class="remarks-txt">${esc(r.remarks)||'—'}</div></td>
    <td data-label="작업이력">
      <button class="worklog-btn" data-worklog="${r.id}" title="작업이력 (${logCount}건)">${clipboardSvg()}<span class="cnt">${logCount}</span></button>
    </td>
    <td data-label="관리">
      <div style="display:flex; gap:6px;">
        ${isCurrentUserAdmin() ? `<button class="wl-action-btn icon-only" data-direct-edit="${r.id}" title="관리자 직접 수정 (작업이력 없이 바로 저장)">${pencilSvg()}</button>` : ''}
        ${isCurrentUserAdmin() ? `<button class="wl-action-btn icon-only" data-move-asset="${r.id}" title="다른 법인으로 이동">${moveSvg()}</button>` : ''}
        ${isCurrentUserAdmin() ? `<button class="wl-action-btn icon-only danger" data-delete-asset="${r.id}" title="삭제">${trashSvg()}</button>` : ''}
      </div>
    </td>
  </tr>`;
}

function favCountriesKey(){
  return 'bcAssetFavCountries_' + (currentUserId || 'anon');
}
function getFavCountries(){
  try{
    const raw = localStorage.getItem(favCountriesKey());
    return new Set(raw ? JSON.parse(raw) : []);
  }catch(e){ return new Set(); }
}
function toggleFavCountry(name){
  const set = getFavCountries();
  if (set.has(name)) set.delete(name); else set.add(name);
  try{ localStorage.setItem(favCountriesKey(), JSON.stringify([...set])); }catch(e){}
}

function buildFilters(){
  renderFiltersResetSlot();

  const statusBox = document.getElementById('statusFilters');
  const statuses = [['ok','정상'],['warn','만료임박'],['crit','만료됨'],['na','기간없음']];
  statusBox.innerHTML = statuses.map(([k,l])=>`
    <div class="filter-item ${activeStatusFilters.has(k)?'active':''}" data-status="${k}">
      <span>${l}</span><span class="cnt">${records.filter(r=>!r.is_group_shell && licenseStatus(r)===k).length}</span>
    </div>`).join('');
  statusBox.querySelectorAll('[data-status]').forEach(el=>{
    el.onclick = ()=>{
      const k = el.dataset.status;
      if (activeStatusFilters.has(k)) activeStatusFilters.delete(k); else activeStatusFilters.add(k);
      render();
    };
  });

  const countryBox = document.getElementById('countryFilters');
  const favSet = getFavCountries();
  const owners = [...new Map(
    [...groupRecords(records).entries()]
      .map(([gid, grp]) => {
        const meta = groupMeta(grp);
  
        // 상위 법인이 지정된 하위 법인은 좌측 사이트 목록에서 제외
        if (meta.group_parent) return null;
  
        return [meta.owner, meta];
      })
      .filter(Boolean)
  ).values()].sort((a,b)=>{
    const af = favSet.has(a.owner) ? 0 : 1;
    const bf = favSet.has(b.owner) ? 0 : 1;
  
    if (af !== bf) return af - bf;
  
    return a.owner.localeCompare(b.owner, 'ko');
  });
  countryBox.innerHTML = owners.map(m=>{
    const isFav = favSet.has(m.owner);
    return `
    <div class="filter-item country-filter-item ${activeCountryFilter===m.owner?'active':''}" data-owner="${esc(m.owner)}">
      <button type="button" class="fav-star ${isFav?'active':''}" data-fav="${esc(m.owner)}" title="즐겨찾기">${isFav?'★':'☆'}</button>
      <span class="country-name">${esc(m.owner)}</span>
    </div>`;
  }).join('');
  countryBox.querySelectorAll('[data-fav]').forEach(btn=>{
    btn.onclick = (e)=>{
      e.stopPropagation();
      toggleFavCountry(btn.dataset.fav);
      buildFilters();
    };
  });
  countryBox.querySelectorAll('[data-owner]').forEach(el=>{
    el.onclick = (e)=>{
      if (e.target.closest('[data-fav]')) return;
      const v = el.dataset.owner;
      activeCountryFilter = activeCountryFilter===v ? null : v;
      render();
    };
  });

  const kwBox = document.getElementById('skuKeywordFilters');
  kwBox.innerHTML = SKU_TAG_KEYS.map(k=>{
    const cnt = records.filter(r=>!r.is_group_shell && skuKeywordMatches(r.sku).includes(k)).length;
    return `
    <div class="filter-item ${activeSkuKeywordFilters.has(k)?'active':''}" data-skukw="${esc(k)}">
      <span>${esc(k)}</span><span class="cnt">${cnt}</span>
    </div>`;
  }).join('');
  kwBox.querySelectorAll('[data-skukw]').forEach(el=>{
    el.onclick = ()=>{
      const k = el.dataset.skukw;
      if (activeSkuKeywordFilters.has(k)) activeSkuKeywordFilters.delete(k); else activeSkuKeywordFilters.add(k);
      render();
    };
  });

  updateMyAssetsToggle();
  updateExpandAllBtn();
}

function getMySiteGroupIds(){
  const ids = new Set();
  const me = currentUserName();
  if (!me) return ids;
  const seenGroups = new Set();
  records.forEach(r=>{
    if (seenGroups.has(r.group)) return;
    seenGroups.add(r.group);
    const meta = groupMeta(records.filter(x=>x.group===r.group));
    if (meta.owner_primary === me) ids.add(r.group);
  });
  return ids;
}

function getMyTopLevelGroupCount(){
  const me = currentUserName();
  if (!me) return 0;
  return maintenanceGroupList().filter(g => g.meta.owner_primary === me).length;
}

function updateMyAssetsToggle(){
  const btn = document.getElementById('myAssetsToggle');
  const cntEl = document.getElementById('myAssetsCount');
  if (!btn || !cntEl) return;
  const me = currentUserName();
  cntEl.textContent = getMyTopLevelGroupCount();
  btn.classList.toggle('active', activeMyAssetsFilter);
  btn.disabled = !me;
  btn.title = me ? '내가 정 담당자인 사이트만 보기' : '로그인이 필요합니다.';
}

function updateExpandAllBtn(){
  const btn = document.getElementById('expandAllBtn');
  if (!btn) return;
  const allOpen = expandedGroups.size > 0;
  btn.textContent = allOpen ? '⬆️' : '⬇️';
  btn.title = allOpen ? '전체 접기' : '전체 펼치기';
  btn.classList.toggle('is-collapse-mode', allOpen);
}

function renderFiltersResetSlot(){
  const slot = document.getElementById('filtersResetSlot');
  if (!slot) return;
  const defaultStatus = ['ok','warn','na'];
  const isDefaultStatus = activeStatusFilters.size === defaultStatus.length && defaultStatus.every(s=>activeStatusFilters.has(s));
  const searchInput = document.getElementById('searchInput');
  const hasQuery = !!(searchInput && searchInput.value.trim());
  const hasTopFieldFilters = Object.values(topFieldFilters).some(Boolean);
  const hasActiveFilters = !isDefaultStatus || !!activeCountryFilter
    || activeSkuKeywordFilters.size > 0 || activeMyAssetsFilter || hasQuery || hasTopFieldFilters;

  if (!hasActiveFilters){ slot.innerHTML = ''; return; }
  slot.innerHTML = `<button type="button" class="filters-reset-btn" id="filtersResetBtn">✕ 필터 초기화</button>`;
  document.getElementById('filtersResetBtn').onclick = () => {
    activeStatusFilters = new Set(['ok','warn','na']);
    activeCountryFilter = null;
    activeSkuKeywordFilters = new Set();
    activeMyAssetsFilter = false;
    Object.keys(topFieldFilters).forEach(k => topFieldFilters[k] = '');
    if (searchInput) searchInput.value = '';
    render();
  };
}

document.getElementById('myAssetsToggle').onclick = () => {
  if (!currentUserName()) return;
  activeMyAssetsFilter = !activeMyAssetsFilter;
  updateMyAssetsToggle();
  if (currentViewMode === 'maintenance'){
    renderMaintenance();
    return;
  }
  render();
};

document.getElementById('searchInput').addEventListener('input', render);

document.getElementById('expandAllBtn').onclick = () => {
  const allOpen = expandedGroups.size > 0;
  if (allOpen){ expandedGroups.clear(); }
  else { records.forEach(r=>expandedGroups.add(r.group)); }
  render();
};

// ---------- add / edit / delete record ----------
const ASSET_FORM_IDS = ['f_owner','f_country','f_location','f_support','f_sku','f_sn','f_qty','f_start','f_end','f_os','f_check','f_ip','f_id','f_pw','f_enable_pw','f_remarks'];

function clearAssetForm(){
  ASSET_FORM_IDS.forEach(id=>document.getElementById(id).value='');
}

document.getElementById('addBtn').onclick = () => {
  openAddGroupModal();
};
document.getElementById('cancelAddBtn').onclick = () => {
  document.getElementById('addModal').classList.remove('open');
  editingRecordId = null;
  addAssetTargetGid = null;
};

function openAddAssetToGroup(gid){
  if (!currentUserName()){ alert('로그인 후 이용해 주세요.'); return; }
  if (viewOnly || !sessionKey){ alert('자산을 추가하려면 먼저 마스터 비밀번호로 잠금을 해제해야 합니다.'); return; }
  if (groupChildrenOf(gid).length || groupMeta(records.filter(r=>r.group===gid)).is_parent){ alert('상위 법인은 대표 이름 역할만 하므로 자산을 직접 추가할 수 없습니다. 해당 자산이 속할 자식 법인(Support ID)에 추가해 주세요.'); return; }
  const items = records.filter(r=>r.group===gid);
  if (!items.length) return;
  const meta = groupMeta(items);

  editingRecordId = null;
  addAssetTargetGid = gid;
  clearAssetForm();
  const set = (id, v) => { document.getElementById(id).value = v || ''; };
  set('f_owner', meta.owner==='(법인명 미확인)' ? '' : meta.owner);
  set('f_country', meta.country);
  set('f_location', meta.location);
  set('f_check', meta.check_method);
  const sids = ownSupportIds(items);
  set('f_support', sids.length === 1 ? sids[0] : '');

  document.getElementById('addModalTitle').textContent = `"${meta.owner}" 법인에 자산 추가`;
  document.getElementById('saveAddBtn').textContent = '항목 저장';
  document.getElementById('addModal').classList.add('open');
}

async function openDirectEditModal(recId){
  if (!isCurrentUserAdmin()){ alert('마스터 관리자만 직접 수정할 수 있습니다.'); return; }
  if (viewOnly || !sessionKey){ alert('먼저 마스터 비밀번호로 잠금을 해제해야 합니다.'); return; }
  const rec = records.find(r=>String(r.id)===String(recId));
  if (!rec) return;

  editingRecordId = recId;
  addAssetTargetGid = null;
  clearAssetForm();
  const set = (id, v) => { document.getElementById(id).value = v || ''; };
  const meta = groupMeta(records.filter(r=>r.group===rec.group));
  set('f_owner', meta.owner==='(법인명 미확인)' ? '' : meta.owner);
  set('f_country', meta.country); set('f_location', meta.location); set('f_support', rec.support_id);
  set('f_sku', rec.sku); set('f_sn', rec.sn); set('f_qty', rec.qty);
  set('f_start', rec.start); set('f_end', rec.end); set('f_os', rec.os_ver); set('f_check', meta.check_method);
  set('f_remarks', rec.remarks);
  set('f_ip', rec.ip_enc ? await decryptField(rec.ip_enc) : '');
  set('f_id', rec.id_enc ? await decryptField(rec.id_enc) : '');
  set('f_pw', rec.pw_enc ? await decryptField(rec.pw_enc) : '');
  set('f_enable_pw', rec.enable_pw_enc ? await decryptField(rec.enable_pw_enc) : '');

  document.getElementById('addModalTitle').textContent = '자산 정보 직접 수정 (관리자)';
  document.getElementById('saveAddBtn').textContent = '수정 저장 (작업이력 없이)';
  document.getElementById('addModal').classList.add('open');
}

function deleteAsset(recId){
  if (!isCurrentUserAdmin()){ alert('마스터만 자산을 삭제할 수 있습니다.'); return; }
  const rec = records.find(r=>String(r.id)===String(recId));
  if (!rec) return;
  if (!confirm(`이 자산 항목을 삭제하시겠습니까?\n${rec.sku||''} ${rec.sn? '(S/N '+rec.sn+')':''}`)) return;
  records = records.filter(r=>String(r.id)!==String(recId));
  render();
  buildFilters();
  scheduleAutoSync();
}

document.getElementById('saveAddBtn').onclick = async () => {
  if (viewOnly || !sessionKey){ alert('자산을 추가/수정하려면 먼저 마스터 비밀번호로 잠금을 해제해야 합니다.'); return; }
  const val = id => document.getElementById(id).value.trim();

  if (editingRecordId){
    if (!isCurrentUserAdmin()){ alert('마스터 관리자만 직접 수정할 수 있습니다.'); return; }
    const rec = records.find(r=>String(r.id)===String(editingRecordId));
    if (!rec){ editingRecordId = null; document.getElementById('addModal').classList.remove('open'); return; }
    Object.assign(rec, {
      sku:val('f_sku'), sn:val('f_sn'), qty:val('f_qty'),
      start:val('f_start'), end:val('f_end'), remarks:val('f_remarks'),
      os_ver:val('f_os'),
      ip_enc: await encryptField(val('f_ip')),
      id_enc: await encryptField(val('f_id')),
      pw_enc: await encryptField(val('f_pw')),
      enable_pw_enc: await encryptField(val('f_enable_pw')),
    });
    editingRecordId = null;
    document.getElementById('addModal').classList.remove('open');
    clearAssetForm();
    render();
    buildFilters();
    scheduleAutoSync();
    return;
  }

  if (addAssetTargetGid){
    if (groupChildrenOf(addAssetTargetGid).length || groupMeta(records.filter(r=>r.group===addAssetTargetGid)).is_parent){
      alert('상위 법인은 대표 이름 역할만 하므로 자산을 직접 추가할 수 없습니다.');
      return;
    }
    const items = records.filter(r=>r.group===addAssetTargetGid);
    if (!items.length){ addAssetTargetGid = null; document.getElementById('addModal').classList.remove('open'); return; }
    const meta = groupMeta(items);
    const newId = nextRecordId();
    const newSupportId = val('f_support');
    const realItemsBefore = items.filter(r => !r.is_group_shell);
    const supportItems = items.filter(r => (r.support_id||'').trim() === newSupportId);
    const shellSupport = items.find(r => r.is_group_shell && (r.support_id||'').trim() === newSupportId);
    const supportMeta = supportItems.length
      ? subGroupMeta(realItemsBefore.length ? supportItems.filter(r=>!r.is_group_shell) : supportItems)
      : {build_engineer:'', build_date:''};
    if (shellSupport && !realItemsBefore.length){
      supportMeta.build_engineer = shellSupport.build_engineer || supportMeta.build_engineer || '';
      supportMeta.build_date = shellSupport.build_date || supportMeta.build_date || '';
    }
    const rec = {
      id:newId, group:addAssetTargetGid, flag: meta.flag || '',
      owner: meta.owner, country: meta.country, location: meta.location,
      support_id:newSupportId, build_engineer:supportMeta.build_engineer || '', build_date:supportMeta.build_date || '', sku:val('f_sku'), sn:val('f_sn'), qty:val('f_qty'),
      start:val('f_start'), end:val('f_end'), remarks:val('f_remarks'), deploy_date:'',
      mode:'', os_ver:val('f_os'), owner_primary: meta.owner_primary, owner_secondary: meta.owner_secondary,
      check_method: meta.check_method, config_mode: meta.config_mode,
      cust_contacts: JSON.parse(JSON.stringify(meta.cust_contacts || [])),
      cust_memo: meta.cust_memo || '',
      cust_contact:'', cust_phone:'', cust_email:'',
      group_remarks: meta.group_remarks, group_parent: meta.group_parent, is_parent: meta.is_parent, work_log:[],
      ip_enc: await encryptField(val('f_ip')),
      id_enc: await encryptField(val('f_id')),
      pw_enc: await encryptField(val('f_pw')),
      enable_pw_enc: await encryptField(val('f_enable_pw')),
    };
    records.push(rec);
    expandGroupWithAncestors(addAssetTargetGid);
    addAssetTargetGid = null;
    document.getElementById('addModal').classList.remove('open');
    clearAssetForm();
    render();
    buildFilters();
    scheduleAutoSync();
    return;
  }

  const newId = nextRecordId();
  const gid = makeUniqueGroupId('custom');
  const rec = {
    id:newId, group:gid, flag:'', owner:val('f_owner')||'(신규 항목)', country:val('f_country'), location:val('f_location'),
    support_id:val('f_support'), sku:val('f_sku'), sn:val('f_sn'), qty:val('f_qty'),
    start:val('f_start'), end:val('f_end'), remarks:val('f_remarks'), deploy_date:'',
    mode:'', os_ver:val('f_os'), check_method:val('f_check'),
    cust_contact:'', cust_phone:'', cust_email:'', work_log:[],
    ip_enc: await encryptField(val('f_ip')),
    id_enc: await encryptField(val('f_id')),
    pw_enc: await encryptField(val('f_pw')),
    enable_pw_enc: await encryptField(val('f_enable_pw')),
  };
  records.push(rec);
  expandedGroups.add(gid);

  document.getElementById('addModal').classList.remove('open');
  clearAssetForm();
  render();
  buildFilters();
  scheduleAutoSync();
};

// ---------- group (title bar) edit / delete ----------
let groupEditId = null;
let geCustContacts = [];

function renderCustContactRows(){
  const wrap = document.getElementById('ge_cust_list');
  const roleOptions = ['', '운영', '영업'];
  wrap.innerHTML = geCustContacts.map((c,idx)=>`
    <div class="cust-contact-row" data-idx="${idx}">
      <div class="cc-row-top">
        <select class="cc-role">
          ${roleOptions.map(r=>`<option value="${esc(r)}" ${c.role===r?'selected':''}>${r?esc(r):'구분'}</option>`).join('')}
        </select>
        <input class="cc-name" placeholder="이름" value="${esc(c.name||'')}">
        <button type="button" class="cc-remove-btn" data-remove="${idx}" title="이 담당자 삭제">✕</button>
      </div>
      <div class="cc-row-bottom">
        <input class="cc-org" placeholder="소속" value="${esc(c.org||'')}">
        <input class="cc-phone" placeholder="연락처" value="${esc(c.phone||'')}">
        <input class="cc-email" placeholder="이메일" value="${esc(c.email||'')}">
      </div>
    </div>`).join('');
  wrap.querySelectorAll('[data-remove]').forEach(btn=>{
    btn.onclick = () => {
      captureCustContactsFromDom();
      geCustContacts.splice(Number(btn.dataset.remove),1);
      renderCustContactRows();
    };
  });
  updateCustAddBtnState();
}

function captureCustContactsFromDom(){
  const rows = document.querySelectorAll('#ge_cust_list .cust-contact-row');
  geCustContacts = Array.from(rows).map(row=>({
    role: row.querySelector('.cc-role').value,
    name: row.querySelector('.cc-name').value.trim(),
    org: row.querySelector('.cc-org').value.trim(),
    phone: row.querySelector('.cc-phone').value.trim(),
    email: row.querySelector('.cc-email').value.trim(),
  }));
}

function updateCustAddBtnState(){
  const btn = document.getElementById('ge_cust_add_btn');
  btn.style.display = geCustContacts.length >= 5 ? 'none' : '';
}

document.getElementById('ge_cust_add_btn').onclick = () => {
  captureCustContactsFromDom();
  if (geCustContacts.length >= 5) return;
  geCustContacts.push({role:'', name:'', org:'', phone:'', email:''});
  renderCustContactRows();
};

function populateParentGroupSelect(gid, currentParent){
  const sel = document.getElementById('ge_parent_group');
  const excluded = new Set([gid, ...groupDescendantIds(gid)]);
  const options = allGroupIds()
    .filter(g => !excluded.has(g))
    .map(g => ({ gid:g, meta: groupMeta(records.filter(r=>r.group===g)) }))
    .filter(o => o.meta.is_parent)
    .map(o => ({ gid:o.gid, owner:o.meta.owner }))
    .sort((a,b) => a.owner.localeCompare(b.owner, 'ko'));
  sel.innerHTML = '<option value="">없음 (독립된 법인)</option>' +
    options.map(o => `<option value="${esc(o.gid)}">${esc(o.owner)}</option>`).join('');
  sel.value = (currentParent && !excluded.has(currentParent)) ? currentParent : '';
}

let geSubGroupsCache = [];
let geOriginalConfigMode = '';

function applyGeSidFieldState(){
  const sidInput = document.getElementById('ge_support_id');
  const engInput = document.getElementById('ge_build_engineer');
  const dateInput = document.getElementById('ge_build_date');
  const configSelect = document.getElementById('ge_config_mode');
  const isParentCb = document.getElementById('ge_is_parent');
  const subGroups = geSubGroupsCache;

  configSelect.disabled = isParentCb.checked;
  configSelect.value = isParentCb.checked ? '' : geOriginalConfigMode;

  if (isParentCb.checked){
    sidInput.disabled = true; engInput.disabled = true; dateInput.disabled = true;
    sidInput.value = ''; engInput.value = ''; dateInput.value = '';
    sidInput.placeholder = '상위 법인은 대표 이름 역할만 합니다';
    engInput.placeholder = '자식 법인에서 관리';
    dateInput.placeholder = '자식 법인에서 관리';
  } else if (subGroups.length <= 1){
    sidInput.disabled = false; engInput.disabled = false; dateInput.disabled = false;
    sidInput.value = subGroups.length ? subGroups[0].sid : '';
    engInput.value = subGroups.length ? (subGroups[0].meta.build_engineer || '') : '';
    dateInput.value = subGroups.length ? (subGroups[0].meta.build_date || '') : '';
    sidInput.placeholder = '예: 12345678';
    engInput.placeholder = '장비를 구축한 엔지니어 (선택)';
    dateInput.placeholder = '2026.07';
  } else {
    sidInput.disabled = true; engInput.disabled = true; dateInput.disabled = true;
    sidInput.value = subGroups.map(sg=>sg.sid||'미지정').join(', ');
    engInput.value = ''; dateInput.value = '';
    sidInput.placeholder = '';
    engInput.placeholder = 'Support ID별로 각 영역의 ✎ 버튼에서 수정';
    dateInput.placeholder = 'Support ID별로 각 영역의 ✎ 버튼에서 수정';
  }
}
document.getElementById('ge_is_parent').addEventListener('change', applyGeSidFieldState);

function openGroupEditModal(gid){
  const isAdmin = isCurrentUserAdmin();
  if (!currentUserName()){ alert('로그인 후 수정할 수 있습니다.'); return; }
  if (isAdmin && (viewOnly || !sessionKey)){
    alert('법인 정보를 수정하려면 먼저 마스터 비밀번호로 잠금을 해제해야 합니다.');
    return;
  }
  const items = records.filter(r=>r.group===gid);
  if (!items.length) return;
  const meta = groupMeta(items);
  groupEditId = gid;
  document.getElementById('ge_owner').value = meta.owner==='(법인명 미확인)' ? '' : meta.owner;
  document.getElementById('ge_country').value = meta.country || '';
  document.getElementById('ge_location').value = meta.location || '';
  document.getElementById('ge_check').value = meta.check_method || '';
  document.getElementById('ge_owner_primary').value = meta.owner_primary || '';
  document.getElementById('ge_owner_secondary').value = meta.owner_secondary || '';
  document.getElementById('ge_remarks').value = meta.group_remarks || '';
  geOriginalConfigMode = meta.config_mode || '';

  const hasChildren = groupChildrenOf(gid).length > 0;
  geSubGroupsCache = buildSubGroups(items);
  const isParentCb = document.getElementById('ge_is_parent');
  isParentCb.checked = hasChildren || !!meta.is_parent;
  isParentCb.disabled = hasChildren;
  applyGeSidFieldState();

  populateParentGroupSelect(gid, meta.group_parent);
  geCustContacts = (meta.cust_contacts && meta.cust_contacts.length
    ? meta.cust_contacts.slice(0,5)
    : [{role:'',name:'',org:'',phone:'',email:''}]
  ).map(c=>({...c}));
  renderCustContactRows();
  updateGeCustSectionVisibility();

  const modal = document.getElementById('groupEditModal');
  modal.querySelectorAll('.form-grid input, .form-grid select, .form-grid textarea, .form-grid button').forEach(el => {
    el.disabled = !isAdmin;
  });
  if (!isAdmin){
    document.getElementById('ge_remarks').disabled = false;
    modal.querySelectorAll('#ge_cust_list input, #ge_cust_list select, #ge_cust_list button').forEach(el => { el.disabled = false; });
    const addCustBtn = document.getElementById('ge_cust_add_btn');
    if (addCustBtn) addCustBtn.disabled = false;
  }

  let notice = document.getElementById('geLimitedEditNotice');
  if (!notice){
    notice = document.createElement('div');
    notice.id = 'geLimitedEditNotice';
    notice.className = 'ge-limited-edit-notice';
    const grid = modal.querySelector('.form-grid');
    grid.parentNode.insertBefore(notice, grid);
  }
  if (isAdmin){
    notice.style.display = 'none';
  } else {
    notice.style.display = '';
    notice.textContent = '일반사용자는 고객사 담당자와 법인 비고만 수정할 수 있습니다.';
  }

  document.getElementById('geError').textContent = '';
  modal.classList.add('open');
}

function updateGeCustSectionVisibility(){
  const isChildNow = !!document.getElementById('ge_parent_group').value;
  document.getElementById('ge_cust_list').style.display = isChildNow ? 'none' : '';
  document.getElementById('ge_cust_add_btn').style.display = isChildNow ? 'none' : '';
  document.getElementById('geCustHiddenHint').style.display = isChildNow ? '' : 'none';
}
document.getElementById('ge_parent_group').addEventListener('change', updateGeCustSectionVisibility);

document.getElementById('cancelGeBtn').onclick = () => {
  document.getElementById('groupEditModal').classList.remove('open');
  groupEditId = null;
};

document.getElementById('saveGeBtn').onclick = () => {
  if (!groupEditId) return;
  const isAdmin = isCurrentUserAdmin();

  if (!isAdmin){
    if (!currentUserName()){ alert('로그인 후 수정할 수 있습니다.'); return; }
    const items = records.filter(r => String(r.group) === String(groupEditId));
    if (!items.length) return;
    captureCustContactsFromDom();
    const newContacts = geCustContacts.filter(c => c.name || c.org || c.phone || c.email).slice(0,5);
    const remarks = document.getElementById('ge_remarks').value.trim();
    items.forEach(r => {
      r.group_remarks = remarks;
      r.cust_contacts = newContacts.map(c => ({...c}));
      r.cust_contact = ''; r.cust_phone = ''; r.cust_email = '';
    });
    document.getElementById('groupEditModal').classList.remove('open');
    groupEditId = null;
    render();
    buildFilters();
    scheduleAutoSync();
    return;
  }

  const val = id => document.getElementById(id).value.trim();
  const newOwner = val('ge_owner');
  if (!newOwner){ document.getElementById('geError').textContent = '법인명을 입력해 주세요.'; return; }
  const newLocation = val('ge_location');
  const newCountry = val('ge_country');
  const newCheck = val('ge_check');
  const newConfigMode = val('ge_config_mode');
  const newPrimary = val('ge_owner_primary');
  const newSecondary = val('ge_owner_secondary');
  const newRemarks = val('ge_remarks');
  const newIsParent = document.getElementById('ge_is_parent').checked;
  const newParentGid = document.getElementById('ge_parent_group').value;
  const sidInputEl = document.getElementById('ge_support_id');
  const engInputEl = document.getElementById('ge_build_engineer');
  const dateInputEl = document.getElementById('ge_build_date');
  const applySoloSid = !sidInputEl.disabled;
  const newSupportId = applySoloSid ? sidInputEl.value.trim() : null;
  const newBuildEngineer = applySoloSid ? engInputEl.value.trim() : null;
  const newBuildDate = applySoloSid ? dateInputEl.value.trim() : null;
  if (applySoloSid && newBuildDate && !/^\d{4}\.(0?[1-9]|1[0-2])$/.test(newBuildDate)){
    document.getElementById('geError').textContent = '구축 일자는 YYYY.MM 형식으로 입력해 주세요 (예: 2026.07).';
    return;
  }
  
  const forbiddenParents = new Set([groupEditId, ...groupDescendantIds(groupEditId)]);
  const finalParentGid = (newParentGid && !forbiddenParents.has(newParentGid)) ? newParentGid : '';
  captureCustContactsFromDom();
  
  const newContacts = finalParentGid ? [] : geCustContacts.filter(c => c.name || c.org || c.phone || c.email).slice(0,5);
  records.forEach(r => {
    if (r.group === groupEditId){
      r.owner = newOwner;
      r.location = newLocation;
      r.country = newCountry;
      r.check_method = newCheck;
      r.config_mode = newConfigMode;
      r.owner_primary = newPrimary;
      r.owner_secondary = newSecondary;
      r.group_remarks = newRemarks;
      r.group_parent = finalParentGid;
      r.is_parent = newIsParent;
      r.cust_contacts = newContacts;
      r.cust_contact = ''; r.cust_phone = ''; r.cust_email = '';
      if (applySoloSid){
        r.support_id = newSupportId;
        r.build_engineer = newBuildEngineer;
        r.build_date = newBuildDate;
      }
    }
  });
  enforceParentsHaveNoDirectAssets();
  document.getElementById('groupEditModal').classList.remove('open');
  groupEditId = null;
  render();
  buildFilters();
  scheduleAutoSync();
};

// ---------- 법인 추가 (좌측 패널 ＋ 버튼) ----------
function renderNgCustContactRows(){
  const wrap = document.getElementById('ng_cust_list');
  const roleOptions = ['', '운영', '영업'];
  wrap.innerHTML = ngCustContacts.map((c,idx)=>`
    <div class="cust-contact-row" data-idx="${idx}">
      <div class="cc-row-top">
        <select class="cc-role">
          ${roleOptions.map(r=>`<option value="${esc(r)}" ${c.role===r?'selected':''}>${r?esc(r):'구분'}</option>`).join('')}
        </select>
        <input class="cc-name" placeholder="이름" value="${esc(c.name||'')}">
        <button type="button" class="cc-remove-btn" data-remove="${idx}" title="이 담당자 삭제">✕</button>
      </div>
      <div class="cc-row-bottom">
        <input class="cc-org" placeholder="소속" value="${esc(c.org||'')}">
        <input class="cc-phone" placeholder="연락처" value="${esc(c.phone||'')}">
        <input class="cc-email" placeholder="이메일" value="${esc(c.email||'')}">
      </div>
    </div>`).join('');
  wrap.querySelectorAll('[data-remove]').forEach(btn=>{
    btn.onclick = () => {
      captureNgCustContactsFromDom();
      ngCustContacts.splice(Number(btn.dataset.remove),1);
      renderNgCustContactRows();
    };
  });
  updateNgCustAddBtnState();
}

function captureNgCustContactsFromDom(){
  const rows = document.querySelectorAll('#ng_cust_list .cust-contact-row');
  ngCustContacts = Array.from(rows).map(row=>({
    role: row.querySelector('.cc-role').value,
    name: row.querySelector('.cc-name').value.trim(),
    org: row.querySelector('.cc-org').value.trim(),
    phone: row.querySelector('.cc-phone').value.trim(),
    email: row.querySelector('.cc-email').value.trim(),
  }));
}

function updateNgCustAddBtnState(){
  const btn = document.getElementById('ng_cust_add_btn');
  btn.style.display = ngCustContacts.length >= 5 ? 'none' : '';
}

document.getElementById('ng_cust_add_btn').onclick = () => {
  captureNgCustContactsFromDom();
  if (ngCustContacts.length >= 5) return;
  ngCustContacts.push({role:'', name:'', org:'', phone:'', email:''});
  renderNgCustContactRows();
};

function updateNgCustSectionVisibility(){
  const isChildNow = !!document.getElementById('ng_parent_group').value;
  document.getElementById('ng_cust_list').style.display = isChildNow ? 'none' : '';
  document.getElementById('ng_cust_add_btn').style.display = isChildNow ? 'none' : '';
  document.getElementById('ngCustHiddenHint').style.display = isChildNow ? '' : 'none';
}
document.getElementById('ng_parent_group').addEventListener('change', updateNgCustSectionVisibility);

function populateNewGroupParentSelect(){
  const sel = document.getElementById('ng_parent_group');
  const options = allGroupIds()
    .map(g => ({ gid:g, meta: groupMeta(records.filter(r=>r.group===g)) }))
    .filter(o => o.meta.is_parent)
    .map(o => ({ gid:o.gid, owner:o.meta.owner }))
    .sort((a,b) => a.owner.localeCompare(b.owner, 'ko'));
  sel.innerHTML = '<option value="">없음 (독립된 법인)</option>' +
    options.map(o => `<option value="${esc(o.gid)}">${esc(o.owner)}</option>`).join('');
  sel.value = '';
}

function updateNgParentFlagState(){
  const isParent = document.getElementById('ng_is_parent').checked;
  ['ng_support_id','ng_build_engineer','ng_build_date','ng_config_mode'].forEach(id => {
    const el = document.getElementById(id);
    el.disabled = isParent;
    if (isParent) el.value = '';
  });
}
document.getElementById('ng_is_parent').addEventListener('change', updateNgParentFlagState);

function clearAddGroupForm(){
  ['ng_owner','ng_support_id','ng_country','ng_location','ng_build_engineer','ng_build_date',
   'ng_config_mode','ng_owner_primary','ng_owner_secondary','ng_check','ng_remarks'
  ].forEach(id => { document.getElementById(id).value = ''; });
  document.getElementById('ng_is_parent').checked = false;
  const parentSel = document.getElementById('ng_parent_group');
  if (parentSel) parentSel.value = '';
}

function openAddGroupModal(presetParentGid){
  clearAddGroupForm();
  populateNewGroupParentSelect();
  document.getElementById('ng_parent_group').value = '';
  updateNgParentFlagState();
  if (presetParentGid){
    const sel = document.getElementById('ng_parent_group');
    if ([...sel.options].some(o => o.value === presetParentGid)) sel.value = presetParentGid;
  }
  ngCustContacts = [{role:'',name:'',org:'',phone:'',email:''}];
  renderNgCustContactRows();
  updateNgCustSectionVisibility();
  document.getElementById('ngError').textContent = '';
  document.getElementById('addGroupModal').classList.add('open');
}

document.getElementById('cancelNgBtn').onclick = () => {
  document.getElementById('addGroupModal').classList.remove('open');
};

document.getElementById('saveNgBtn').onclick = () => {
  if (viewOnly || !sessionKey){ alert('법인을 추가하려면 먼저 마스터 비밀번호로 잠금을 해제해야 합니다.'); return; }
  const val = id => document.getElementById(id).value.trim();
  const newOwner = val('ng_owner');
  if (!newOwner){ document.getElementById('ngError').textContent = '법인명을 입력해 주세요.'; return; }
  const newBuildDate = val('ng_build_date');
  if (newBuildDate && !/^\d{4}\.(0?[1-9]|1[0-2])$/.test(newBuildDate)){
    document.getElementById('ngError').textContent = '구축 일자는 YYYY.MM 형식으로 입력해 주세요 (예: 2026.07).';
    return;
  }
  const parentGid = document.getElementById('ng_parent_group').value;
  const newIsParent = document.getElementById('ng_is_parent').checked;
  captureNgCustContactsFromDom();
  const contacts = parentGid ? [] : ngCustContacts.filter(c => c.name || c.org || c.phone || c.email).slice(0,5);

  const newId = nextRecordId();
  const gid = makeUniqueGroupId('custom');
  const rec = {
    id:newId, group:gid, is_group_shell:true, flag:'',
    owner:newOwner, country:val('ng_country'), location:val('ng_location'),
    check_method:val('ng_check'), config_mode:val('ng_config_mode'),
    owner_primary:val('ng_owner_primary'), owner_secondary:val('ng_owner_secondary'),
    cust_contacts: contacts, cust_contact:'', cust_phone:'', cust_email:'',
    group_remarks:val('ng_remarks'), group_parent: parentGid, is_parent: newIsParent,
    support_id:val('ng_support_id'), build_engineer:val('ng_build_engineer'), build_date:newBuildDate,
    sku:'', sn:'', qty:'', start:'', end:'', os_ver:'', remarks:'', deploy_date:'', mode:'',
    work_log:[],
  };
  records.push(rec);
  enforceParentsHaveNoDirectAssets();
  expandGroupWithAncestors(gid);
  document.getElementById('addGroupModal').classList.remove('open');
  render();
  buildFilters();
  scheduleAutoSync();
};

// ---------- Support ID 하위 그룹 정보 수정 (Support ID / 구축 엔지니어 / 구축 일자) ----------
let subGroupEditTarget = null;

function openSubGroupEditModal(gid, sid){
  if (!isCurrentUserAdmin()){ alert('마스터만 Support ID 정보를 수정할 수 있습니다.'); return; }
  if (viewOnly || !sessionKey){ alert('Support ID 정보를 수정하려면 먼저 마스터 비밀번호로 잠금을 해제해야 합니다.'); return; }
  const items = records.filter(r => r.group===gid && (r.support_id||'').trim() === sid);
  if (!items.length) return;
  const meta = subGroupMeta(items);
  subGroupEditTarget = { gid, sid };
  document.getElementById('sg_support').value = meta.support_id || '';
  document.getElementById('sg_build_engineer').value = meta.build_engineer || '';
  document.getElementById('sg_build_date').value = meta.build_date || '';
  const groupOwner = groupMeta(records.filter(r=>r.group===gid)).owner;
  document.getElementById('sgHint').textContent =
    `"${groupOwner}" 법인 중 이 Support ID(${sid||'미지정'})를 쓰는 자산 항목 ${items.length}건에 공통으로 적용됩니다.`;
  document.getElementById('sgError').textContent = '';
  document.getElementById('subGroupEditModal').classList.add('open');
}

document.getElementById('cancelSgBtn').onclick = () => {
  document.getElementById('subGroupEditModal').classList.remove('open');
  subGroupEditTarget = null;
};

document.getElementById('saveSgBtn').onclick = () => {
  if (!isCurrentUserAdmin()){ alert('마스터만 Support ID 정보를 수정할 수 있습니다.'); return; }
  if (!subGroupEditTarget) return;
  const val = id => document.getElementById(id).value.trim();
  const newSupport = val('sg_support');
  const newBuildEngineer = val('sg_build_engineer');
  const newBuildDate = val('sg_build_date');
  if (newBuildDate && !/^\d{4}\.(0?[1-9]|1[0-2])$/.test(newBuildDate)){
    document.getElementById('sgError').textContent = '구축 일자는 YYYY.MM 형식으로 입력해 주세요 (예: 2026.07).';
    return;
  }
  const { gid, sid } = subGroupEditTarget;
  records.forEach(r => {
    if (r.group === gid && (r.support_id||'').trim() === sid){
      r.support_id = newSupport;
      r.build_engineer = newBuildEngineer;
      r.build_date = newBuildDate;
    }
  });
  document.getElementById('subGroupEditModal').classList.remove('open');
  subGroupEditTarget = null;
  render();
  buildFilters();
  scheduleAutoSync();
};

// ---------- 자산을 다른 법인으로 이동 ----------
let moveAssetRecIds = [];
let selectedAssetIds = new Set();

function canBulkMove(){
  return isCurrentUserAdmin() && !viewOnly && sessionKey;
}
function canSelectAssets(){
  return canBulkMove() || !!currentUserName();
}

function openMoveAssetModal(recIdOrIds){
  if (!isCurrentUserAdmin()){ alert('마스터만 자산을 다른 법인으로 이동할 수 있습니다.'); return; }
  if (viewOnly || !sessionKey){ alert('자산을 이동하려면 먼저 마스터 비밀번호로 잠금을 해제해야 합니다.'); return; }
  const ids = Array.isArray(recIdOrIds) ? recIdOrIds.map(String) : [String(recIdOrIds)];
  const recs = records.filter(r => ids.includes(String(r.id)));
  if (!recs.length) return;

  const sourceGids = new Set(recs.map(r=>r.group));
  const allGids = [...new Set(records.map(r=>r.group))].filter(gid => groupChildrenOf(gid).length === 0);
  const targetGids = sourceGids.size === 1
    ? allGids.filter(gid => gid !== [...sourceGids][0])
    : allGids;
  if (!targetGids.length){
    alert('이동할 수 있는 다른 법인이 없습니다.');
    return;
  }
  const options = targetGids.map(gid => {
    const gItems = records.filter(r=>r.group===gid);
    const meta = groupMeta(gItems);
    const sids = buildSubGroups(gItems).map(sg=>sg.sid).filter(Boolean);
    const parts = [meta.owner];
    if (sids.length) parts.push(`Support ID: ${sids.join(', ')}`);
    if (meta.location) parts.push(meta.location);
    return { gid, label: parts.join(' · ') };
  }).sort((a,b) => a.label.localeCompare(b.label, 'ko'));

  moveAssetRecIds = ids;
  const sel = document.getElementById('ma_target_group');
  sel.innerHTML = options.map(o => `<option value="${esc(o.gid)}">${esc(o.label)}</option>`).join('');
  document.getElementById('maError').textContent = '';

  const hintEl = document.getElementById('maHint');
  if (recs.length === 1){
    const rec = recs[0];
    const curMeta = groupMeta(records.filter(r=>r.group===rec.group));
    hintEl.textContent =
      `현재 "${curMeta.owner}" 법인에 속한 "${rec.sku || skuTagLabel(rec)}" 항목을 다른 법인으로 옮깁니다. SKU / S/N / 라이선스 기간 / IP·ID·비밀번호 / OS 버전 / 비고 등 자산 고유 정보는 유지됩니다. 대상 법인이 새로 만든 법인이고 Support ID/구축 정보가 미리 지정되어 있으면 그 값을 따르고, 그 외에는 기존 Support ID/구축 정보를 유지합니다.`;
  } else {
    hintEl.textContent =
      `선택한 ${recs.length}개 자산 항목을 한 번에 다른 법인으로 옮깁니다. SKU / S/N / 라이선스 기간 / IP·ID·비밀번호 / OS 버전 / 비고 등 자산 고유 정보는 유지됩니다. 대상 법인이 새로 만든 법인이고 Support ID/구축 정보가 미리 지정되어 있으면 그 값을 따르고, 그 외에는 기존 Support ID/구축 정보를 유지합니다.`;
  }
  document.getElementById('moveAssetModal').classList.add('open');
}

document.getElementById('cancelMaBtn').onclick = () => {
  document.getElementById('moveAssetModal').classList.remove('open');
  moveAssetRecIds = [];
};

document.getElementById('saveMaBtn').onclick = () => {
  if (!isCurrentUserAdmin()){ alert('마스터만 자산을 다른 법인으로 이동할 수 있습니다.'); return; }
  const targetGid = document.getElementById('ma_target_group').value;
  const recs = records.filter(r => moveAssetRecIds.map(String).includes(String(r.id)));
  const errEl = document.getElementById('maError');
  if (!recs.length){ errEl.textContent = '이동할 자산을 찾을 수 없습니다.'; return; }
  if (!targetGid){ errEl.textContent = '이동할 법인을 선택해 주세요.'; return; }
  const targetItems = records.filter(r=>r.group===targetGid);
  if (!targetItems.length){ errEl.textContent = '대상 법인을 찾을 수 없습니다.'; return; }
  const meta = groupMeta(targetItems);

  const confirmMsg = recs.length === 1
    ? `"${recs[0].sku || skuTagLabel(recs[0])}" 항목을 "${meta.owner}" 법인으로 옮길까요?`
    : `선택한 ${recs.length}개 항목을 "${meta.owner}" 법인으로 옮길까요?`;
  if (!confirm(confirmMsg)) return;

  const targetRealItemsBefore = targetItems.filter(r => !r.is_group_shell);
  const targetShell = targetItems.find(r => r.is_group_shell && (r.support_id||'').trim());
  const targetDefaultSupport = (!targetRealItemsBefore.length && targetShell)
    ? {
        support_id:(targetShell.support_id||'').trim(),
        build_engineer:targetShell.build_engineer||'',
        build_date:targetShell.build_date||''
      }
    : null;

  for (const rec of recs){
    rec.group = targetGid;
    rec.flag = meta.flag;
    rec.owner = meta.owner;
    rec.country = meta.country;
    rec.location = meta.location;
    rec.check_method = meta.check_method;
    rec.config_mode = meta.config_mode;
    rec.owner_primary = meta.owner_primary;
    rec.owner_secondary = meta.owner_secondary;
    rec.cust_contacts = JSON.parse(JSON.stringify(meta.cust_contacts || []));
    rec.cust_memo = meta.cust_memo || '';
    rec.cust_contact = ''; rec.cust_phone = ''; rec.cust_email = '';
    rec.group_remarks = meta.group_remarks;
    rec.group_parent = meta.group_parent;
    if (targetDefaultSupport){
      rec.support_id = targetDefaultSupport.support_id;
      rec.build_engineer = targetDefaultSupport.build_engineer;
      rec.build_date = targetDefaultSupport.build_date;
    }
    selectedAssetIds.delete(String(rec.id));
  }

  expandGroupWithAncestors(targetGid);
  document.getElementById('moveAssetModal').classList.remove('open');
  moveAssetRecIds = [];
  render();
  buildFilters();
  scheduleAutoSync();
};

function deleteGroup(gid){
  if (!isCurrentUserAdmin()){ alert('마스터만 법인을 삭제할 수 있습니다.'); return; }
  if (viewOnly || !sessionKey){ alert('법인 정보를 삭제하려면 먼저 마스터 비밀번호로 잠금을 해제해야 합니다.'); return; }
  const items = records.filter(r=>r.group===gid);
  if (!items.length) return;
  const meta = groupMeta(items);
  const realCount = items.filter(r=>!r.is_group_shell).length;
  if (!confirm(`"${meta.owner}" 법인을 삭제하시겠습니까? 실제 자산 ${realCount}건이 함께 삭제됩니다.`)) return;
  records.forEach(r => { if (r.group_parent === gid) r.group_parent = ''; });
  records = records.filter(r=>r.group!==gid);
  expandedGroups.delete(gid);
  render();
  buildFilters();
  scheduleAutoSync();
}

function duplicateGroup(gid){
  if (!isCurrentUserAdmin()){ alert('마스터만 법인을 복제할 수 있습니다.'); return; }
  const items = records.filter(r=>r.group===gid);
  if (!items.length) return;
  const meta = groupMeta(items);
  const realCount = items.filter(r=>!r.is_group_shell).length;
  if (!confirm(`"${meta.owner}" 법인을 복제해서 독립된 새 법인으로 추가할까요? 실제 자산 ${realCount}건이 함께 복사됩니다.`)) return;

  let nextId = nextRecordId();
  const newGid = makeUniqueGroupId('dup');
  const newOwnerName = meta.owner + ' (사본)';
  const newRecords = items.map(r => {
    const copy = JSON.parse(JSON.stringify(r));
    copy.id = nextId++;
    copy.group = newGid;
    copy.owner = newOwnerName;
    copy.group_parent = '';
    copy.is_parent = false;
    return copy;
  });

  let insertAt = records.length;
  for (let i = records.length - 1; i >= 0; i--){
    if (records[i].group === gid){ insertAt = i + 1; break; }
  }
  records.splice(insertAt, 0, ...newRecords);
  expandGroupWithAncestors(newGid);

  render();
  buildFilters();
  scheduleAutoSync();

  if (!viewOnly && sessionKey){
    openGroupEditModal(newGid);
  } else {
    alert(`"${newOwnerName}" 법인이 바로 아래에 추가되었습니다.\n마스터 비밀번호로 잠금 해제 후 "법인 정보 수정"(연필 아이콘)에서 값을 필요한 대로 고쳐 주세요.`);
  }
}

// ---------- users (각자 계정으로 로그인해서 작업 이력 작성자를 기록) ----------
const CURRENT_USER_KEY = 'bcAssetCurrentUserId';
let currentUserId = null;
try{ currentUserId = localStorage.getItem(CURRENT_USER_KEY) || null; }catch(e){ currentUserId = null; }
let agLoginPromptUserId = null;
let agLoginPromptMode = 'login';

function saveCurrentUserId(id){
  try{ if (id) localStorage.setItem(CURRENT_USER_KEY, id); else localStorage.removeItem(CURRENT_USER_KEY); }catch(e){}
}
function currentUserName(){
  const u = users.find(x=>String(x.id)===String(currentUserId));
  return u ? u.name : '';
}
function isCurrentUserAdmin(){
  const u = users.find(x=>String(x.id)===String(currentUserId));
  return !!(u && u.isAdmin);
}

/* =========================================================
   감사 이력 - 모든 사용자 추가/편집/삭제 기록
   ========================================================= */
let suppressAuditCapture = false;

function auditClone(v){
  return v == null ? v : JSON.parse(JSON.stringify(v));
}

function auditSnapshotState(){
  return {
    records: auditClone(records || []),
    users: auditClone(users || []),
    maintenanceLogs: auditClone(maintenanceLogs || [])
  };
}

function refreshAuditSnapshot(){
  auditSnapshot = auditSnapshotState();
}

function auditActor(){
  const u = users.find(x => String(x.id) === String(currentUserId));
  return {
    id: u ? String(u.id) : '',
    name: u ? u.name : '미상',
    role: u && u.isAdmin ? '마스터' : '일반사용자'
  };
}

function auditDateText(ts){
  const d = new Date(ts);
  return `${d.getFullYear()}.${d.getMonth()+1}.${d.getDate()} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}`;
}

function auditSafeValue(field, value){
  const sensitive = ['ip_enc','id_enc','pw_enc','enable_pw_enc','pwHash','pwSalt','pwIterations'];
  if (sensitive.includes(field)) return value ? '변경됨' : '—';
  if (value === null || value === undefined || value === '') return '—';
  if (Array.isArray(value)){
    return value.map(v => {
      if (v && typeof v === 'object'){
        const bits = [v.role, v.name, v.org, v.phone, v.email].filter(Boolean);
        return bits.join(' / ');
      }
      return String(v);
    }).filter(Boolean).join(', ') || '—';
  }
  if (typeof value === 'object') return '변경됨';
  return String(value);
}

const AUDIT_FIELD_LABELS = {
  owner:'법인명', country:'국가', location:'위치', support_id:'Support ID',
  build_engineer:'구축 엔지니어', build_date:'구축 일자', check_method:'점검 방식', config_mode:'구성방식',
  owner_primary:'담당 엔지니어(정)', owner_secondary:'담당 엔지니어(부)', group_remarks:'법인 비고',
  group_parent:'상위 법인', is_parent:'상위 법인 여부', cust_contacts:'고객사 담당자', cust_memo:'고객사 담당자 메모',
  sku:'SKU', sn:'S/N', qty:'수량', start:'라이선스 시작일', end:'라이선스 종료일', os_ver:'OS 버전', remarks:'자산 비고',
  asset_order:'자산 순서', group:'소속 법인', ip_enc:'IP 주소', id_enc:'계정 ID', pw_enc:'비밀번호', enable_pw_enc:'Enable 비밀번호',
  date:'점검일', manager:'점검 담당자', note:'점검 내용', done:'완료', incomplete:'미완료', uncontracted:'미계약', ym:'점검 월',
  name:'사용자 이름', isAdmin:'마스터 권한', pwHash:'비밀번호', pwSalt:'비밀번호', pwIterations:'비밀번호'
};

function auditFieldChanges(before, after, ignoreFields=[]){
  const ignore = new Set(ignoreFields);
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  const out = [];
  keys.forEach(field => {
    if (ignore.has(field)) return;
    const a = before ? before[field] : undefined;
    const b = after ? after[field] : undefined;
    if (JSON.stringify(a ?? null) === JSON.stringify(b ?? null)) return;
    out.push({
      field,
      label: AUDIT_FIELD_LABELS[field] || field,
      before: auditSafeValue(field, a),
      after: auditSafeValue(field, b),
      sensitive: ['ip_enc','id_enc','pw_enc','enable_pw_enc','pwHash','pwSalt','pwIterations'].includes(field)
    });
  });
  return out;
}

function addAuditLog({action, targetType, targetId='', group='', owner='', label='', sn='', summary='', changes=[], actorName='', actorRole='', actorId=''}){
  const actor = actorName
    ? {id:String(actorId || ''), name:actorName, role:actorRole || '일반사용자'}
    : auditActor();
  const now = Date.now();
  auditLogs.push({
    id:`audit-${now}-${Math.random().toString(36).slice(2,8)}`,
    ts:now,
    action,
    target_type:targetType,
    target_id:String(targetId || ''),
    group:String(group || ''),
    owner:String(owner || ''),
    label:String(label || ''),
    sn:String(sn || ''),
    summary:String(summary || ''),
    changes:(changes || []).map(c => ({...c})),
    actor_id:actor.id,
    actor_name:actor.name,
    actor_role:actor.role
  });
}

function recordAuditIdentity(rec){
  return {
    group:rec?.group || '',
    owner:rec?.owner || '',
    label:rec?.sku || rec?.owner || '',
    sn:rec?.sn || ''
  };
}

function captureAuditFromStateDiff(){
  if (suppressAuditCapture){ refreshAuditSnapshot(); return; }
  if (!auditSnapshot){ refreshAuditSnapshot(); return; }

  const before = auditSnapshot;
  const after = auditSnapshotState();
  const seen = new Set();
  const pushUnique = (sig, log) => {
    if (seen.has(sig)) return;
    seen.add(sig);
    addAuditLog(log);
  };

  const oldRecords = new Map((before.records || []).map(r => [String(r.id), r]));
  const newRecords = new Map((after.records || []).map(r => [String(r.id), r]));

  const oldGroupIds = new Set((before.records || []).map(r => String(r.group || '')).filter(Boolean));
  const newGroupIds = new Set((after.records || []).map(r => String(r.group || '')).filter(Boolean));
  [...newGroupIds].filter(gid => !oldGroupIds.has(gid)).forEach(gid => {
    const rec = (after.records || []).find(r => String(r.group) === gid) || {};
    pushUnique(`add|법인|${gid}`, {
      action:'add', targetType:'법인', targetId:gid, group:gid,
      owner:rec.owner || '', label:rec.owner || '',
      summary:`법인 추가 · ${rec.owner || '이름 미지정'}`
    });
  });
  [...oldGroupIds].filter(gid => !newGroupIds.has(gid)).forEach(gid => {
    const rec = (before.records || []).find(r => String(r.group) === gid) || {};
    pushUnique(`delete|법인|${gid}`, {
      action:'delete', targetType:'법인', targetId:gid, group:gid,
      owner:rec.owner || '', label:rec.owner || '',
      summary:`법인 삭제 · ${rec.owner || '이름 미지정'}`
    });
  });

  const ids = new Set([...oldRecords.keys(), ...newRecords.keys()]);
  ids.forEach(id => {
    const a = oldRecords.get(id);
    const b = newRecords.get(id);
    if (!a && b){
      const ident = recordAuditIdentity(b);
      const targetType = b.is_group_shell ? '법인' : '자산';
      pushUnique(`add|${targetType}|${targetType==='법인'?b.group:id}`, {
        action:'add', targetType, targetId:targetType==='법인'?b.group:id,
        group:ident.group, owner:ident.owner, label:ident.label, sn:ident.sn,
        summary: targetType === '법인' ? `법인 추가 · ${ident.owner || '이름 미지정'}` : `자산 추가 · ${ident.label || 'SKU 미지정'}${ident.sn ? ` · S/N ${ident.sn}` : ''}`
      });
      return;
    }
    if (a && !b){
      const ident = recordAuditIdentity(a);
      const targetType = a.is_group_shell ? '법인' : '자산';
      pushUnique(`delete|${targetType}|${targetType==='법인'?a.group:id}`, {
        action:'delete', targetType, targetId:targetType==='법인'?a.group:id,
        group:ident.group, owner:ident.owner, label:ident.label, sn:ident.sn,
        summary: targetType === '법인' ? `법인 삭제 · ${ident.owner || '이름 미지정'}` : `자산 삭제 · ${ident.label || 'SKU 미지정'}${ident.sn ? ` · S/N ${ident.sn}` : ''}`
      });
      return;
    }
    if (!a || !b) return;

    const changes = auditFieldChanges(a,b,['work_log','deleted_work_log','id','is_group_shell','flag','deploy_date','mode']);
    if (!changes.length) return;
    const workLogChanged = JSON.stringify(a.work_log || []) !== JSON.stringify(b.work_log || []) ||
      JSON.stringify(a.deleted_work_log || []) !== JSON.stringify(b.deleted_work_log || []);
    const worklogAssetFields = new Set(['start','end','os_ver','remarks','ip_enc','id_enc','pw_enc','enable_pw_enc']);
    if (workLogChanged && changes.every(c => worklogAssetFields.has(c.field))) return;
    const fields = new Set(changes.map(c => c.field));
    const ident = recordAuditIdentity(b);
    let action = 'edit';
    let targetType = b.is_group_shell ? '법인' : '자산';
    let targetId = b.is_group_shell ? b.group : b.id;
    let summary = '';

    if (fields.has('group')){
      action = 'move'; targetType = '자산';
      summary = `자산 이동 · ${a.owner || a.group || '이전 법인'} → ${b.owner || b.group || '새 법인'}`;
    } else if ([...fields].every(f => ['asset_order'].includes(f))){
      action = 'reorder'; targetType = '자산';
      summary = `자산 순서 변경 · ${ident.label || '자산'}`;
    } else if ([...fields].every(f => ['support_id','build_engineer','build_date'].includes(f))){
      targetType = 'Support ID'; targetId = `${b.group}:${b.support_id || a.support_id || ''}`;
      summary = `Support ID 정보 ${changes.length}개 항목 수정`;
    } else if ([...fields].every(f => ['owner','country','location','check_method','config_mode','owner_primary','owner_secondary','group_remarks','group_parent','is_parent','cust_contacts','cust_memo'].includes(f))){
      targetType = '법인'; targetId = b.group;
      summary = `법인 정보 ${changes.length}개 항목 수정`;
    } else {
      summary = `자산 정보 ${changes.length}개 항목 수정`;
    }

    const sig = `${action}|${targetType}|${targetId}|${changes.map(c=>`${c.field}:${c.before}->${c.after}`).join('|')}`;
    pushUnique(sig, { action, targetType, targetId, group:ident.group, owner:ident.owner, label:ident.label, sn:ident.sn, summary, changes });
  });

  const maintKey = m => String(m.id || `${m.group}|${m.ym}`);
  const oldMaint = new Map((before.maintenanceLogs || []).map(m => [maintKey(m),m]));
  const newMaint = new Map((after.maintenanceLogs || []).map(m => [maintKey(m),m]));
  const maintIds = new Set([...oldMaint.keys(),...newMaint.keys()]);
  maintIds.forEach(id => {
    const a=oldMaint.get(id), b=newMaint.get(id);
    const cur=b||a;
    const groupItems = records.filter(r => r.group === cur?.group);
    const owner = groupItems.length ? groupMeta(groupItems).owner : '';
    if (!a && b){
      addAuditLog({action:'add',targetType:'유지보수 점검',targetId:id,group:b.group,owner,label:b.ym,summary:`${ymLabel(b.ym)} 유지보수 점검 등록`});
    } else if (a && !b){
      addAuditLog({action:'delete',targetType:'유지보수 점검',targetId:id,group:a.group,owner,label:a.ym,summary:`${ymLabel(a.ym)} 유지보수 점검 삭제`});
    } else if (a && b){
      const changes=auditFieldChanges(a,b,['id','group','ym','created_at','updated_at']);
      if (changes.length) addAuditLog({action:'edit',targetType:'유지보수 점검',targetId:id,group:b.group,owner,label:b.ym,summary:`${ymLabel(b.ym)} 유지보수 점검 수정`,changes});
    }
  });

  const oldUsers = new Map((before.users || []).map(u => [String(u.id),u]));
  const newUsers = new Map((after.users || []).map(u => [String(u.id),u]));
  const userIds = new Set([...oldUsers.keys(),...newUsers.keys()]);
  userIds.forEach(id => {
    const a=oldUsers.get(id), b=newUsers.get(id);
    if (!a && b){
      addAuditLog({action:'add',targetType:'사용자 계정',targetId:id,label:b.name,summary:`사용자 계정 추가 · ${b.name}${b.isAdmin?' · 마스터':''}`});
    } else if (a && !b){
      addAuditLog({action:'delete',targetType:'사용자 계정',targetId:id,label:a.name,summary:`사용자 계정 삭제 · ${a.name}`,actorName:a.name,actorRole:a.isAdmin?'마스터':'일반사용자',actorId:a.id});
    } else if (a && b){
      const changes=auditFieldChanges(a,b,['id']);
      if (changes.length){
        const pwChanged=changes.some(c=>['pwHash','pwSalt','pwIterations'].includes(c.field));
        const visible=changes.filter(c=>!['pwSalt','pwIterations'].includes(c.field));
        addAuditLog({action:'edit',targetType:'사용자 계정',targetId:id,label:b.name,summary:pwChanged?`사용자 비밀번호 변경 · ${b.name}`:`사용자 계정 ${visible.length}개 항목 수정 · ${b.name}`,changes:visible,actorName:b.name,actorRole:b.isAdmin?'마스터':'일반사용자',actorId:b.id});
      }
    }
  });

  auditSnapshot = after;
}
function updateSidebarProfile(){
  const nameEl = document.getElementById('profileName');
  const subEl = document.getElementById('profileSub');
  if (!nameEl) return;
  const name = currentUserName();
  nameEl.textContent = name || '로그인 필요';
  if (subEl){
    const isAdmin = isCurrentUserAdmin();
    subEl.textContent = isAdmin ? '👑 마스터' : '';
    subEl.style.display = isAdmin ? '' : 'none';
  }
}
function updateUserBtnLabel(){ updateSidebarProfile(); }

// ---------- 계정 게이트 (앱 진입 전 1단계 로그인 화면) ----------
function showMasterGate(){
  document.getElementById('accountGateCard').style.display = 'none';
  const masterCard = document.getElementById('masterGateCard');
  masterCard.style.display = 'block';
  const p = document.getElementById('passInput');
  if (p) p.focus();
}

async function proceedPastAccountGate(){
  await dataReady;
  const ok = await tryUnlockFromCache();
  if (ok){
    viewOnly = false;
    boot();
  } else {
    showMasterGate();
  }
}

function renderAccountGateUserList(){
  const wrap = document.getElementById('ag_user_list');
  if (!wrap) return;
  if (!users.length){
    wrap.innerHTML = `<div class="user-list-empty">등록된 계정이 없습니다. 아래 "새 계정 만들기"에서 계정을 만드세요.</div>`;
    return;
  }
  wrap.innerHTML = users.map(u => {
    const isPrompting = String(u.id)===String(agLoginPromptUserId);
    const isDeleteMode = isPrompting && agLoginPromptMode === 'delete';
    const isChangePwMode = isPrompting && agLoginPromptMode === 'changepw';
    return `
    <div class="user-row">
      <div class="user-row-main">
        <span class="user-name">${esc(u.name)}</span>
        ${isPrompting
          ? `<button type="button" class="wl-action-btn" data-ag-cancel="${u.id}">취소</button>`
          : `<button type="button" class="wl-action-btn" data-ag-login="${u.id}">로그인</button>
             <button type="button" class="wl-action-btn" data-ag-changepw="${u.id}" title="비밀번호 변경">비밀번호 변경</button>
             <button type="button" class="wl-action-btn danger" data-ag-delete="${u.id}" title="이 계정 삭제">삭제</button>`}
      </div>
      ${isPrompting ? `
      ${isDeleteMode ? `<p class="user-delete-hint">계정을 삭제하려면 본인 비밀번호를 입력해 확인하세요. 이 작업은 되돌릴 수 없습니다.</p>` : ''}
      ${isChangePwMode ? `<p class="user-changepw-hint">현재 비밀번호를 확인한 뒤 새 비밀번호로 바꿉니다.</p>` : ''}
      <form class="user-login-form${isChangePwMode ? ' user-changepw-form' : ''}" data-ag-login-form="${u.id}">
        <input type="password" class="user-login-pass" placeholder="${isChangePwMode ? '현재 비밀번호' : '비밀번호'}" autocomplete="current-password">
        ${isChangePwMode ? `
        <input type="password" class="user-newpass" placeholder="새 비밀번호 (4자 이상)" autocomplete="new-password">
        <input type="password" class="user-newpass2" placeholder="새 비밀번호 확인" autocomplete="new-password">
        ` : ''}
        <button type="submit" class="btn ${isDeleteMode ? 'btn-danger' : 'btn-primary'}">${isDeleteMode ? '삭제 확인' : isChangePwMode ? '비밀번호 변경' : '확인'}</button>
      </form>
      <div class="user-login-error" id="agLoginError_${u.id}"></div>` : ''}
    </div>`;
  }).join('');

  wrap.querySelectorAll('[data-ag-login]').forEach(btn=>{
    btn.onclick = () => {
      agLoginPromptUserId = btn.dataset.agLogin;
      agLoginPromptMode = 'login';
      renderAccountGateUserList();
      const form = wrap.querySelector(`[data-ag-login-form="${CSS.escape(agLoginPromptUserId)}"]`);
      if (form) form.querySelector('.user-login-pass').focus();
    };
  });
  wrap.querySelectorAll('[data-ag-delete]').forEach(btn=>{
    btn.onclick = () => {
      agLoginPromptUserId = btn.dataset.agDelete;
      agLoginPromptMode = 'delete';
      renderAccountGateUserList();
      const form = wrap.querySelector(`[data-ag-login-form="${CSS.escape(agLoginPromptUserId)}"]`);
      if (form) form.querySelector('.user-login-pass').focus();
    };
  });
  wrap.querySelectorAll('[data-ag-changepw]').forEach(btn=>{
    btn.onclick = () => {
      agLoginPromptUserId = btn.dataset.agChangepw;
      agLoginPromptMode = 'changepw';
      renderAccountGateUserList();
      const form = wrap.querySelector(`[data-ag-login-form="${CSS.escape(agLoginPromptUserId)}"]`);
      if (form) form.querySelector('.user-login-pass').focus();
    };
  });
  wrap.querySelectorAll('[data-ag-cancel]').forEach(btn=>{
    btn.onclick = () => { agLoginPromptUserId = null; agLoginPromptMode = 'login'; renderAccountGateUserList(); };
  });
  wrap.querySelectorAll('[data-ag-login-form]').forEach(form=>{
    form.onsubmit = async (e) => {
      e.preventDefault();
      const uid = form.dataset.agLoginForm;
      const u = users.find(x=>String(x.id)===String(uid));
      const passInput = form.querySelector('.user-login-pass');
      const errEl = document.getElementById('agLoginError_' + uid);
      const pass = passInput.value;
      if (!u) return;
      if (!pass){ errEl.textContent = '비밀번호를 입력해 주세요.'; return; }
      if (!u.pwHash){ errEl.textContent = '이 계정에는 비밀번호가 설정되어 있지 않습니다.'; return; }
      errEl.textContent = '확인 중…';
      const hash = await hashPassword(pass, u.pwSalt, u.pwIterations);
      if (hash !== u.pwHash){ errEl.textContent = '비밀번호가 올바르지 않습니다.'; passInput.value=''; passInput.focus(); return; }

      if (agLoginPromptMode === 'delete'){
        const isLastAdmin = u.isAdmin && users.filter(x=>x.isAdmin).length <= 1;
        const warnMsg = isLastAdmin
          ? `"${u.name}" 계정은 마지막 남은 관리자 계정입니다. 그래도 삭제할까요?\n삭제 후에는 이 계정으로 남긴 작업 이력에 작성자 이름만 기록으로 남고, 다시 로그인할 수 없습니다.`
          : `"${u.name}" 계정을 삭제할까요?\n삭제 후에는 이 계정으로 남긴 작업 이력에 작성자 이름만 기록으로 남고, 다시 로그인할 수 없습니다.`;
        if (!confirm(warnMsg)){ passInput.value=''; return; }
        deleteAccount(uid);
        return;
      }

      if (agLoginPromptMode === 'changepw'){
        const newPassInput = form.querySelector('.user-newpass');
        const newPass2Input = form.querySelector('.user-newpass2');
        const newPass = newPassInput.value;
        const newPass2 = newPass2Input.value;
        if (!newPass || newPass.length < 4){ errEl.textContent = '새 비밀번호는 4자 이상이어야 합니다.'; return; }
        if (newPass !== newPass2){ errEl.textContent = '새 비밀번호가 서로 일치하지 않습니다.'; newPass2Input.value=''; newPass2Input.focus(); return; }
        if (newPass === pass){ errEl.textContent = '현재 비밀번호와 다른 비밀번호를 입력해 주세요.'; return; }
        errEl.textContent = '변경 중…';
        await changeAccountPassword(uid, newPass);
        return;
      }

      currentUserId = uid;
      saveCurrentUserId(uid);
      agLoginPromptUserId = null;
      await proceedPastAccountGate();
    };
  });
}

// 비밀번호 변경: 현재 비밀번호로 본인 확인이 끝난 뒤 호출됨. 새 salt를 생성해서 다시 해시한다.
async function changeAccountPassword(uid, newPass){
  const u = users.find(x=>String(x.id)===String(uid));
  if (!u) return;
  const pwSalt = bufToB64(crypto.getRandomValues(new Uint8Array(16)).buffer);
  const pwIterations = 150000;
  const pwHash = await hashPassword(newPass, pwSalt, pwIterations);
  u.pwSalt = pwSalt;
  u.pwIterations = pwIterations;
  u.pwHash = pwHash;
  agLoginPromptUserId = null;
  agLoginPromptMode = 'login';
  scheduleAutoSync();
  renderAccountGateUserList();
  alert(`"${u.name}" 계정의 비밀번호가 변경되었습니다. 새 비밀번호로 로그인해 주세요.`);
}

function deleteAccount(uid){
  users = users.filter(x=>String(x.id)!==String(uid));
  if (String(currentUserId)===String(uid)){
    currentUserId = null;
    saveCurrentUserId(null);
  }
  agLoginPromptUserId = null;
  agLoginPromptMode = 'login';
  scheduleAutoSync();
  renderAccountGateUserList();
  updateSidebarProfile();
}

document.getElementById('ag_toggle_btn').onclick = () => {
  const loginView = document.getElementById('agLoginView');
  const regView = document.getElementById('agRegisterView');
  const goingToRegister = regView.style.display === 'none';
  loginView.style.display = goingToRegister ? 'none' : 'block';
  regView.style.display = goingToRegister ? 'block' : 'none';
  document.getElementById('ag_toggle_btn').textContent = goingToRegister ? '이미 계정이 있어요' : '새 계정 만들기';
  document.getElementById('agRegisterError').textContent = '';
};

document.getElementById('ag_register_btn').onclick = async () => {
  const errEl = document.getElementById('agRegisterError');
  errEl.textContent = '데이터 불러오는 중…';
  await dataReady;
  if (!ENC_STORE){ errEl.textContent = 'data.json을 불러오지 못했습니다. 로컬 웹서버로 열어주세요.'; return; }
  const nameInput = document.getElementById('ag_reg_name');
  const passInput = document.getElementById('ag_reg_pass');
  const pass2Input = document.getElementById('ag_reg_pass2');
  const name = nameInput.value.trim();
  const pass = passInput.value;
  const pass2 = pass2Input.value;
  errEl.textContent = '';
  if (!name){ errEl.textContent = '이름을 입력해 주세요.'; return; }
  if (users.some(u=>u.name===name)){ errEl.textContent = '이미 같은 이름의 계정이 있습니다.'; return; }
  if (!pass || pass.length < 4){ errEl.textContent = '비밀번호는 4자 이상으로 설정해 주세요.'; return; }
  if (pass !== pass2){ errEl.textContent = '비밀번호가 일치하지 않습니다.'; return; }

  errEl.textContent = '계정 생성 중…';
  const id = 'u' + Date.now();
  const pwSalt = bufToB64(crypto.getRandomValues(new Uint8Array(16)).buffer);
  const pwIterations = 150000;
  const pwHash = await hashPassword(pass, pwSalt, pwIterations);
  const isAdmin = users.length === 0;
  users.push({ id, name, pwSalt, pwIterations, pwHash, isAdmin });

  currentUserId = id;
  saveCurrentUserId(id);
  scheduleAutoSync();

  nameInput.value = ''; passInput.value = ''; pass2Input.value = '';
  errEl.textContent = '';
  await proceedPastAccountGate();
};

document.getElementById('ag_user_list').innerHTML = `<div class="user-list-empty">계정 목록을 불러오는 중…</div>`;
dataReady.then(() => { refreshAuditSnapshot(); renderAccountGateUserList(); });

dataReady.then(() => {
  if (currentUserId && users.some(u=>String(u.id)===String(currentUserId))){
    proceedPastAccountGate();
  }
});

// ---------- 로그아웃 (좌측 패널) ----------
document.getElementById('logoutBtn').onclick = () => {
  if (!confirm('로그아웃할까요? 다시 사용하려면 계정 비밀번호로 로그인해야 합니다.')) return;
  saveCurrentUserId(null);
  location.reload();
};


// ---------- recent activity (최근 작업 이력 알림) ----------
function dismissedActivityKey(){
  return 'bcAssetDismissedActivity_' + (currentUserId || 'anon');
}
function getDismissedActivity(){
  try{
    const raw = localStorage.getItem(dismissedActivityKey());
    return new Set(raw ? JSON.parse(raw) : []);
  }catch(e){ return new Set(); }
}
function dismissActivity(key){
  const set = getDismissedActivity();
  set.add(key);
  try{ localStorage.setItem(dismissedActivityKey(), JSON.stringify([...set])); }catch(e){}
}
function activityKeyOf(recId, entryId){
  return recId + ':' + entryId;
}

function getRecentWorkLogEntries(limit){
  const dismissed = getDismissedActivity();
  const all = [];
  records.forEach(r => {
    (r.work_log||[]).forEach(entry => {
      const key = activityKeyOf(r.id, entry.id);
      if (dismissed.has(key)) return;
      all.push({ entry, recId:r.id, recGroup:r.group, recOwner:r.owner, recLabel:r.sku || skuTagLabel(r), key });
    });
  });
  all.sort((a,b) => (b.entry.id||0) - (a.entry.id||0));
  return all.slice(0, limit);
}

// ---------- 작업 이력 / 사용자 변경 전체보기 페이지 ----------
let whSearch = '';
let whTypeFilter = '';
let whSort = 'desc';
let whSelectedKeys = new Set();

function auditActionLabel(action){
  return ({add:'추가', edit:'편집', delete:'삭제', move:'이동', reorder:'순서 변경'})[action] || action || '변경';
}

function getAllWorkLogEntries(){
  const all = [];

  records.forEach(r => {
    (r.work_log||[]).forEach(entry => {
      all.push({
        source:'worklog', entry,
        recId:r.id, recGroup:r.group, recOwner:r.owner,
        recLabel:r.sku || skuTagLabel(r), recSn:r.sn||'',
        key:activityKeyOf(r.id, entry.id), deleted:false,
        historyTs:Number(entry.updated_at || entry.id || 0)
      });
    });

    (r.deleted_work_log||[]).forEach(entry => {
      all.push({
        source:'deleted', entry,
        recId:r.id, recGroup:r.group, recOwner:r.owner,
        recLabel:r.sku || skuTagLabel(r), recSn:r.sn||'',
        key:`deleted:${r.id}:${entry.history_id || entry.deleted_at || entry.id}`,
        deleted:true,
        historyTs:Number(entry.deleted_at || entry.history_id || entry.id || 0)
      });
    });
  });

  (auditLogs || []).forEach(audit => {
    const changeSummary = (audit.changes || []).map(c =>
      c.sensitive ? `${c.label} 변경됨` : `${c.label}: ${c.before || '—'} → ${c.after || '—'}`
    ).join(' · ');
    const actionText = auditActionLabel(audit.action);
    all.push({
      source:'audit',
      auditId:audit.id,
      entry:{
        id:audit.ts,
        type:`${audit.target_type} ${actionText}`,
        date:auditDateText(audit.ts),
        manager:audit.actor_name,
        author:`${audit.actor_name || '미상'} · ${audit.actor_role || '일반사용자'}`,
        note:audit.summary || `${audit.target_type} ${actionText}`,
        change_summary:changeSummary,
        audit_action:audit.action,
        audit_role:audit.actor_role
      },
      recId:audit.target_type === '자산' ? audit.target_id : '',
      recGroup:audit.group || '',
      recOwner:audit.owner || '',
      recLabel:audit.label || audit.target_type || '',
      recSn:audit.sn || '',
      key:`audit:${audit.id}`,
      deleted:false,
      historyTs:Number(audit.ts || 0)
    });
  });

  return all;
}

function whAllTypes(){
  const set = new Set();
  getAllWorkLogEntries().forEach(({entry}) => { if (entry.type) set.add(entry.type); });
  return [...set].sort((a,b)=>a.localeCompare(b,'ko'));
}

function renderWorkHistoryPage(){
  const wrap = document.getElementById('workHistoryView');
  if (!wrap) return;

  const types = whAllTypes();
  const total = getAllWorkLogEntries().length;

  wrap.innerHTML = `
    <div class="maint-sticky-top">
      <div class="maint-header">
        <div class="maint-header-row"><h2>작업 이력 전체보기</h2></div>
        <p class="maint-sub">작업 이력과 마스터/일반사용자의 추가·편집·삭제 기록을 한 곳에서 확인합니다 · 총 ${total}건</p>
      </div>
      <div class="wh-toolbar">
        <div class="tf-search wh-search">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
          <input type="text" id="whSearchInput" placeholder="법인·자산·사용자·내용으로 검색" value="${esc(whSearch)}">
        </div>
        <select id="whTypeSelect" class="wh-select">
          <option value="">전체 구분</option>
          ${types.map(t=>`<option value="${esc(t)}" ${whTypeFilter===t?'selected':''}>${esc(t)}</option>`).join('')}
        </select>
        <select id="whSortSelect" class="wh-select">
          <option value="desc" ${whSort==='desc'?'selected':''}>최신순</option>
          <option value="asc" ${whSort==='asc'?'selected':''}>오래된순</option>
        </select>
        ${isCurrentUserAdmin() ? `
          <div class="wh-admin-actions">
            <label class="wh-select-all"><input type="checkbox" id="whSelectAll"><span>전체 선택</span></label>
            <span class="wh-selected-count" id="whSelectedCount">0건 선택</span>
            <button type="button" class="btn wh-delete-selected" id="whDeleteSelected" disabled>선택 삭제</button>
          </div>` : ''}
      </div>
    </div>
    <div class="wh-list" id="whListEl"></div>`;

  document.getElementById('whSearchInput').oninput = (e) => { whSearch = e.target.value; renderWhList(); };
  document.getElementById('whTypeSelect').onchange = (e) => { whTypeFilter = e.target.value; renderWhList(); };
  document.getElementById('whSortSelect').onchange = (e) => { whSort = e.target.value; renderWhList(); };

  if (isCurrentUserAdmin()){
    const selectAll = document.getElementById('whSelectAll');
    const deleteBtn = document.getElementById('whDeleteSelected');
    if (selectAll){
      selectAll.onchange = () => {
        document.querySelectorAll('.wh-history-checkbox').forEach(box => {
          box.checked = selectAll.checked;
          const key = box.dataset.whSelect;
          if (selectAll.checked) whSelectedKeys.add(key); else whSelectedKeys.delete(key);
        });
        updateWhSelectionUi();
      };
    }
    if (deleteBtn) deleteBtn.onclick = deleteSelectedWorkHistory;
  }

  renderWhList();
}

function updateWhSelectionUi(){
  if (!isCurrentUserAdmin()) return;
  const countEl = document.getElementById('whSelectedCount');
  const deleteBtn = document.getElementById('whDeleteSelected');
  const selectAll = document.getElementById('whSelectAll');
  const boxes = [...document.querySelectorAll('.wh-history-checkbox')];
  if (countEl) countEl.textContent = `${whSelectedKeys.size}건 선택`;
  if (deleteBtn) deleteBtn.disabled = whSelectedKeys.size === 0;
  if (selectAll){
    const checked = boxes.filter(box => box.checked).length;
    selectAll.checked = boxes.length > 0 && checked === boxes.length;
    selectAll.indeterminate = checked > 0 && checked < boxes.length;
  }
}

function renderWhList(){
  const listEl = document.getElementById('whListEl');
  if (!listEl) return;

  let items = getAllWorkLogEntries();
  if (whTypeFilter) items = items.filter(({entry}) => entry.type === whTypeFilter);
  if (whSearch.trim()){
    const q = whSearch.trim().toLowerCase();
    items = items.filter(({entry, recOwner, recLabel, recSn, deleted, source}) =>
      [recOwner, recLabel, recSn, entry.manager, entry.author, entry.note, entry.type, entry.deleted_by,
       deleted ? '삭제 삭제됨' : '', source === 'audit' ? '사용자 변경 감사 이력' : '']
        .some(v => (v||'').toLowerCase().includes(q))
    );
  }
  items.sort((a,b) => whSort === 'desc' ? (b.historyTs||0)-(a.historyTs||0) : (a.historyTs||0)-(b.historyTs||0));

  listEl.innerHTML = items.length ? items.map(item => {
    const {entry, recId, recGroup, recOwner, recLabel, recSn, deleted, source, key} = item;
    const deletedAtText = deleted && entry.deleted_at ? new Date(entry.deleted_at).toLocaleString('ko-KR') : '';
    const revert = entry.delete_revert_result || null;
    const revertText = deleted && revert
      ? `삭제 시 자산 정보 원복 ${Number(revert.reverted||0)}건${Number(revert.skipped||0) ? ` · 유지 ${Number(revert.skipped||0)}건` : ''}`
      : '';
    const auditBadge = source === 'audit' ? '<span class="wh-audit-badge">감사</span>' : '';
    const canJump = !!recGroup;

    return `
      <div class="wh-item ${deleted?'wh-item-deleted':''} ${source==='audit'?'wh-item-audit':''}"
           ${canJump ? `data-jump-group="${esc(recGroup)}" data-jump-rec="${esc(recId)}"` : ''}
           data-history-key="${esc(key)}">
        <div class="wh-top">
          ${isCurrentUserAdmin() ? `<label class="wh-history-check" title="삭제할 이력 선택"><input type="checkbox" class="wh-history-checkbox" data-wh-select="${esc(key)}" ${whSelectedKeys.has(key)?'checked':''}></label>` : ''}
          <span class="ra-type">${esc(entry.type)}${deleted ? '<span class="wh-deleted-badge">삭제됨</span>' : ''}${auditBadge}</span>
          <span class="ra-date">${esc(entry.date)||'날짜 미기재'}</span>
        </div>
        <div class="ra-asset">${esc(recOwner)||'—'} · ${esc(recLabel)||'—'}${recSn ? ' · S/N '+esc(recSn) : ''}</div>
        <div class="ra-note">${esc(entry.note)||'—'}</div>
        ${entry.change_summary ? `<div class="ra-changes">
          <div class="ra-changes-label">${source==='audit' ? '📝 변경 내용' : `🔧 자산 정보 변경${deleted ? ' · 삭제 시 원복 처리' : ''}`}</div>
          ${changeSummaryRowsHtml(entry.change_summary)}
        </div>` : ''}
        <div class="ra-author">${source==='audit' ? `작업자: ${esc(entry.author)||'미상'}` : `담당자: ${esc(entry.manager)||'미기재'} · 작성: ${esc(entry.author)||'미상'}`}</div>
        ${deleted ? `<div class="wh-delete-meta">삭제: ${esc(entry.deleted_by)||'미상'} · ${esc(deletedAtText)||'시간 미기재'}${revertText ? ` · ${esc(revertText)}` : ''}</div>` : ''}
      </div>`;
  }).join('') : `<div class="ra-empty wh-empty">조건에 맞는 이력이 없습니다.</div>`;

  listEl.querySelectorAll('.wh-history-check').forEach(label => {
    label.onclick = e => e.stopPropagation();
  });
  listEl.querySelectorAll('.wh-history-checkbox').forEach(box => {
    box.onchange = e => {
      e.stopPropagation();
      const key = box.dataset.whSelect;
      if (box.checked) whSelectedKeys.add(key); else whSelectedKeys.delete(key);
      updateWhSelectionUi();
    };
  });

  listEl.querySelectorAll('[data-jump-group]').forEach(el=>{
    el.onclick = (e) => {
      if (e.target.closest('.wh-history-check')) return;
      const gid = el.dataset.jumpGroup;
      const recId = el.dataset.jumpRec;
      setViewMode('list');
      expandGroupWithAncestors(gid);
      render();
      requestAnimationFrame(()=>{
        const row = recId ? document.querySelector(`tr[data-id="${CSS.escape(recId)}"]`) : null;
        const target = row || document.querySelector(`.group-card[data-gid="${CSS.escape(gid)}"]`);
        if (target){
          target.scrollIntoView({behavior:'smooth', block:'center'});
          target.classList.add('activity-highlight-flash');
          setTimeout(()=> target.classList.remove('activity-highlight-flash'), 1800);
        }
      });
    };
  });

  updateWhSelectionUi();
}

async function deleteSelectedWorkHistory(){
  if (!isCurrentUserAdmin()){ alert('마스터만 이력을 삭제할 수 있습니다.'); return; }
  if (!whSelectedKeys.size){ alert('삭제할 이력을 선택해 주세요.'); return; }

  const selectedItems = getAllWorkLogEntries().filter(item => whSelectedKeys.has(item.key));
  if (!selectedItems.length){ whSelectedKeys.clear(); renderWhList(); return; }

  const auditCount = selectedItems.filter(i=>i.source==='audit').length;
  const workCount = selectedItems.filter(i=>i.source==='worklog').length;
  const deletedCount = selectedItems.filter(i=>i.source==='deleted').length;
  let message = `선택한 이력 ${selectedItems.length}건을 영구 삭제하시겠습니까?\n\n`;
  if (workCount) message += `현재 작업 이력: ${workCount}건\n`;
  if (deletedCount) message += `삭제된 작업 이력: ${deletedCount}건\n`;
  if (auditCount) message += `사용자 감사 이력: ${auditCount}건\n`;
  message += '\n히스토리 페이지에서 마스터가 삭제한 기록은 복구할 수 없습니다.';
  if (workCount) message += '\n자산 정보 변경이 포함된 현재 작업 이력은 가능한 범위에서 변경 전 값으로 원복됩니다.';
  if (!confirm(message)) return;

  let removed=0, reverted=0, skipped=0;
  suppressAuditCapture = true;
  try{
    for (const item of selectedItems){
      if (item.source === 'audit'){
        auditLogs = (auditLogs || []).filter(a => String(a.id) !== String(item.auditId));
        removed++;
        continue;
      }
      const rec = records.find(r => String(r.id) === String(item.recId));
      if (!rec) continue;

      if (item.source === 'deleted'){
        const targetId = item.entry.history_id || item.entry.deleted_at || item.entry.id;
        rec.deleted_work_log = (rec.deleted_work_log || []).filter(entry =>
          String(entry.history_id || entry.deleted_at || entry.id) !== String(targetId)
        );
        removed++;
        continue;
      }

      if (item.entry.rollback_changes && Object.keys(item.entry.rollback_changes).length){
        const result = await revertWorkLogChanges(rec,item.entry);
        reverted += Number(result.reverted||0);
        skipped += Number(result.skipped||0);
      }
      rec.work_log = (rec.work_log || []).filter(entry => String(entry.id) !== String(item.entry.id));
      removed++;
    }
    whSelectedKeys.clear();
    refreshAuditSnapshot();
  } finally {
    suppressAuditCapture = false;
  }

  scheduleAutoSync();
  updateActivityBadge();
  renderWorkHistoryPage();

  let resultMessage = `${removed}건의 이력을 삭제했습니다.`;
  if (reverted) resultMessage += `\n자산 정보 ${reverted}개 항목을 변경 전 값으로 원복했습니다.`;
  if (skipped) resultMessage += `\n${skipped}개 항목은 이후 다른 변경이 있어 현재 값을 유지했습니다.`;
  alert(resultMessage);
}

function updateActivityBadge(){
  const badge = document.getElementById('raBadge');
  if (!badge) return;
  const dismissed = getDismissedActivity();
  let total = 0;
  records.forEach(r => (r.work_log||[]).forEach(entry => {
    if (!dismissed.has(activityKeyOf(r.id, entry.id))) total++;
  }));
  if (total > 0){ badge.textContent = total > 99 ? '99+' : String(total); badge.style.display = ''; }
  else { badge.style.display = 'none'; }
}

function renderRecentActivity(){
  const wrap = document.getElementById('recentActivityList');
  const items = getRecentWorkLogEntries(10);
  if (!items.length){
    wrap.innerHTML = `<div class="ra-empty">아직 작업 이력이 없습니다.</div>`;
    return;
  }
  wrap.innerHTML = items.map(({entry, recId, recGroup, recOwner, recLabel, key}) => `
    <div class="ra-item" data-jump-group="${esc(recGroup)}" data-jump-rec="${esc(recId)}" data-activity-key="${esc(key)}">
      <div class="ra-top"><span class="ra-type">${esc(entry.type)}</span><span class="ra-date">${esc(entry.date)||''}</span></div>
      <div class="ra-asset">${esc(recOwner)} · ${esc(recLabel)||'—'}</div>
      <div class="ra-note">${esc(entry.note)||'—'}</div>
      ${entry.change_summary ? `<div class="ra-changes">
        <div class="ra-changes-label">🔧 자산 정보 변경</div>
        ${changeSummaryRowsHtml(entry.change_summary)}
      </div>` : ''}
      <div class="ra-author">작성: ${esc(entry.author)||'미상'}</div>
    </div>`).join('');
  wrap.querySelectorAll('[data-jump-group]').forEach(el=>{
    el.onclick = () => {
      const gid = el.dataset.jumpGroup;
      const recId = el.dataset.jumpRec;
      const key = el.dataset.activityKey;
      dismissActivity(key);
      updateActivityBadge();

      expandGroupWithAncestors(gid);
      render();
      document.getElementById('recentActivityDropdown').classList.remove('open');

      requestAnimationFrame(()=>{
        const row = document.querySelector(`tr[data-id="${CSS.escape(recId)}"]`);
        const target = row || document.querySelector(`.group-card[data-gid="${CSS.escape(gid)}"]`);
        if (target){
          target.scrollIntoView({behavior:'smooth', block:'center'});
          target.classList.add('activity-highlight-flash');
          setTimeout(()=> target.classList.remove('activity-highlight-flash'), 1800);
        }
      });
    };
  });
}

document.getElementById('recentActivityBtn').onclick = (e) => {
  const dd = document.getElementById('recentActivityDropdown');
  const opening = !dd.classList.contains('open');
  if (opening){
    renderRecentActivity();
    const btnRect = e.currentTarget.getBoundingClientRect();
    const ddWidth = 340;
    let left = btnRect.left;
    if (left + ddWidth > window.innerWidth - 12) left = window.innerWidth - ddWidth - 12;
    if (left < 12) left = 12;
    dd.style.left = left + 'px';
    dd.style.top = (btnRect.bottom + 8) + 'px';
    dd.style.maxHeight = Math.min(440, window.innerHeight - btnRect.bottom - 24) + 'px';
  }
  dd.classList.toggle('open', opening);
};
document.addEventListener('click', (e) => {
  const dd = document.getElementById('recentActivityDropdown');
  if (!dd || !dd.classList.contains('open')) return;
  if (dd.contains(e.target) || e.target.closest('#recentActivityBtn')) return;
  dd.classList.remove('open');
});

// ---------- GitHub sync ----------
const GITHUB_CONFIG_KEY = 'bcAssetGithubConfig';
const GITHUB_TOKEN_KEY = 'bcAssetGithubToken';

function loadGithubConfigFromStorage(){
  try{ return JSON.parse(localStorage.getItem(GITHUB_CONFIG_KEY)); }catch(e){ return null; }
}
function saveGithubConfigToStorage(cfg){
  try{ localStorage.setItem(GITHUB_CONFIG_KEY, JSON.stringify(cfg)); }catch(e){}
}
function loadRememberedToken(){
  try{ return localStorage.getItem(GITHUB_TOKEN_KEY) || null; }catch(e){ return null; }
}
function saveRememberedToken(token){
  try{ localStorage.setItem(GITHUB_TOKEN_KEY, token); }catch(e){}
}
function clearRememberedToken(){
  try{ localStorage.removeItem(GITHUB_TOKEN_KEY); }catch(e){}
}

function b64EncodeUnicode(str){
  return bufToB64(new TextEncoder().encode(str).buffer);
}
function b64DecodeUnicode(b64){
  const clean = b64.replace(/\s/g,'');
  return new TextDecoder('utf-8').decode(new Uint8Array(b64ToBuf(clean)));
}

function parseOwnerRepo(repoStr){
  const parts = (repoStr||'').trim().split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  return { owner: parts[0], repo: parts[1] };
}

async function githubApiGet(cfg, token){
  const or = parseOwnerRepo(cfg.repo);
  if (!or) throw new Error('저장소는 owner/repo 형식으로 입력해 주세요.');
  const branch = cfg.branch || 'main';
  const path = cfg.path || 'data.json';
  const url = `https://api.github.com/repos/${or.owner}/${or.repo}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(branch)}`;
  const res = await fetch(url, { headers: { 'Authorization':'Bearer '+token, 'Accept':'application/vnd.github+json' } });
  if (res.status === 404){
    const err = new Error('저장소에 해당 파일이 없습니다. "GitHub에 저장"을 누르면 새로 생성됩니다.');
    err.notFound = true;
    throw err;
  }
  if (!res.ok){
    const body = await res.json().catch(()=>({}));
    throw new Error(`GitHub 불러오기 실패: HTTP ${res.status}${body.message? ' - '+body.message : ''}`);
  }
  const data = await res.json();
  const json = JSON.parse(b64DecodeUnicode(data.content));
  return { json, sha: data.sha };
}

async function githubApiPut(cfg, token, jsonObj, sha, message){
  const or = parseOwnerRepo(cfg.repo);
  if (!or) throw new Error('저장소는 owner/repo 형식으로 입력해 주세요.');
  const branch = cfg.branch || 'main';
  const path = cfg.path || 'data.json';
  const url = `https://api.github.com/repos/${or.owner}/${or.repo}/contents/${encodeURIComponent(path)}`;
  const body = {
    message: message || ('자산 데이터 업데이트 - ' + new Date().toLocaleString('ko-KR')),
    content: b64EncodeUnicode(JSON.stringify(jsonObj, null, 2)),
    branch
  };
  if (sha) body.sha = sha;
  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'Authorization':'Bearer '+token, 'Accept':'application/vnd.github+json', 'Content-Type':'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok){
    const errBody =
      await res.json().catch(()=>({}));
    const err =
      new Error(
        `GitHub 저장 실패: HTTP ${res.status}` +
        `${errBody.message ? ' - ' + errBody.message : ''}`
      );
    err.status = res.status;
    err.githubBody = errBody;
    throw err;
  }
  const data = await res.json();
  return data.content.sha;
}

// ---------- work log ----------
function openWorkLogModal(recIdOrIds){
  const ids = Array.isArray(recIdOrIds) ? recIdOrIds.map(String) : [String(recIdOrIds)];
  const recs = records.filter(r => ids.includes(String(r.id)));
  if (!recs.length) return;
  workLogRecordIds = ids;
  const isMulti = recs.length > 1;

  const assetListEl = document.getElementById('wlAssetList');
  const fieldChangeWrap = document.getElementById('wlFieldChangeWrap');
  const historyWrap = document.getElementById('wlHistoryWrap');

  if (isMulti){
    document.getElementById('wlSubtitle').textContent =
      `선택한 ${recs.length}개 자산에 같은 작업 이력을 한 번에 등록합니다. 비고와 별도로 구축/제거/교체/OS 변경/PM 이력을 남길 수 있습니다.`;
    assetListEl.style.display = '';
    assetListEl.innerHTML = `<div class="wl-asset-list-label">선택된 자산 (${recs.length}개)</div>` +
      recs.map(r => `<div class="wl-asset-chip">${esc(r.sku || '장비')}${r.sn ? ' · ' + esc(r.sn) : ''}</div>`).join('');
    if (fieldChangeWrap) fieldChangeWrap.style.display = '';
    if (historyWrap) historyWrap.style.display = 'none';
  } else {
    const rec = recs[0];
    document.getElementById('wlSubtitle').textContent =
      `${rec.sku||'장비'}${rec.sn? ' · S/N '+rec.sn : ''} — 비고와 별도로 구축/제거/교체/OS 변경/PM 이력을 남길 수 있습니다.`;
    assetListEl.style.display = 'none';
    assetListEl.innerHTML = '';
    if (fieldChangeWrap) fieldChangeWrap.style.display = '';
    if (historyWrap) historyWrap.style.display = '';
  }

  document.getElementById('wl_type').value = '장비 구축';
  document.getElementById('wl_date').value = todayDots();
  document.getElementById('wl_manager').value = currentUserName() || '';
  document.getElementById('wl_note').value = '';
  resetFieldChangeInputs();
  workLogEditId = null;
  setWorkLogFormMode(false);
  renderWorkLogList();
  document.getElementById('workLogModal').classList.add('open');
}

// ---------- work log: "apply changes to asset" section ----------
const WL_FIELD_DEFS = [
  { field:'start',       label:'라이선스 시작일', type:'text' },
  { field:'end',         label:'라이선스 종료일', type:'text' },
  { field:'os_ver',      label:'OS 버전', type:'text' },
  { field:'remarks',     label:'비고', type:'textarea' },
  { field:'ip',  label:'IP 주소 (여러 개면 줄바꿈으로 구분)', type:'textarea', sensitive:true, encField:'ip_enc' },
  { field:'id',  label:'계정 ID (여러 개면 줄바꿈으로 구분)', type:'textarea', sensitive:true, encField:'id_enc' },
  { field:'pw',  label:'비밀번호 (여러 개면 줄바꿈으로 구분)', type:'textarea', sensitive:true, encField:'pw_enc' },
  { field:'enable_pw', label:'Enable 비밀번호', type:'text', sensitive:true, encField:'enable_pw_enc' },
];
function wlFieldDef(field){ return WL_FIELD_DEFS.find(d=>d.field===field); }

let wlChangeFields = [];
let wlChangeValues = {};
let wlOriginalValues = {};
let wlMultiChangeState = {};

// 현재 등록된 자산 정보를 그대로 불러와 wlChangeFields/Values에 채워 넣는다.
// (체크박스를 켜면 모든 항목이 현재 값으로 채워진 상태로 보이고, 그 중 원하는 항목만 고쳐서 저장하면 된다.)
async function populateAllWlFieldsFromRecord(rec){
  wlChangeFields = WL_FIELD_DEFS.map(d => d.field);
  wlChangeValues = {};
  wlOriginalValues = {};
  for (const def of WL_FIELD_DEFS){
    let current = '';
    if (def.sensitive){
      current = rec[def.encField] ? await decryptField(rec[def.encField]) : '';
    } else {
      current = rec[def.field] || '';
    }
    wlChangeValues[def.field] = current;
    wlOriginalValues[def.field] = current;
  }
  renderWlChangeRows();
}

async function populateMultiWlFields(recs){
  wlMultiChangeState = {};
  for (const rec of recs){
    const values = {}, originals = {};
    for (const def of WL_FIELD_DEFS){
      let current = '';
      if (def.sensitive) current = rec[def.encField] ? await decryptField(rec[def.encField]) : '';
      else current = rec[def.field] || '';
      values[def.field] = current;
      originals[def.field] = current;
    }
    wlMultiChangeState[String(rec.id)] = {values, originals};
  }
  renderMultiWlChangeRows(recs);
}

function wlMultiChangedCount(recId){
  const state = wlMultiChangeState[String(recId)];
  if (!state) return 0;
  return WL_FIELD_DEFS.filter(def => String(state.values[def.field] ?? '') !== String(state.originals[def.field] ?? '')).length;
}

function renderMultiWlChangeRows(recs){
  const wrap = document.getElementById('wl_fieldchange_rows');
  if (!wrap) return;
  const locked = viewOnly || !sessionKey;
  wrap.innerHTML = `
    <div class="wl-multi-toolbar">
      <span>선택한 자산별로 변경할 내용을 수정하세요.</span>
      <div>
        <button type="button" class="wl-multi-toggle-btn" id="wlMultiExpandAll">전체 펼치기</button>
        <button type="button" class="wl-multi-toggle-btn" id="wlMultiCollapseAll">전체 접기</button>
      </div>
    </div>
    <div class="wl-multi-assets">
      ${recs.map((rec,index) => {
        const state = wlMultiChangeState[String(rec.id)];
        const changedCount = wlMultiChangedCount(rec.id);
        return `
          <details class="wl-multi-asset" data-wl-multi-asset="${esc(rec.id)}" ${index===0?'open':''}>
            <summary class="wl-multi-summary">
              <div class="wl-multi-summary-main">
                <strong>${esc(rec.sku || '장비')}</strong>
                ${rec.sn ? `<span>S/N ${esc(rec.sn)}</span>` : ''}
                <span class="wl-multi-owner">${esc(rec.owner || '')}</span>
              </div>
              <span class="wl-multi-change-count" data-wl-change-count="${esc(rec.id)}" style="${changedCount?'':'display:none;'}">${changedCount}개 변경</span>
            </summary>
            <div class="wl-multi-fields">
              ${WL_FIELD_DEFS.map(def => {
                const value = state?.values?.[def.field] ?? '';
                const original = state?.originals?.[def.field] ?? '';
                const changed = String(value) !== String(original);
                const sensitiveLocked = def.sensitive && locked;
                const input = def.type === 'textarea'
                  ? `<textarea class="wl-multi-input ${changed?'is-changed':''}" data-rec-id="${esc(rec.id)}" data-field="${esc(def.field)}" ${sensitiveLocked?'disabled':''} placeholder="${sensitiveLocked?'잠금 해제 후 수정 가능':''}">${esc(value)}</textarea>`
                  : `<input class="wl-multi-input ${changed?'is-changed':''}" data-rec-id="${esc(rec.id)}" data-field="${esc(def.field)}" value="${esc(value)}" ${sensitiveLocked?'disabled':''} placeholder="${sensitiveLocked?'잠금 해제 후 수정 가능':''}">`;
                return `
                  <div class="wl-multi-field ${changed?'is-changed':''}">
                    <label>${esc(def.label)}${def.sensitive?' 🔒':''}</label>
                    ${input}
                    <span class="wl-multi-changed-badge" style="${changed?'':'display:none;'}">변경됨</span>
                  </div>`;
              }).join('')}
            </div>
          </details>`;
      }).join('')}
    </div>`;

  wrap.querySelectorAll('.wl-multi-input').forEach(el => {
    el.addEventListener('input', () => {
      const recId = String(el.dataset.recId), field = el.dataset.field;
      const state = wlMultiChangeState[recId];
      if (!state) return;
      state.values[field] = el.value;
      const changed = String(el.value) !== String(state.originals[field] ?? '');
      el.classList.toggle('is-changed',changed);
      const fieldRow = el.closest('.wl-multi-field');
      if (fieldRow){
        fieldRow.classList.toggle('is-changed',changed);
        const badge = fieldRow.querySelector('.wl-multi-changed-badge');
        if (badge) badge.style.display = changed ? '' : 'none';
      }
      const count = wlMultiChangedCount(recId);
      const countEl = wrap.querySelector(`[data-wl-change-count="${CSS.escape(recId)}"]`);
      if (countEl){ countEl.textContent = `${count}개 변경`; countEl.style.display = count ? '' : 'none'; }
    });
  });
  document.getElementById('wlMultiExpandAll')?.addEventListener('click', () => wrap.querySelectorAll('.wl-multi-asset').forEach(el=>{el.open=true;}));
  document.getElementById('wlMultiCollapseAll')?.addEventListener('click', () => wrap.querySelectorAll('.wl-multi-asset').forEach(el=>{el.open=false;}));
}

function getWlSingleRecord(){
  if (!workLogRecordIds || workLogRecordIds.length !== 1) return null;
  return records.find(r => String(r.id) === String(workLogRecordIds[0])) || null;
}

function renderWlChangeRows(){
  const wrap = document.getElementById('wl_fieldchange_rows');
  const locked = viewOnly || !sessionKey;

  wrap.innerHTML = wlChangeFields.map(field => {
    const def = wlFieldDef(field);
    if (!def) return '';

    const isLockedSensitive = def.sensitive && locked;
    const currentValue = String(wlChangeValues[field] ?? '');
    const originalValue = String(wlOriginalValues[field] ?? '');
    const changed = currentValue !== originalValue;
    const val = esc(currentValue);
    const placeholder = isLockedSensitive ? '잠금 해제 후 수정 가능' : '';

    const inputHtml = def.type === 'textarea'
      ? `<textarea class="wl-fc-input ${changed ? 'is-changed' : ''}" data-field="${field}" placeholder="${placeholder}" ${isLockedSensitive ? 'disabled' : ''}>${val}</textarea>`
      : `<input class="wl-fc-input ${changed ? 'is-changed' : ''}" data-field="${field}" value="${val}" placeholder="${placeholder}" ${isLockedSensitive ? 'disabled' : ''}>`;

    return `
      <div class="wl-fc-row ${changed ? 'is-changed' : ''}">
        <label>${esc(def.label)}${def.sensitive ? ' 🔒' : ''}</label>
        <div class="wl-fc-input-wrap">
          ${inputHtml}
          <span class="wl-fc-changed-badge" style="${changed ? '' : 'display:none;'}">변경됨</span>
        </div>
      </div>`;
  }).join('');

  wrap.querySelectorAll('.wl-fc-input').forEach(el => {
    el.addEventListener('input', () => {
      const field = el.dataset.field;
      wlChangeValues[field] = el.value;

      const originalValue = String(wlOriginalValues[field] ?? '');
      const changed = String(el.value) !== originalValue;
      const row = el.closest('.wl-fc-row');
      const badge = row ? row.querySelector('.wl-fc-changed-badge') : null;

      el.classList.toggle('is-changed', changed);
      if (row) row.classList.toggle('is-changed', changed);
      if (badge) badge.style.display = changed ? '' : 'none';
    });
  });
}

function resetFieldChangeInputs(){
  document.getElementById('wl_apply_toggle').checked = false;
  document.getElementById('wl_fieldchange_section').style.display = 'none';
  wlChangeFields = [];
  wlChangeValues = {};
  wlOriginalValues = {};
  wlMultiChangeState = {};
  renderWlChangeRows();
}

document.getElementById('wl_apply_toggle').addEventListener('change', async (e) => {
  const checked = e.target.checked;
  document.getElementById('wl_fieldchange_section').style.display = checked ? '' : 'none';
  const targetRecs = records.filter(r => workLogRecordIds.includes(String(r.id)));
  if (!checked){
    wlChangeFields = []; wlChangeValues = {}; wlOriginalValues = {}; wlMultiChangeState = {};
    document.getElementById('wl_fieldchange_rows').innerHTML = '';
    return;
  }
  if (targetRecs.length > 1){
    await populateMultiWlFields(targetRecs);
    return;
  }
  if (targetRecs[0]) await populateAllWlFieldsFromRecord(targetRecs[0]);
});

async function applyFieldChanges(rec){
  const changes = [];
  const fieldChanges = {};
  const rollbackChanges = {};

  for (const field of wlChangeFields){
    const def = wlFieldDef(field);
    if (!def) continue;

    const val = (wlChangeValues[field] || '').trim();
    if (!val) continue;

    if (def.sensitive){
      const orig = (wlOriginalValues[field] || '').trim();
      if (val === orig) continue;

      const beforeEnc = rec[def.encField]
        ? JSON.parse(JSON.stringify(rec[def.encField]))
        : null;
      const afterEnc = await encryptField(val);

      rec[def.encField] = afterEnc;
      changes.push({ field, label:def.label, sensitive:true });
      fieldChanges[field] = true;
      rollbackChanges[field] = {
        sensitive:true,
        encField:def.encField,
        before:beforeEnc,
        after:afterEnc ? JSON.parse(JSON.stringify(afterEnc)) : null
      };
    } else {
      const before = rec[field] ?? '';
      if (val === String(before)) continue;

      changes.push({ field, label:def.label, from:before || '—', to:val });
      fieldChanges[field] = val;
      rollbackChanges[field] = {
        sensitive:false,
        before,
        after:val
      };
      rec[field] = val;
    }
  }

  return { changes, fieldChanges, rollbackChanges };
}

async function applyMultiFieldChanges(rec){
  const state = wlMultiChangeState[String(rec.id)];
  const changes = [], fieldChanges = {}, rollbackChanges = {};
  if (!state) return {changes,fieldChanges,rollbackChanges};

  for (const def of WL_FIELD_DEFS){
    const field = def.field;
    const before = state.originals[field] ?? '';
    const after = state.values[field] ?? '';
    if (String(before) === String(after)) continue;

    if (def.sensitive){
      if (viewOnly || !sessionKey) continue;
      const beforeEnc = rec[def.encField] ? JSON.parse(JSON.stringify(rec[def.encField])) : null;
      const afterEnc = String(after).trim() ? await encryptField(String(after).trim()) : null;
      rec[def.encField] = afterEnc;
      changes.push({field,label:def.label,sensitive:true});
      fieldChanges[field] = true;
      rollbackChanges[field] = {sensitive:true,encField:def.encField,before:beforeEnc,after:afterEnc?JSON.parse(JSON.stringify(afterEnc)):null};
    } else {
      rec[field] = after;
      changes.push({field,label:def.label,from:before||'—',to:after||'—'});
      fieldChanges[field] = after;
      rollbackChanges[field] = {sensitive:false,before,after};
    }
  }
  return {changes,fieldChanges,rollbackChanges};
}

function fieldChangesSummary(changes){
  if (!changes || !changes.length) return '';
  return changes.map(c => c.sensitive ? `${c.label} 변경됨` : `${c.label}: ${c.from} → ${c.to}`).join(' · ');
}

function changeSummaryRowsHtml(summary){
  if (!summary) return '';
  return summary.split(' · ').map(seg=>{
    const m = seg.match(/^(.+?):\s*(.+?)\s*→\s*(.+)$/);
    if (m){
      const label = m[1], from = m[2], to = m[3];
      return `<div class="ra-change-row">
        <span class="ra-change-label">${esc(label)}</span>
        <span class="ra-change-before" title="변경 전">${esc(from)}</span>
        <span class="ra-change-arrow">→</span>
        <span class="ra-change-after" title="변경 후">${esc(to)}</span>
      </div>`;
    }
    return `<div class="ra-change-row"><span class="ra-change-label">${esc(seg)}</span></div>`;
  }).join('');
}

function fmtDateDots(nativeVal){
  if (!nativeVal) return '';
  const [y,m,d] = nativeVal.split('-').map(Number);
  if (!y || !m || !d) return '';
  return `${y}.${m}.${d}`;
}

function todayDots(){
  const now = new Date();
  return `${now.getFullYear()}.${now.getMonth()+1}.${now.getDate()}`;
}

document.getElementById('wl_date_pick_btn').onclick = () => {
  const picker = document.getElementById('wl_date_picker');
  if (picker.showPicker) picker.showPicker();
  else picker.click();
};
document.getElementById('wl_date_picker').addEventListener('change', (e) => {
  document.getElementById('wl_date').value = fmtDateDots(e.target.value);
});

function setWorkLogFormMode(isEditing){
  document.getElementById('wlAddBtn').textContent = isEditing ? '수정 완료' : '이력 추가';
  document.getElementById('wlCancelEditBtn').style.display = isEditing ? '' : 'none';
}

function cloneRollbackValue(v){
  if (v === undefined) return undefined;
  if (v === null) return null;
  return JSON.parse(JSON.stringify(v));
}

function sameRollbackValue(a, b){
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function rollbackChangesSummary(rollback){
  if (!rollback) return '';
  return Object.entries(rollback).map(([field, snap]) => {
    const def = wlFieldDef(field);
    const label = def ? def.label : field;
    if (snap && snap.sensitive) return `${label} 변경됨`;
    const before = (snap && snap.before !== undefined && snap.before !== '') ? snap.before : '—';
    const after = (snap && snap.after !== undefined && snap.after !== '') ? snap.after : '—';
    return `${label}: ${before} → ${after}`;
  }).join(' · ');
}

async function revertWorkLogChanges(rec, entry){
  const rollback = entry && entry.rollback_changes;
  if (!rollback || !Object.keys(rollback).length){
    return { reverted:0, skipped:0 };
  }

  let reverted = 0;
  let skipped = 0;

  for (const [field, snap] of Object.entries(rollback)){
    if (!snap) continue;

    if (snap.sensitive){
      const def = wlFieldDef(field);
      const encField = snap.encField || (def ? def.encField : null);
      if (!encField){ skipped++; continue; }

      if (sameRollbackValue(rec[encField], snap.after)){
        rec[encField] = cloneRollbackValue(snap.before);
        reverted++;
      } else {
        skipped++;
      }
      continue;
    }

    const currentValue = rec[field] ?? '';
    const afterValue = snap.after ?? '';
    if (String(currentValue) === String(afterValue)){
      rec[field] = snap.before ?? '';
      reverted++;
    } else {
      skipped++;
    }
  }

  return { reverted, skipped };
}

function renderWorkLogList(){
  const listEl = document.getElementById('wlList');
  if (workLogRecordIds.length !== 1){ listEl.innerHTML=''; return; }
  const rec = records.find(r=>String(r.id)===workLogRecordIds[0]);
  if (!rec){ listEl.innerHTML=''; return; }
  const log = (rec.work_log||[]).slice().sort((a,b)=>{
    const da = parseDate(a.date), db = parseDate(b.date);
    if (da && db) return db - da;
    return 0;
  });
  if (log.length === 0){
    listEl.innerHTML = `<div class="worklog-empty">등록된 작업 이력이 없습니다.</div>`;
    return;
  }
  listEl.innerHTML = log.map(entry => `
    <div class="worklog-item">
      <div class="wl-type">${esc(entry.type)}</div>
      <div class="wl-body">
        <div class="wl-meta">${esc(entry.date)||'날짜 미기재'} · ${esc(entry.manager)||'담당자 미기재'} · 작성 ${esc(entry.author)||'미상'}</div>
        <div class="wl-note">${esc(entry.note)||'—'}</div>
        ${entry.change_summary ? `<div class="wl-changes">🔧 자산 정보 반영: ${esc(entry.change_summary)}</div>` : ''}
      </div>
      <div class="wl-actions">
        <button class="wl-action-btn" data-wl-edit="${entry.id}">수정</button>
        <button class="wl-action-btn danger" data-wl-delete="${entry.id}">삭제</button>
      </div>
    </div>`).join('');

  listEl.querySelectorAll('[data-wl-edit]').forEach(btn=>{
    btn.onclick = async () => {
      const entryId = btn.dataset.wlEdit;
      const entry = (rec.work_log||[]).find(e=>String(e.id)===String(entryId));
      if (!entry) return;
      workLogEditId = entry.id;
      document.getElementById('wl_type').value = entry.type;
      document.getElementById('wl_date').value = entry.date;
      document.getElementById('wl_manager').value = entry.manager;
      document.getElementById('wl_note').value = entry.note;
      resetFieldChangeInputs();
      if (entry.field_changes && Object.keys(entry.field_changes).length){
        document.getElementById('wl_apply_toggle').checked = true;
        document.getElementById('wl_fieldchange_section').style.display = '';
        // 현재 등록된 자산 정보를 전부 채운 뒤, 이 이력에 실제로 기록됐던 변경값(비민감 항목)만 덮어씌운다.
        await populateAllWlFieldsFromRecord(rec);
        Object.keys(entry.field_changes).forEach(field => {
          const def = wlFieldDef(field);
          if (!def || def.sensitive) return;
          wlChangeValues[field] = entry.field_changes[field];
        });
        renderWlChangeRows();
      }
      setWorkLogFormMode(true);
    };
  });
  listEl.querySelectorAll('[data-wl-delete]').forEach(btn=>{
    btn.onclick = async () => {
      const entryId = btn.dataset.wlDelete;
      const entry = (rec.work_log || []).find(e => String(e.id) === String(entryId));
      if (!entry) return;

      if (entry.field_changes && Object.keys(entry.field_changes).length && !entry.rollback_changes){
        alert(
          '이 작업 이력은 변경 전 값이 저장되기 이전에 생성된 이력이라 자동 원복할 수 없습니다.\n\n' +
          '기존 변경값을 직접 확인한 후 처리해 주세요.'
        );
        return;
      }

      const hasChanges = entry.rollback_changes && Object.keys(entry.rollback_changes).length;
      const message = hasChanges
        ? '이 작업 이력을 삭제하시겠습니까?\n\n이 작업 이력에서 변경된 자산 정보도 변경 전 값으로 원복됩니다.'
        : '이 작업 이력을 삭제하시겠습니까?';
      if (!confirm(message)) return;

      const result = await revertWorkLogChanges(rec, entry);

      /*
        작업 이력 자체는 현재 이력 목록에서는 제거하되,
        삭제 감사 로그에는 원본을 그대로 보존한다.
      */
      if (!Array.isArray(rec.deleted_work_log)) rec.deleted_work_log = [];

      const deletedSnapshot = cloneRollbackValue(entry) || {};
      deletedSnapshot.history_id = Date.now();
      deletedSnapshot.deleted_at = Date.now();
      deletedSnapshot.deleted_by = currentUserName() || '';
      deletedSnapshot.delete_revert_result = {
        reverted: Number(result.reverted || 0),
        skipped: Number(result.skipped || 0)
      };

      rec.deleted_work_log.push(deletedSnapshot);

      rec.work_log = (rec.work_log || []).filter(e => String(e.id) !== String(entryId));

      if (String(workLogEditId) === String(entryId)){
        workLogEditId = null;
        document.getElementById('wl_date').value = todayDots();
        document.getElementById('wl_manager').value = currentUserName() || '';
        document.getElementById('wl_note').value = '';
        resetFieldChangeInputs();
        setWorkLogFormMode(false);
      }

      renderWorkLogList();
      render();
      scheduleAutoSync();

      if (result.skipped > 0){
        alert(
          `작업 이력은 삭제되었습니다.\n\n` +
          `${result.reverted}개 항목은 변경 전 값으로 원복되었습니다.\n` +
          `${result.skipped}개 항목은 이후 다른 변경이 있어 현재 값을 유지했습니다.`
        );
      }
    };
  });
}

document.getElementById('wlAddBtn').onclick = async () => {
  const targetRecs = records.filter(r => workLogRecordIds.includes(String(r.id)));
  if (!targetRecs.length) return;

  const type = document.getElementById('wl_type').value;
  const date = document.getElementById('wl_date').value.trim();
  const manager = document.getElementById('wl_manager').value.trim();
  const note = document.getElementById('wl_note').value.trim();
  if (!date && !manager && !note){ alert('날짜, 담당자, 내용 중 하나 이상을 입력해 주세요.'); return; }

  if (targetRecs.length > 1){
    if (!currentUserId && !confirm('현재 로그인된 사용자가 없어 이 이력의 작성자가 "미상"으로 표시됩니다.\n로그인 없이 계속 저장할까요?')) return;

    const author = currentUserName();
    const applyChanges = document.getElementById('wl_apply_toggle').checked;

    if (applyChanges){
      const sensitiveTouched = targetRecs.some(rec => {
        const state = wlMultiChangeState[String(rec.id)];
        if (!state) return false;
        return WL_FIELD_DEFS.some(def => def.sensitive && String(state.values[def.field] ?? '') !== String(state.originals[def.field] ?? ''));
      });
      if (sensitiveTouched && (viewOnly || !sessionKey)){
        alert('IP / 계정 ID / 비밀번호를 변경하려면 먼저 마스터 비밀번호로 잠금을 해제해야 합니다.');
        return;
      }
    }

    let totalChangedAssets = 0, totalChangedFields = 0;
    const baseId = Date.now();
    for (let idx=0; idx<targetRecs.length; idx++){
      const rec = targetRecs[idx];
      if (!Array.isArray(rec.work_log)) rec.work_log = [];
      const entry = {id:baseId+idx,type,date,manager,note,author};
      if (applyChanges){
        const result = await applyMultiFieldChanges(rec);
        if (result.changes.length){
          entry.field_changes = result.fieldChanges;
          entry.change_summary = fieldChangesSummary(result.changes);
          entry.rollback_changes = result.rollbackChanges;
          totalChangedAssets++;
          totalChangedFields += result.changes.length;
        }
      }
      rec.work_log.push(entry);
    }

    document.getElementById('workLogModal').classList.remove('open');
    workLogRecordIds = [];
    wlMultiChangeState = {};
    selectedAssetIds.clear();
    render();
    scheduleAutoSync();
    if (applyChanges && totalChangedFields){
      alert(`작업 이력이 ${targetRecs.length}개 자산에 등록되었습니다.\n\n자산 정보 변경: ${totalChangedAssets}개 자산 · ${totalChangedFields}개 항목`);
    }
    return;
  }

  const rec = targetRecs[0];
  if (!Array.isArray(rec.work_log)) rec.work_log = [];

  const applyToggled = document.getElementById('wl_apply_toggle').checked;
  let changeSummary = '';
  let fieldChanges = {};
  let rollbackChanges = {};
  let appliedNewChanges = false;

  if (applyToggled){
    const sensitiveTouched = wlChangeFields.some(f => {
      const def = wlFieldDef(f);
      const original = String(wlOriginalValues[f] ?? '');
      const current = String(wlChangeValues[f] ?? '');
      return def && def.sensitive && current !== original;
    });
    if (sensitiveTouched && (viewOnly || !sessionKey)){
      alert('IP / 계정 ID / 비밀번호를 변경하려면 먼저 마스터 비밀번호로 잠금을 해제해야 합니다.');
      return;
    }

    const result = await applyFieldChanges(rec);
    appliedNewChanges = result.changes.length > 0;

    // 신규 이력에서는 실제 변경이 하나도 없으면 저장하지 않는다.
    // 기존 이력 수정 중이라면 날짜/담당자/메모만 수정할 수 있도록 허용한다.
    if (!appliedNewChanges && !workLogEditId){
      alert('자산 정보 변경을 선택했지만, 기존 값과 다른 내용이 입력되지 않았습니다.');
      return;
    }

    if (appliedNewChanges){
      changeSummary = fieldChangesSummary(result.changes);
      fieldChanges = result.fieldChanges;
      rollbackChanges = result.rollbackChanges;
    }
  }

  if (workLogEditId){
    const entry = rec.work_log.find(e => String(e.id) === String(workLogEditId));
    if (entry){
      entry.type = type;
      entry.date = date;
      entry.manager = manager;
      entry.note = note;

      if (applyToggled && appliedNewChanges){
        const existingRollback = entry.rollback_changes ? cloneRollbackValue(entry.rollback_changes) : {};

        Object.entries(rollbackChanges).forEach(([field, snap]) => {
          if (existingRollback[field]){
            // 최초 변경 전 값은 유지하고 최종 변경 후 값만 갱신
            existingRollback[field].after = cloneRollbackValue(snap.after);
            if (snap.encField) existingRollback[field].encField = snap.encField;
            if (snap.sensitive !== undefined) existingRollback[field].sensitive = snap.sensitive;
          } else {
            existingRollback[field] = cloneRollbackValue(snap);
          }
        });

        entry.rollback_changes = existingRollback;
        entry.field_changes = { ...(entry.field_changes || {}), ...fieldChanges };
        entry.change_summary = rollbackChangesSummary(existingRollback) || changeSummary;
      }
      // applyToggled가 꺼져 있어도 기존 변경 이력/원복 정보는 보존한다.
      // 실제 자산값과 원복 체인의 연결을 끊지 않기 위함이다.
    }
    workLogEditId = null;
    setWorkLogFormMode(false);
  } else {
    if (!currentUserId && !confirm('현재 로그인된 사용자가 없어 이 이력의 작성자가 "미상"으로 표시됩니다.\n로그인 없이 계속 저장할까요?\n\n(취소를 누르면 저장하지 않습니다 — 상단의 "👤 로그인"에서 먼저 본인 계정으로 로그인해 주세요.)')){
      return;
    }
    const entry = { id: Date.now(), type, date, manager, note, author: currentUserName() };
    if (applyToggled && appliedNewChanges){
      entry.field_changes = fieldChanges;
      entry.change_summary = changeSummary;
      entry.rollback_changes = rollbackChanges;
    }
    rec.work_log.push(entry);
  }

  document.getElementById('wl_date').value = todayDots();
  document.getElementById('wl_manager').value = currentUserName() || '';
  document.getElementById('wl_note').value = '';
  resetFieldChangeInputs();
  renderWorkLogList();
  render();
  scheduleAutoSync();
};

document.getElementById('wlCancelEditBtn').onclick = () => {
  workLogEditId = null;
  document.getElementById('wl_date').value = todayDots();
  document.getElementById('wl_manager').value = currentUserName() || '';
  document.getElementById('wl_note').value = '';
  resetFieldChangeInputs();
  setWorkLogFormMode(false);
};

document.getElementById('wlCloseBtn').onclick = () => {
  document.getElementById('workLogModal').classList.remove('open');
  workLogRecordIds = [];
  workLogEditId = null;
};

function dashboardCountryLocationSectionHtml(items){
  const countryMap = new Map();

  // 국가 → 위치 → 법인
  items.forEach(r => {
    const country = countryOf(r) || '미상';
    const location = (r.location || '').trim() || '위치 미상';
    const owner = (r.owner || '').trim() || '법인명 미상';
    const gid = r.group;

    if (!countryMap.has(country)){
      countryMap.set(country, {
        count: 0,
        locations: new Map()
      });
    }

    const countryData = countryMap.get(country);
    countryData.count++;

    if (!countryData.locations.has(location)){
      countryData.locations.set(location, {
        count: 0,
        companies: new Map()
      });
    }

    const locationData = countryData.locations.get(location);
    locationData.count++;

    // 같은 group은 하나의 법인으로 묶음
    if (!locationData.companies.has(gid)){
      locationData.companies.set(gid, {
        owner,
        gid,
        count: 0
      });
    }

    locationData.companies.get(gid).count++;
  });

  const countries = [...countryMap.entries()]
    .sort((a, b) => b[1].count - a[1].count);

  if (!countries.length){
    return `
      <div class="dash-card">
        <h4>국가/위치별 현황</h4>
        <div class="dash-empty">데이터가 없습니다.</div>
      </div>
    `;
  }

  const countryMax = Math.max(...countries.map(([, d]) => d.count));

  const html = countries.map(([country, countryData], ci) => {
    const countryId = `dashGeoCountry_${ci}`;

    const locations = [...countryData.locations.entries()]
      .sort((a, b) => b[1].count - a[1].count);

    const locationMax = Math.max(
      1,
      ...locations.map(([, d]) => d.count)
    );

    const locationHtml = locations.map(([location, locationData], li) => {
      const locationId = `dashGeoLocation_${ci}_${li}`;

      const companies = [...locationData.companies.values()]
        .sort((a, b) =>
          b.count - a.count ||
          a.owner.localeCompare(b.owner, 'ko')
        );

      const companyMax = Math.max(
        1,
        ...companies.map(c => c.count)
      );

      const companyHtml = companies.map(company => `
        <div class="dash-row dash-row-clickable dash-geo-company"
             data-dash-company="${esc(company.owner)}"
             data-dash-gid="${esc(company.gid)}"
             title="${esc(company.owner)} 자산 페이지로 이동">

          <span class="dash-geo-caret-space"></span>

          <span class="dash-row-label"
                title="${esc(company.owner)}">
            ${esc(company.owner)}
          </span>

          <div class="dash-bar-track">
            <div class="dash-bar-fill dash-geo-bar-company"
                 style="width:${Math.max(
                   5,
                   Math.round(company.count / companyMax * 100)
                 )}%">
            </div>
          </div>

          <span class="dash-row-count">
            ${company.count}
          </span>
        </div>
      `).join('');

      return `
        <div class="dash-geo-location-wrap">

          <div class="dash-row dash-row-clickable dash-geo-row dash-geo-location"
               data-dash-hierarchy-toggle="${locationId}">

            <span class="dash-row-caret dash-geo-caret">›</span>

            <span class="dash-row-label"
                  title="${esc(location)}">
              ${esc(location)}
            </span>

            <div class="dash-bar-track">
              <div class="dash-bar-fill dash-geo-bar-location"
                   style="width:${Math.max(
                     5,
                     Math.round(locationData.count / locationMax * 100)
                   )}%">
              </div>
            </div>

            <span class="dash-row-count">
              ${locationData.count}
            </span>
          </div>

          <div class="dash-geo-children"
               id="${locationId}"
               style="display:none;">
            ${companyHtml}
          </div>

        </div>
      `;
    }).join('');

    return `
      <div class="dash-geo-country-wrap">

        <div class="dash-row dash-row-clickable dash-geo-row dash-geo-country"
             data-dash-hierarchy-toggle="${countryId}">

          <span class="dash-row-caret dash-geo-caret">›</span>

          <span class="dash-row-label"
                title="${esc(country)}">
            ${esc(country)}
          </span>

          <div class="dash-bar-track">
            <div class="dash-bar-fill dash-geo-bar-country"
                 style="width:${Math.max(
                   5,
                   Math.round(countryData.count / countryMax * 100)
                 )}%">
            </div>
          </div>

          <span class="dash-row-count">
            ${countryData.count}
          </span>
        </div>

        <div class="dash-geo-children"
             id="${countryId}"
             style="display:none;">
          ${locationHtml}
        </div>

      </div>
    `;
  }).join('');

  return `
    <div class="dash-card">
      <h4>국가/위치별 현황</h4>
      ${html}
    </div>
  `;
}
