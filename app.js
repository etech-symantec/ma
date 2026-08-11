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
}
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
let githubConfig = null;   // {repo, branch, path} - non-sensitive, persisted in localStorage (set below to hardcoded defaults)
let githubToken = null;    // PAT - only persisted if user opts in
let githubSha = null;      // sha of the last-loaded file, needed to PUT updates

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

function setSyncStatus(state, msg){
  const el = document.getElementById('githubSyncStatus');
  if (!el) return;
  if (state === 'pending'){ el.textContent = '변경사항 동기화 대기 중…'; el.className = 'sync-status pending'; }
  else if (state === 'syncing'){ el.textContent = 'GitHub에 동기화 중…'; el.className = 'sync-status syncing'; }
  else if (state === 'synced'){ el.textContent = '✓ GitHub에 동기화됨 · ' + new Date().toLocaleTimeString('ko-KR'); el.className = 'sync-status synced'; }
  else if (state === 'error'){ el.textContent = '⚠ 동기화 실패: ' + (msg || ''); el.className = 'sync-status error'; }
  else if (state === 'offline'){ el.textContent = ''; el.className = 'sync-status'; }
}

function scheduleAutoSync(){
  if (!githubConfig || !githubToken){ setSyncStatus('offline'); return; }
  setSyncStatus('pending');
  clearTimeout(autoSyncTimer);
  autoSyncTimer = setTimeout(runAutoSync, 1200);
}

async function runAutoSync(){
  if (!githubConfig || !githubToken) return;
  if (autoSyncInFlight){ autoSyncQueued = true; return; }
  autoSyncInFlight = true;
  autoSyncQueued = false;
  setSyncStatus('syncing');
  try{
    const payload = { salt: ENC_STORE.salt, iterations: ENC_STORE.iterations, records, users, maintenanceLogs };
    const newSha = await githubApiPut(githubConfig, githubToken, payload, githubSha, '자산 데이터 자동 동기화 - ' + new Date().toLocaleString('ko-KR'));
    githubSha = newSha;
    setSyncStatus('synced');
  }catch(e){
    console.error('자동 동기화 실패:', e);
    setSyncStatus('error', e.message);
  }finally{
    autoSyncInFlight = false;
    if (autoSyncQueued){ runAutoSync(); }
  }
}

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
      githubConfig = cfg; githubToken = token; githubSha = sha;
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
})().catch(err => {
  console.error('데이터 로드 실패:', err);
});

let sessionKey = null;      // CryptoKey, present only after unlock
let viewOnly = false;
let records = [];           // working array (mutable, in-memory)
let users = [];              // registered users (working array, in-memory) — {id, name}
let maintenanceLogs = [];    // 월별 점검 이력 (working array, in-memory) — {id, group, ym, date, manager, note, author, updated_at}
let expandedGroups = new Set();
let activeStatusFilters = new Set(['ok','warn','na']);
let activeCountryFilter = null;
let activeSkuKeywordFilters = new Set();
let activeMyAssetsFilter = false; // 로그인한 사용자가 정 담당자인 사이트(법인)만 보기
let workLogRecordId = null; // which record's modal is currently open
let workLogEditId = null;   // work-log entry id currently being edited (null = adding new)
let editingRecordId = null; // asset record id currently being edited via addModal (null = adding new)
let addAssetTargetGid = null; // 특정 법인에 자산을 추가 중일 때 그 법인의 group id (null = 완전히 새 법인 추가)

// SKU에 매칭되는 태그(MC/ASG/ISG 등)를 기반으로 이 자산을 대표하는 짧은 이름을 만든다.
// SKU 자체가 비어 있을 때 등, 사람이 읽을 표시용 이름이 필요한 곳(이동/이력 안내 문구 등)에서 사용한다.
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
// A second, independent tagging layer: any of these rules matched against
// the SKU string gets its own small tag rendered below the main SKU badge,
// and doubles as a sidebar filter + search term. Each rule's displayed
// "key" can differ from the text it matches (e.g. SKUs starting with
// "IS-" are labeled "BCIS" rather than "IS").
const SKU_TAG_RULES = [
  { key:'BCIS', test: sku => sku.toUpperCase().startsWith('IS-') },
  { key:'ASG',  test: sku => sku.toUpperCase().includes('ASG') },
  { key:'MC',   test: sku => sku.toUpperCase().startsWith('MC-') || sku.toUpperCase().includes('-MC') },
  { key:'RP',   test: sku => sku.toUpperCase().includes('RP') },
  { key:'ISG',  test: sku => sku.toUpperCase().includes('ISG') },
  { key:'SG',   test: sku => sku.toUpperCase().includes('SG') && !sku.toUpperCase().startsWith('ASG-S') },
  { key:'PS',   test: sku => sku.toUpperCase().includes('PS') },
  { key:'SSP',  test: sku => sku.toUpperCase().includes('SSP') },
  { key:'VA',   test: sku => sku.toUpperCase().includes('VA') },
  { key:'ELK',  test: sku => sku.toUpperCase().includes('ELK') },
  { key:'CLD',  test: sku => sku.toUpperCase().includes('CLD') },
  { key:'BCWF', test: sku => sku.toUpperCase().includes('BCWF') },
  { key:'WSS',  test: sku => sku.toUpperCase().includes('WSS') },
  { key:'WPS',  test: sku => sku.toUpperCase() === 'WEB-PROTECT-SUB' },
  { key:'CA',   test: sku => sku.toUpperCase().startsWith('CAS-') },
  { key:'MA',   test: sku => sku.toUpperCase().startsWith('MA-') },
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

// 마스터 비밀번호로 한 번 잠금 해제하면, 그 세션 키를 24시간 동안 이 브라우저에 캐시해 둔다.
// 캐시가 유효한 동안은 마스터 비밀번호 입력 화면 없이 자동으로 잠금 해제된 상태로 시작한다.
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

// 캐시된 키로 조용히 잠금 해제를 시도한다. 캐시가 없거나 만료됐거나, data.json이 그 사이
// 바뀌어 salt/iterations가 달라졌거나, 실제 복호화 검증에 실패하면 false를 반환하고 캐시를 지운다.
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
  // verify against first record that actually has an encrypted field
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
  // 법인명 등에 실수로 HTML 이스케이프(&amp; 등)가 그대로 텍스트로 저장돼 있다면 원래 문자로 되돌린다.
  const entitiesFixed = migrateStrayHtmlEntities();
  // 과거 버전에서 잘못 생성될 수 있었던 custom-NaN / dup-NaN 그룹을 먼저 분리한다.
  // 이 보정은 owner 일관성 보정보다 반드시 먼저 실행되어야 서로 다른 법인명이 한 법인명으로 덮이지 않는다.
  const brokenGroupFixed = repairKnownBrokenGeneratedGroups();
  // 법인만 먼저 만든 뒤 생긴 빈 레코드는 실제 자산이 아니라 법인 정보를 보존하는 shell 레코드로 정리한다.
  const shellFixed = migrateEmptyGroupPlaceholders();
  // 법인만 먼저 만들 때 shell에 입력해 둔 Support ID/구축 정보와, 이후 첫 자산(특히 이동된 자산)의
  // 기존 Support ID가 충돌하면 새 법인에서 Support ID가 2개로 보일 수 있다. 이 경우 새 법인 생성 시
  // 사용자가 지정한 shell의 Support ID를 우선값으로 보고 첫 실제 자산에 승계한다.
  const shellSupportFixed = normalizeShellSupportDefaults();
  // 예전 버전에서 "자산 정보 직접 수정" 화면으로 법인명 등을 자산 하나만 따로 바꿀 수 있었던 적이
  // 있어서 같은 법인(그룹) 안에서 값이 어긋난 데이터가 있다면 그룹의 대표 값으로 다시 맞춘다.
  const ownerFixed = migrateOwnerConsistencyWithinGroups();
  // 예전 데이터에 남아 있는 고객사 담당자 구분 "운용" 표기를 "운영"으로 정리한다.
  migrateCustContactRoleLabels();
  // 예전 데이터 중 상위 법인 자신에게 직접 연결된 Support ID/자산이 남아 있다면
  // (규칙 도입 이전 데이터 등) 첫 번째 자식 법인으로 자동 이전한다.
  const migrated = enforceParentsHaveNoDirectAssets();
  render();
  requestAnimationFrame(() => { syncGlobalHeaderHeight(); syncStickyOffsets(); });
  if ((migrated || entitiesFixed || brokenGroupFixed || shellFixed || shellSupportFixed || ownerFixed) && !viewOnly && sessionKey){
    buildFilters();
    scheduleAutoSync();
  }
}

// ---------- date / status ----------
// 법인명(owner)을 비롯한 국가/위치/점검방식/구성방식/담당 엔지니어/비고/상위 법인 등은 원래
// "자산 하나하나"가 아니라 "법인(그룹) 전체"가 공유하는 정보다. 그런데 예전 버전에서는 "자산 정보
// 직접 수정" 화면에서 법인명 등을 자산 하나만 골라 따로 바꿀 수 있었던 적이 있어서, 같은 그룹
// 안인데도 자산 레코드마다 법인명이 서로 달라지는 데이터가 생길 수 있었다. 이 경우 화면에는
// 카드 제목은 원래 법인명 그대로 보이지만, 그 안의 특정 자산 한 줄만 "다른 법인 아래에 잘못
// 끼어든 것처럼" 보이는 문제가 생긴다. 여기서는 그렇게 어긋난 값들을 그룹의 대표 값(groupMeta
// 기준)으로 다시 맞춰서, 같은 그룹의 모든 레코드가 항상 같은 값을 갖도록 정리한다.
// (지금 버전에서는 자산 수정 화면에서 이 필드들을 바꿀 수 없게 막아 두었으므로, 앞으로 새로
// 이런 데이터가 생기지는 않는다. 아래 마이그레이션은 이미 어긋나 있던 예전 데이터를 정리하는
// 1회성 보정용이다.)
const GROUP_COMMON_SCALAR_FIELDS = [
  'flag','owner','country','location','check_method','config_mode',
  'owner_primary','owner_secondary','group_remarks','group_parent','is_parent'
];
function migrateOwnerConsistencyWithinGroups(){
  let changed = false;
  groupRecords(records).forEach((items) => {
    const meta = groupMeta(items);
    items.forEach(r => {
      GROUP_COMMON_SCALAR_FIELDS.forEach(f => {
        // groupMeta()가 실제 값이 하나도 없을 때 화면 표시용으로만 채우는 자리표시자
        // ('(법인명 미확인)')는 데이터에 그대로 써넣지 않는다.
        if (f === 'owner' && meta.owner === '(법인명 미확인)') return;
        const target = meta[f];
        if (r[f] !== target && !(!r[f] && !target)){ r[f] = target; changed = true; }
      });
    });
  });
  return changed;
}

// 예전 데이터(또는 외부에서 복사해 붙여넣은 값) 중 "A&amp;B 법인"처럼 HTML 이스케이프 문자열이
// 실수로 그대로 텍스트에 저장돼 있으면, 화면에서는 esc()가 한 번 더 이스케이프해 버려
// "A&amp;amp;B 법인"처럼 깨져 보인다. 그런 값이 있으면 원래 문자("A&B 법인")로 되돌려 둔다.
// 이미 정상적으로 저장된 값("A&B 법인")은 이 패턴에 걸리지 않으므로 그대로 둔다.
function unescapeStrayHtmlEntities(s){
  if (!s || typeof s !== 'string') return s;
  if (!/&(amp|lt|gt|quot|#39);/.test(s)) return s;
  return s.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'");
}
const STRAY_ENTITY_FIELDS = ['owner','country','location','check_method','config_mode','owner_primary','owner_secondary','group_remarks','remarks','sku','sn'];
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

// 예전 데이터에 저장된 고객사 담당자 구분 "운용" 표기를 새 표기인 "운영"으로 바꿔 둔다.
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
function licenseBarPct(rec){
  const start = parseDate(rec.start), end = parseDate(rec.end);
  if (!start || !end || end <= start) return 100;
  const now = new Date();
  const pct = ((now-start)/(end-start))*100;
  return Math.max(0, Math.min(100, pct));
}
// 오늘(자정 기준)로부터 라이선스 종료일까지 남은 일수. 종료일이 없으면 null.
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
// 예전 코드는 Math.max(...records.map(r=>r.id))에 의존했기 때문에 id 중 하나라도
// 숫자로 변환할 수 없는 값(undefined/문자열 등)이 섞이면 newId가 NaN이 되고,
// 이후 새 법인이 모두 같은 'custom-NaN' 그룹으로 합쳐질 수 있었다.
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

// 실제 자산 고유 정보가 하나도 없는 레코드는 '법인만 먼저 생성'할 때 만들어진
// 자리표시자다. 화면에서 1건짜리 빈 자산으로 보이면 안 되므로 shell로 취급한다.
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

// 법인을 먼저 생성하면 Support ID/구축 엔지니어/구축 일자는 shell 레코드에 임시 보관된다.
// 그 뒤 첫 자산을 '이동'으로 넣으면 자산이 원래 법인의 Support ID를 그대로 들고 와서
// shell의 Support ID와 합쳐져 2개처럼 보일 수 있다. 새 법인에 실제 자산이 처음 생긴 시점에는
// shell에 명시적으로 저장된 값을 그 법인의 기본 Support 정보로 보고 실제 자산으로 승계한다.
// 이미 실제 자산이 여러 Support ID로 나뉜 법인은 의도된 다중 Support ID일 수 있으므로 건드리지 않는다.
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
    // 실제 자산이 아직 Support ID가 없거나, 모두 하나의 동일한 옛 Support ID만 갖고 있으면
    // 법인 생성 시 지정한 Support ID가 더 신뢰할 수 있는 값이다.
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

// 과거 ID 생성 실패로 생긴 'custom-NaN' / 'dup-NaN' 그룹만 매우 보수적으로 복구한다.
// 서로 다른 owner가 한 그룹에 들어가 있으면 owner별로 분리하고, owner까지 같더라도
// 빈 자리표시자가 여러 개라면 두 번째 자리표시자부터 독립 법인 그룹으로 분리한다.
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
  // Prefer the new multi-contact array field; fall back to legacy single
  // cust_contact/cust_phone/cust_email fields for older data.
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
    group_remarks: items.map(i=>i.group_remarks).find(Boolean) || '',
    group_parent: items.map(i=>i.group_parent).find(Boolean) || '',
    // is_parent: 이 법인 자체가 (체크박스로 명시적으로 지정된) 상위 법인인지 여부.
    // 실제로 이 법인을 부모로 지정한 자식 법인이 있는 경우(groupChildrenOf)는
    // enforceParentsHaveNoDirectAssets에서 항상 true로 맞춰 준다.
    is_parent: items.some(i => !!i.is_parent)
  };
}

// ---------- 법인 간 부모-자식 관계 ----------
// group_parent: 자식 법인 쪽 레코드들에 저장되는, 상위(부모) 법인의 group id.
// (다른 그룹 공통 필드와 마찬가지로 같은 group의 모든 레코드에 동일하게 저장한다.)
// 부모-자식으로 연결된 법인들은 서로 Support ID를 공유해서 보여주기 위해,
// "가족"(부모 + 모든 자식, 자식의 자식까지 포함한 연결 요소) 단위로 묶어서 다룬다.
function allGroupIds(){
  return [...new Set(records.map(r=>r.group))];
}
function groupParentOf(gid){
  const parent = records.filter(r=>r.group===gid).map(i=>i.group_parent).find(Boolean) || '';
  // 부모로 지정됐던 법인이 그 사이 삭제됐다면(더 이상 존재하지 않으면) 관계가 끊긴 것으로 취급한다.
  if (parent && !records.some(r=>r.group===parent)) return '';
  return parent;
}
function groupChildrenOf(gid){
  return allGroupIds().filter(g => g!==gid && groupParentOf(g)===gid);
}
// gid의 모든 하위(자식, 손자…) 법인 id 집합 — 부모 선택 시 순환 관계를 막는 데 사용.
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
// gid를 포함해 자신과 모든 하위(자식, 손자…) 법인에 속한 실제 자산(shell 레코드 제외)의 총 건수.
// 상위 법인 카드의 "항목" 수치에 사용 — 상위 법인은 자산을 직접 갖지 않으므로 자기 자신의
// 건수 대신 하위 법인 전체의 자산 총합을 보여줘야 의미가 있다.
function groupTotalItemCount(gid){
  const ids = new Set([gid, ...groupDescendantIds(gid)]);
  return records.filter(r => ids.has(r.group) && !r.is_group_shell).length;
}
// gid를 포함해 부모-자식 관계로 연결된 모든 법인 id (연결 요소 전체)를 반환한다.
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
// 상위 법인은 대표 이름 역할만 하고, Support ID/자산은 항상 하위(자식) 법인에 속해야 한다.
// 자식이 있는 법인(gid)에 그 자신에게 직접 붙어 있는 자산 항목이 남아 있다면,
// (부모-자식 관계가 방금 새로 생겼거나, 예전 데이터에 남아 있던 경우 등) 첫 번째 자식 법인으로
// 자동 이전한다 — 이동 시 자산 고유 정보(SKU/S/N/라이선스/IP 등)는 그대로 유지하고,
// 법인 공통 정보(법인명/국가/위치/점검방식/구성방식/담당자/고객사담당자/상위법인)만 자식 법인 기준으로 맞춘다.
function enforceParentsHaveNoDirectAssets(){
  let changed = false;
  allGroupIds().forEach(gid => {
    const children = groupChildrenOf(gid);
    if (!children.length) return;
    // 실제로 자식 법인을 둔 법인은 (체크박스로 지정하지 않았더라도, 또는 예전 데이터라도)
    // 항상 상위 법인으로 취급한다 — 상위 법인 드롭다운에 계속 나타나도록 플래그를 맞춰 둔다.
    records.filter(r => r.group === gid).forEach(r => { r.is_parent = true; });
    // "이름표" 역할의 shell 레코드(is_group_shell)는 실제 자산이 아니므로 이전 대상에서 제외한다.
    const ownRecs = records.filter(r => r.group === gid && !r.is_group_shell);
    if (!ownRecs.length) return;
    // 자식 법인이 사라지지 않도록, 이전 전에 부모 자신의 법인 정보(이름/국가/위치 등)를 스냅샷해 둔다.
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
      rec.cust_contact = ''; rec.cust_phone = ''; rec.cust_email = '';
      rec.group_remarks = meta.group_remarks;
      rec.group_parent = meta.group_parent;
      rec.is_parent = meta.is_parent;
    });

    // 부모 법인 자신에게 자산이 하나도 남지 않았다면, 대표 이름/국가/위치 등을 계속 보여줄 수 있도록
    // 자산이 아닌 "이름표" 전용 shell 레코드를 하나 남겨 둔다 (목록/테이블에는 표시되지 않음).
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
// 이 법인이 다른 법인과 부모-자식 관계로 연결되어 있는지 (자기 자신만 있으면 false)
function groupHasFamily(gid){
  return groupFamilyIds(gid).size > 1;
}
// gid 자신과, 부모를 따라 올라가는 모든 상위 법인까지 함께 펼친 상태로 만든다.
// 자식 법인 카드는 부모 카드가 펼쳐져 있어야만 화면에 보이므로, 특정 법인을 확실히 보여주려면
// 조상 법인까지 모두 펼쳐야 한다.
function expandGroupWithAncestors(gid){
  let cur = gid;
  const guard = new Set();
  while (cur && !guard.has(cur)){
    guard.add(cur);
    expandedGroups.add(cur);
    cur = groupParentOf(cur);
  }
}
// gid 자신과 모든 하위(자식, 손자…) 법인까지 함께 펼친 상태로 만든다.
// 부모 법인을 펼칠 때 중첩된 자식 법인 카드도 매번 따로 클릭하지 않아도 바로 펼쳐지도록 한다.
function expandGroupWithDescendants(gid){
  expandedGroups.add(gid);
  groupDescendantIds(gid).forEach(cg => expandedGroups.add(cg));
}
// gid 자신과 모든 하위(자식, 손자…) 법인의 펼침 상태를 함께 접는다.
function collapseGroupWithDescendants(gid){
  expandedGroups.delete(gid);
  groupDescendantIds(gid).forEach(cg => expandedGroups.delete(cg));
}
// 연결된 가족 전체(자기 자신 포함)에 속한 자산들의 Support ID를 모두 모아 중복 없이 반환.
function familySupportIds(gid){
  const fam = groupFamilyIds(gid);
  const ids = new Set();
  fam.forEach(fg => {
    ownSupportIds(records.filter(r => r.group === fg)).forEach(sid => ids.add(sid));
  });
  return [...ids].sort((a,b)=>a.localeCompare(b,'ko'));
}
// 이 법인 자신의 Support ID 목록. 실제 자산이 하나라도 있으면 shell 레코드의 임시 Support ID는
// 표시/집계에서 제외한다. 실제 자산이 전혀 없는 '법인만 생성된 상태'에서만 shell 값을 대신 보여준다.
// 이렇게 해야 첫 자산 이동 후 shell의 신규 SID + 자산의 기존 SID가 2개로 보이는 현상이 생기지 않는다.
function ownSupportIds(items){
  const realItems = items.filter(r => !r.is_group_shell);
  const source = realItems.length ? realItems : items.filter(r => r.is_group_shell);
  const ids = new Set();
  source.forEach(r => { if ((r.support_id||'').trim()) ids.add(r.support_id.trim()); });
  return [...ids].sort((a,b)=>a.localeCompare(b,'ko'));
}
// 법인 정보에 표시할 Support ID 목록 — 부모-자식 관계가 있으면 가족 전체, 없으면 이 법인 자신의 것만.
function displaySupportIds(gid, items){
  return groupHasFamily(gid) ? familySupportIds(gid) : ownSupportIds(items);
}

// ---------- Support ID 단위 하위 그룹 (같은 법인 안에서 Support ID가 여러 개인 경우) ----------
// 법인(그룹)은 국가/위치/점검방식/구성방식/담당 엔지니어/고객사 담당자를 공유하고,
// 그 아래 Support ID별로 구축 엔지니어/구축 일자와 자산 항목들을 따로 관리한다.
function subGroupMeta(items){
  return {
    support_id: items.map(i=>i.support_id).find(Boolean) || '',
    build_engineer: items.map(i=>i.build_engineer).find(Boolean) || '',
    build_date: items.map(i=>i.build_date).find(Boolean) || ''
  };
}
function buildSubGroups(items){
  // 실제 자산이 존재하는 법인에서는 shell은 법인 이름표/초기 입력 보관용일 뿐 Support ID 하위 그룹이 아니다.
  // 실제 자산이 하나도 없을 때만 shell을 사용해 법인 생성 시 입력한 Support ID/구축 정보를 편집 가능하게 한다.
  const realItems = items.filter(r => !r.is_group_shell);
  const sourceItems = realItems.length ? realItems : items.filter(r => r.is_group_shell);
  const map = new Map();
  for (const it of sourceItems){
    const key = (it.support_id||'').trim();
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(it);
  }
  const arr = [...map.entries()].map(([sid, its]) => ({ sid, items: its, meta: subGroupMeta(its) }));
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
  const extraCls = kind === 'ip' ? ' sec-val-ip' : '';
  return `<span class="sec-val${extraCls}" id="disp_${id}" data-copy-id="${rec.id}" data-copy-kind="${kind}" title="클릭하여 복사">…</span>`;
}

// IP 주소는 자산 하나에 여러 개(줄바꿈 또는 쉼표로 구분) 저장될 수 있으므로,
// 잠금 해제 후에는 하나의 텍스트 블록이 아니라 각각 따로 클릭해서 복사할 수 있는
// 칩(chip) 목록으로 풀어서 보여준다.
function renderIpChips(wrapEl, val){
  wrapEl.classList.remove('sec-val', 'locked', 'empty');
  wrapEl.classList.add('ip-chip-list');
  wrapEl.removeAttribute('title');
  const ips = (val||'').split(/[\n,]+/).map(s=>s.trim()).filter(Boolean);
  if (!ips.length){
    wrapEl.innerHTML = `<span class="ip-chip-empty">—</span>`;
    wrapEl.onclick = null;
    return;
  }
  wrapEl.innerHTML = ips.map(ip => `<span class="ip-chip" title="클릭하여 복사">${esc(ip)}</span>`).join('');
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
  // 개별 칩이 자체 클릭 핸들러를 가지므로, 칩 사이 여백을 클릭했을 때
  // 예전 "전체 복사" 핸들러가 대신 실행되며 칩 목록을 깨뜨리지 않도록 비활성화한다.
  wrapEl.onclick = null;
}

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
    if (kind === 'ip'){
      renderIpChips(el, val);
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

// ---------- 대시보드 (OS 버전별 / 태그별 / 위치별 / 국가별 / SKU별 현황 한눈에 보기) ----------
let dashboardMode = false;
let maintenanceMode = false;

// keyFn으로 묶은 뒤, 각 그룹에 해당하는 원본 항목 배열도 함께 반환한다.
// (건수만 필요한 곳은 count만 쓰고, 클릭 시 상세 법인 목록이 필요한 곳은 items를 쓴다.)
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

// 국가는 이제 별도 필드(country)로 입력받는다. 다만 이 필드가 도입되기 전 기존 데이터는
// location 필드에 "국가 도시"처럼 섞여 들어가 있을 수 있어, country가 비어 있으면
// location의 첫 단어를 국가로 대신 추정하는 이전 방식으로 대체(fallback)한다.
function countryOf(r){
  const c = (r.country||'').trim();
  if (c) return c;
  const s = (r.location||'').trim();
  if (!s) return '';
  return s.split(/\s+/)[0];
}

// OS 버전 필드는 자유 입력이라 "CentOS 7.4", "Windows Server 2016", 혹은 버전 표기가
// 전혀 없는 값(제품명만 적혀 있거나 공란)이 섞여 있다. 대시보드에서는 실제 버전 번호를
// 태그처럼 뽑아낼 수 있는 값만 모아서 보여주고, 버전 정보가 없는 값은 제외한다.
function osVersionTag(osVer){
  const s = (osVer||'').trim();
  if (!s) return null;
  const m = s.match(/\d+(?:\.\d+){0,3}/);
  return m ? m[0] : null;
}

const DASH_VISIBLE_ROWS = 16; // 대시보드 각 카드에 기본으로 보이는 행 수 (기존 8행의 2배)

// 특정 OS 버전 / SKU 항목을 클릭했을 때 그 아래에 펼쳐 보여줄 "사용 법인 목록".
function dashboardCompanyListHtml(items){
  const owners = bucketGroups(items, r => r.owner).map(([owner,count]) => [owner, count]);
  if (!owners.length) return `<div class="dash-empty">법인 정보가 없습니다.</div>`;
  return `<ul class="dash-company-list">${owners.map(([owner,count]) =>
    `<li><span class="dash-company-name">${esc(owner)}</span><span class="dash-company-count">${count}건</span></li>`
  ).join('')}</ul>`;
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
    // "더보기"로 펼쳐질 행들을 버튼보다 먼저(위에) 배치하고, 버튼은 그 아래에 둬서
    // 펼친 뒤에도 "더보기" 버튼이 항상 카드 맨 아래에 위치하도록 한다.
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

// 한 자산이 여러 태그에 동시에 매칭될 수 있으므로(예: ISG-100은 ISG와 SG 둘 다 매칭),
// 태그별 통계는 bucketGroups처럼 항목당 버킷 하나가 아니라, 매칭되는 태그마다 항목을 중복해서 센다.
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

  // OS 버전별: 장비(SKU) 태그별로 나눠서, 같은 태그가 붙은 장비들의 버전만 모아서 보여준다.
  // (예: MC 태그가 붙은 장비들의 버전 모음, ISG 태그가 붙은 장비들의 버전 모음 …)
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

  const byTag = bucketByTags(assetRecords);
  const byLocation = bucketGroups(assetRecords, r => r.location);
  const byCountry = bucketGroups(assetRecords, r => countryOf(r));
  const bySku = bucketGroups(assetRecords, r => r.sku);

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
      ${dashboardSectionHtml('tag', '태그별 · 클릭하면 사용 법인 표시', 'dash-c2', byTag, true)}
      ${dashboardSectionHtml('location', '위치별', 'dash-c3', byLocation, false)}
      ${dashboardSectionHtml('country', '국가별', 'dash-c4', byCountry, false)}
      ${dashboardSectionHtml('sku', 'SKU별 · 클릭하면 사용 법인 표시', 'dash-c5', bySku, true)}
    </div>
  `;
}

// 목록 / 대시보드 / 유지보수 세 화면은 항상 하나만 보이므로 한 곳에서 전환한다.
let currentViewMode = 'list'; // 'list' | 'dashboard' | 'maintenance'
function setViewMode(mode){
  currentViewMode = mode;
  dashboardMode = (mode === 'dashboard');
  maintenanceMode = (mode === 'maintenance');
  const contentEl = document.getElementById('content');
  const dashEl = document.getElementById('dashboardView');
  const maintEl = document.getElementById('maintenanceView');
  const dashBtn = document.getElementById('dashboardToggle');
  const maintBtn = document.getElementById('maintenanceToggle');
  if (contentEl) contentEl.style.display = (mode === 'list') ? '' : 'none';
  if (dashEl) dashEl.style.display = (mode === 'dashboard') ? '' : 'none';
  if (maintEl) maintEl.style.display = (mode === 'maintenance') ? '' : 'none';
  if (dashBtn) dashBtn.classList.toggle('on', mode === 'dashboard');
  if (maintBtn) maintBtn.classList.toggle('on', mode === 'maintenance');
  if (mode === 'dashboard') renderDashboard();
  if (mode === 'maintenance') renderMaintenance();
}
// 기존 호출부(예: boot 이후 재렌더 로직)와의 호환을 위해 이름은 남겨 둔다.
function setDashboardMode(on){ setViewMode(on ? 'dashboard' : 'list'); }

document.getElementById('dashboardToggle').onclick = () => setViewMode(dashboardMode ? 'list' : 'dashboard');
document.getElementById('maintenanceToggle').onclick = () => setViewMode(maintenanceMode ? 'list' : 'maintenance');

// 대시보드는 매번 innerHTML을 통째로 새로 그리므로, 개별 행/버튼에 onclick을 직접 붙이지 않고
// 컨테이너 하나에 위임(delegation)으로 클릭을 처리한다.
document.getElementById('dashboardView').addEventListener('click', (e) => {
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
// 2026년 1월부터, 등록된 각 법인(사이트)에 대해 그 달의 점검을 언제(누가) 했는지 기록하고
// 통계(월별 완료율 / 법인별 점검율 / 누락 이력)를 볼 수 있게 한다.
// 데이터는 records/users와 마찬가지로 maintenanceLogs 배열에 담아 GitHub와 함께 동기화된다.

let maintenanceTab = 'entry'; // 'entry'(점검지) | 'stats'(통계)
let maintenanceYear = null;   // 등록 탭에서 현재 보고 있는 연도(숫자). 한 화면에 이 연도의 1~12월이 모두 나온다.
let maintenanceEditTarget = null; // 점검 등록 모달에서 현재 편집 중인 {gid, ym}
let maintenanceMyFilter = false; // 유지보수 페이지: 내가 정 담당자인 법인만 보기

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
// 2026-01부터 주어진 ym(포함)까지의 "YYYY-MM" 목록. 미래 달까지 잘못 넘어오는 경우를 대비해
// 최소한 2026-01 하나는 항상 포함되도록 보정한다.
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
// 유지보수 관리 대상 법인 목록 — 독립법인(상위/하위 관계가 없는 법인) 또는 상위법인만 대상으로 한다.
// 하위 법인(다른 법인 아래에 속한 자식 법인)은 상위 법인 단위로 함께 관리되므로 목록에서 제외한다.
// (상위 법인 자체는 대표 이름표 역할이라 실제 자산 레코드가 없을 수 있으므로, 실제 자산 유무와
//  무관하게 포함한다. 독립법인은 실제 자산이 있는 경우에만 대상으로 삼는다.)
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
// "내가 정 담당자인 법인만" 필터가 켜져 있으면 그 조건을 적용한 목록을 반환한다.
// (모달에서 특정 gid로 법인을 찾을 때는 필터와 무관하게 항상 전체 목록인 maintenanceGroupList()를 써야 한다.)
function maintenanceVisibleGroupList(){
  const groups = maintenanceGroupList();
  if (!maintenanceMyFilter) return groups;
  const me = currentUserName();
  if (!me) return groups;
  return groups.filter(g => g.meta.owner_primary === me);
}

function setMaintenanceTab(tab){
  maintenanceTab = tab;
  renderMaintenance();
}

// 점검지 탭: 좌측에 법인 정보, 우측에 선택한 연도의 1월~12월이 한 화면에 표(스프레드시트)로 나온다.
// 각 달 칸을 클릭하면 그 법인 · 그 달의 점검 등록 모달(openMaintenanceLogModal)이 뜬다.
const MAINT_MONTHS = [1,2,3,4,5,6,7,8,9,10,11,12];

function maintenanceEntryTabHtml(){
  if (!maintenanceYear) maintenanceYear = Math.max(2026, currentYm().split('-').map(Number)[0]);
  const groups = maintenanceVisibleGroupList();
  const me = currentUserName();
  const myCount = maintenanceGroupList().filter(g => me && g.meta.owner_primary === me).length;
  const thisYm = currentYm();

  const bodyRows = groups.map(g => {
    // 계약만료 D-Day: 이 법인 및 하위(자식) 법인들에 포함된 모든 자산 중 라이선스 기간이
    // 가장 짧게(가장 급하게) 남은 것을 기준으로 한다.
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

    const engineerHtml = g.meta.owner_primary
      ? `<span class="mgr-primary">${esc(g.meta.owner_primary)}</span>`
      : '<span class="maint-td-empty">-</span>';

    const monthCellsHtml = MAINT_MONTHS.map(m => {
      const ym = `${maintenanceYear}-${pad2(m)}`;
      const log = maintenanceLogFor(g.gid, ym);
      const isCurrent = ym === thisYm;
      const hasDate = log && (log.date || '').trim();
      if (hasDate){
        const d = parseDate(log.date);
        const dayNum = d ? d.getDate() : '';
        const isDone = !!log.done;
        const tipBits = [`${ymLabel(ym)} 점검일 ${log.date}`, isDone ? '완료' : '예약'];
        if (log.manager) tipBits.push(`담당 ${log.manager}`);
        if (log.note) tipBits.push(log.note);
        const statusCls = isDone ? 'maint-cell-done' : 'maint-cell-reserved';
        const statusTag = isDone ? '완' : '예';
        return `<td class="maint-cell ${statusCls} ${isCurrent?'is-current':''}" data-maint-cell="${esc(g.gid)}|${ym}" title="${esc(tipBits.join(' · '))}">
          <span class="maint-cell-day">${esc(String(dayNum))}</span><span class="maint-cell-tag">${statusTag}</span>
        </td>`;
      }
      return `<td class="maint-cell maint-cell-blank ${isCurrent?'is-current':''}" data-maint-cell="${esc(g.gid)}|${ym}" title="${esc(ymLabel(ym))} 점검 등록">
        <span class="maint-cell-dash">–</span>
      </td>`;
    }).join('');

    return `
      <tr>
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
      <button type="button" class="my-assets-toggle maint-my-toggle ${maintenanceMyFilter?'active':''}" id="maintMyToggle" ${!me?'disabled':''} title="${me?'내가 정 담당자인 법인만 보기':'로그인이 필요합니다.'}">
        <span class="mat-label">내가 정인 법인만</span>
        <span class="mat-count">${myCount}</span>
      </button>
      <p class="maint-year-hint">각 달 칸을 클릭하면 점검일 · 점검 담당자 · 비고를 등록/수정할 수 있습니다. (완료 체크 안 하면 예약, 체크하면 완료로 표시)</p>
    </div>
    <div class="maint-table-wrap maint-year-table-wrap">
      <table class="maint-table maint-year-table">
        <thead>
          <tr>
            <th class="maint-th-owner" rowspan="2">사업장</th>
            <th rowspan="2">계약만료<br>D-Day</th>
            <th rowspan="2">담당</th>
            <th colspan="12">점검일자 (${maintenanceYear})</th>
          </tr>
          <tr>${MAINT_MONTHS.map(m => `<th class="maint-th-month">${m}월</th>`).join('')}</tr>
        </thead>
        <tbody>${bodyRows || `<tr><td colspan="15"><div class="maint-empty">등록된 법인이 없습니다. 먼저 좌측 ＋ 버튼으로 법인을 등록해 주세요.</div></td></tr>`}</tbody>
      </table>
    </div>`;
}

// 각 법인의 "평균 점검일"(1~31)을 계산해 날짜별 버킷으로 묶는다.
// 법인마다 지금까지 등록된 점검일들의 평균을 하루 단위로 반올림해 하나의 날짜에 배치하고,
// 같은 날짜에 몰린 법인이 많을수록 그 날짜가 "바쁜 시기"임을 막대 높이로 가늠할 수 있게 한다.
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
    const names = entries
      .slice().sort((a,b)=>a.avg-b.avg)
      .map(e => `${e.owner} (평균 ${e.avg.toFixed(1)}일)`)
      .join(', ');
    const tip = hasData ? `${day}일 평균: ${names}` : `${day}일: 없음`;
    return `
      <div class="maint-day-col" title="${esc(tip)}">
        <div class="maint-day-bar ${hasData?'':'empty'}" style="height:${heightPct}%;">${hasData?`<span class="maint-day-count">${entries.length}</span>`:''}</div>
        <div class="maint-day-daylabel ${day%5===0||day===1?'strong':''}">${day}</div>
      </div>`;
  }).join('');
  return `<div class="maint-day-chart">${cols}</div>`;
}

// 담당자(정/부)별로 맡고 있는 법인을 점검 방식별로 집계한다.
// 결과는 Map<이름, { methods: Map<점검방식, {primary, secondary}>, primaryGroups: string[], secondaryGroups: string[] }>
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
      u.primaryGroups.push(g.meta.owner);
    }
    if (secondary){
      const u = ensure(secondary);
      const m = u.methods.get(method) || { primary: 0, secondary: 0 };
      m.secondary += 1;
      u.methods.set(method, m);
      u.secondaryGroups.push(g.meta.owner);
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
      ? u.primaryGroups.slice().sort((a,b)=>a.localeCompare(b,'ko')).map(o => `<span class="maint-site-chip primary">${esc(o)}</span>`).join('')
      : `<span class="maint-td-empty">-</span>`;
    const secondaryChips = u.secondaryGroups.length
      ? u.secondaryGroups.slice().sort((a,b)=>a.localeCompare(b,'ko')).map(o => `<span class="maint-site-chip secondary">${esc(o)}</span>`).join('')
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
          <div class="maint-missed-list">${primaryChips}</div>
        </div>
        <div class="maint-user-site-group">
          <div class="maint-user-site-label">부 담당 법인</div>
          <div class="maint-missed-list">${secondaryChips}</div>
        </div>
      </div>`;
  }).join('');

  return `<div class="maint-user-summary-list">${cardsHtml}</div>`;
}

function maintenanceStatsTabHtml(){
  const groups = maintenanceVisibleGroupList();
  const months = monthsFrom202601To(currentYm());

  // 월별 완료율 (최근 달이 위로 오도록 역순 표시)
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

  // 법인별 점검율 (2026-01 이후 전체 기간 기준) — 낮은 순으로 정렬해 관리가 필요한 법인이 위로 오게 한다.
  const groupStats = groups.map(g => {
    const doneMonths = months.filter(ym => {
      const log = maintenanceLogFor(g.gid, ym);
      return log && (log.date||'').trim();
    });
    const missedMonths = months.filter(ym => !doneMonths.includes(ym));
    const rate = months.length ? Math.round(doneMonths.length/months.length*100) : 0;
    const logsSorted = maintenanceLogsForGroup(g.gid).filter(l=>(l.date||'').trim()).sort((a,b)=>{
      const da = parseDate(a.date), db = parseDate(b.date);
      if (da && db) return db - da;
      return 0;
    });
    const lastCheck = logsSorted.length ? logsSorted[0].date : '';
    return { gid: g.gid, owner: g.meta.owner, rate, missedMonths, lastCheck };
  }).sort((a,b) => a.rate - b.rate);

  const groupRowsHtml = groupStats.map(s => {
    const rateCls = s.rate >= 80 ? 'high' : (s.rate >= 50 ? 'mid' : 'low');
    const missedHtml = s.missedMonths.length
      ? `<div class="maint-missed-list">${s.missedMonths.slice(0,6).map(ym=>`<span class="maint-missed-chip">${esc(ymLabel(ym))}</span>`).join('')}${s.missedMonths.length>6?`<span class="maint-missed-chip">외 ${s.missedMonths.length-6}개월</span>`:''}</div>`
      : `<span class="maint-status-badge done">누락 없음</span>`;
    return `
      <tr>
        <td data-label="법인"><div class="maint-row-owner">${esc(s.owner)}</div></td>
        <td data-label="점검율" class="maint-rate-cell ${rateCls}">${s.rate}%</td>
        <td data-label="최근 점검일">${s.lastCheck ? esc(s.lastCheck) : '—'}</td>
        <td data-label="누락된 월">${missedHtml}</td>
      </tr>`;
  }).join('');

  const me = currentUserName();
  const myCount = maintenanceGroupList().filter(g => me && g.meta.owner_primary === me).length;

  return `
    <div class="maint-toolbar">
      <button type="button" class="my-assets-toggle maint-my-toggle ${maintenanceMyFilter?'active':''}" id="maintMyToggle" ${!me?'disabled':''} title="${me?'내가 정 담당자인 법인만 보기':'로그인이 필요합니다.'}">
        <span class="mat-label">내가 정인 법인만</span>
        <span class="mat-count">${myCount}</span>
      </button>
    </div>
    <div class="maint-trend-card">
      <h4>월별 점검 완료율 (2026.01 ~ ${esc(ymLabel(currentYm()))})</h4>
      ${trendRows || '<div class="dash-empty">데이터가 없습니다.</div>'}
    </div>
    <div class="maint-trend-card">
      <h4>법인별 평균 점검일 분포 (1일 ~ 31일)</h4>
      <p class="maint-day-hint">법인마다 지금까지의 점검일 평균을 날짜(1~31일)에 배치한 막대그래프입니다. 막대가 높을수록 그 날짜대에 점검이 몰려 있다는 뜻이며, 막대에 마우스를 올리면 어떤 법인이 해당하는지 볼 수 있습니다.</p>
      ${groups.length ? maintenanceDayChartHtml(groups) : '<div class="dash-empty">데이터가 없습니다.</div>'}
    </div>
    <div class="maint-trend-card">
      <h4>담당자별 사이트 요약</h4>
      <p class="maint-day-hint">담당자별로 정/부 담당 중인 법인 수를 점검 방식별로 모아 보여줍니다. 개인 필터(내가 정인 법인만)와 무관하게 전체 담당자 기준입니다.</p>
      ${maintenanceUserSummaryHtml()}
    </div>
    <div class="maint-table-wrap">
      <table class="maint-table maint-group-stats-table">
        <thead><tr><th>법인</th><th>점검율 (2026.01~)</th><th>최근 점검일</th><th>누락된 월</th></tr></thead>
        <tbody>${groupRowsHtml || `<tr><td colspan="4"><div class="maint-empty">등록된 법인이 없습니다.</div></td></tr>`}</tbody>
      </table>
    </div>`;
}

function renderMaintenance(){
  const wrap = document.getElementById('maintenanceView');
  if (!wrap) return;
  if (!maintenanceYear) maintenanceYear = Math.max(2026, Number(currentYm().split('-')[0]));
  wrap.innerHTML = `
    <div class="maint-header">
      <h2>유지보수 점검 관리</h2>
      <p class="maint-sub">등록된 법인들의 월별 점검 이력을 관리합니다 · 2026년 1월부터</p>
    </div>
    <div class="maint-tabs">
      <button type="button" class="maint-tab-btn ${maintenanceTab==='entry'?'active':''}" data-maint-tab="entry">점검지</button>
      <button type="button" class="maint-tab-btn ${maintenanceTab==='stats'?'active':''}" data-maint-tab="stats">통계</button>
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

  const myToggle = document.getElementById('maintMyToggle');
  if (myToggle){
    myToggle.onclick = () => {
      if (!currentUserName()) return;
      maintenanceMyFilter = !maintenanceMyFilter;
      renderMaintenance();
    };
  }

  // 연간 표의 각 달 칸을 클릭하면 그 법인 · 그 달의 점검 등록/수정 모달이 뜬다.
  wrap.querySelectorAll('[data-maint-cell]').forEach(cell => {
    cell.onclick = () => {
      const [gid, ym] = cell.dataset.maintCell.split('|');
      openMaintenanceLogModal(gid, ym);
    };
  });
}

function openMaintenanceLogModal(gid, ym){
  const groups = maintenanceGroupList();
  const g = groups.find(x => x.gid === gid);
  if (!g) return;
  maintenanceEditTarget = { gid, ym };
  const log = maintenanceLogFor(gid, ym);
  document.getElementById('mlModalTitle').textContent = `${g.meta.owner} · ${ymLabel(ym)} 점검 등록`;
  // 점검일 기본값: 이미 등록된 점검이면 등록된 날짜를, 아니면 오늘(클릭한 날)을 기본값으로 잡는다.
  document.getElementById('ml_date').value = log ? (log.date || todayDots()) : todayDots();
  document.getElementById('ml_manager').value = log ? (log.manager || '') : (currentUserName() || g.meta.owner_primary || '');
  document.getElementById('ml_done').checked = log ? !!log.done : false;
  document.getElementById('ml_note').value = log ? (log.note || '') : '';
  document.getElementById('mlError').textContent = '';
  document.getElementById('mlDeleteBtn').style.display = log ? '' : 'none';
  document.getElementById('maintenanceLogModal').classList.add('open');
}

function closeMaintenanceLogModal(){
  document.getElementById('maintenanceLogModal').classList.remove('open');
  maintenanceEditTarget = null;
}

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
  const date = document.getElementById('ml_date').value.trim();
  const manager = document.getElementById('ml_manager').value.trim();
  const note = document.getElementById('ml_note').value.trim();
  const done = document.getElementById('ml_done').checked;
  const errEl = document.getElementById('mlError');
  if (!date){ errEl.textContent = '점검일을 입력해 주세요.'; return; }
  if (parseDate(date) === null){ errEl.textContent = '점검일 형식이 올바르지 않습니다. 예: 2026.8.10'; return; }
  errEl.textContent = '';

  let log = maintenanceLogFor(gid, ym);
  if (!log){
    log = { id: Date.now(), group: gid, ym };
    maintenanceLogs.push(log);
  }
  log.date = date;
  log.manager = manager;
  log.note = note;
  log.done = done;
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

// 페이지 상단 필드별 드롭다운 필터 — 국가 / 위치 / Support ID / 점검 방식 / 구성방식 /
// 담당 엔지니어 / 고객사 담당자 각각에 대해, 실제 등록된 값들을 옵션으로 보여주고
// 하나를 고르면 그 값과 일치하는 자산만 남긴다.
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
    { key:'country',      label:'국가',          cls:'tf-country',  values: uniqueValues(records, r=>r.country) },
    { key:'location',     label:'위치',          cls:'tf-location', values: uniqueValues(records, r=>r.location) },
    { key:'support_id',   label:'Support ID',    cls:'tf-support',  values: uniqueValues(records, r=>r.support_id) },
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

// 법인 카드 하나를 그려낸다. 부모-자식 관계가 있는 법인은 자식 법인 카드를 자신의
// items 영역 안에 재귀적으로 중첩시켜, 부모를 펼치면 자식 법인들의 정보(법인 정보 + Support ID별 자산)가
// 그대로 그 안에서 보이도록 한다. depth=0이면 최상위(독립 법인 또는 모회사), depth>0이면 중첩된 자식 법인.
function groupCardHtml(gid, items, groupsMap, depth, visited){
  visited = visited ? new Set(visited) : new Set();
  if (visited.has(gid)) return ''; // 데이터가 잘못 꼬여 순환 관계가 생긴 경우를 방어
  visited.add(gid);

  const meta = groupMeta(items);
  const isOpen = expandedGroups.has(gid);
  const isChild = depth > 0;
  // "이름표" 역할만 하는 shell 레코드(상위 법인 자신에게 남는, 자산이 아닌 더미 레코드)는
  // 실제 자산 목록/건수/상태 계산에서 제외한다.
  const realItems = items.filter(r => !r.is_group_shell);
  const worst = realItems.reduce((acc,r)=>{
    const s = licenseStatus(r);
    const rank = {crit:3,warn:2,ok:1,na:0};
    return rank[s]>rank[acc]?s:acc;
  },'na');

  // Support ID가 하나뿐인 카드는 법인명 옆 배지가 이미 그 Support ID를 보여주므로
  // 하위 "SUPPORT ID / 항목 건수" 바는 중복 정보라 생략한다 (독립 법인/자식 법인 모두 동일).
  // Support ID가 여러 개인 카드만 각 Support ID를 구분하기 위해 그대로 보여준다.
  // 자산이 하나도 없는(=자식 법인들의 대표 이름 역할만 하는) 상위 법인은 subGroups가 비어 있을 수 있다.
  const subGroups = buildSubGroups(realItems);
  const collapseSubHead = subGroups.length <= 1;
  const soloSubGroup = collapseSubHead ? (subGroups[0] || null) : null;
  const editableSid = soloSubGroup ? soloSubGroup.sid : null;

  const isParentGroup = groupChildrenOf(gid).length > 0;
  const isParentDisplay = isParentGroup || meta.is_parent;
  // 상위 법인은 자산을 직접 갖지 않으므로, "항목" 수치는 이 법인 자신의 것이 아니라
  // 하위(자식, 손자…) 법인에 속한 모든 자산의 총합으로 보여준다.
  const displayItemCount = isParentDisplay ? groupTotalItemCount(gid) : realItems.length;

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
                ${canBulkMove() ? '<th class="col-select"></th>' : ''}
                <th>SKU / 제품</th><th>S/N</th><th>수량</th><th>라이선스 기간</th>
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
                ${isParentDisplay ? '' : `<span class="meta-chip meta-chip-config"><span class="meta-label">구성방식</span><span class="meta-value">${esc(meta.config_mode)||'—'}</span></span>`}
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
              ${isCurrentUserAdmin() && !(isParentGroup || meta.is_parent) ? `<button class="wl-action-btn icon-only" data-group-add-asset="${gid}" title="이 법인에 자산 추가">＋</button>` : ''}
              ${isCurrentUserAdmin() && (isParentGroup || meta.is_parent) ? `<button class="wl-action-btn icon-only" data-group-add-child="${gid}" title="이 법인을 상위 법인으로 하는 하위 법인 추가">↳＋</button>` : ''}
              ${isCurrentUserAdmin() ? `<button class="wl-action-btn icon-only" data-group-edit="${gid}" title="법인 정보 수정 (법인명/국가/위치/점검방식/구성방식/상위 법인/담당자/고객사 담당자)">${pencilSvg()}</button>` : ''}
              ${isCurrentUserAdmin() ? `<button class="wl-action-btn icon-only" data-group-duplicate="${gid}" title="이 법인의 자산을 그대로 복사해서 바로 아래에 새 법인으로 추가">${clipboardSvg()}</button>` : ''}
              ${isCurrentUserAdmin() ? `<button class="wl-action-btn icon-only danger" data-group-delete="${gid}" title="법인 전체 삭제">${trashSvg()}</button>` : ''}
            </div>
            <span class="badge ${worst==='crit'?'tag-x':worst==='warn'?'':'tag-o'}" style="color:${worst==='crit'?'var(--red)':worst==='warn'?'var(--amber)':worst==='ok'?'var(--green)':'var(--text-faint)'}">${statusLabel(worst)}</span>
            <span class="chev ${isOpen?'open':''}">›</span>
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
  let list = records.filter(r => {
    if (!activeStatusFilters.has(licenseStatus(r))) return false;
    if (activeSkuKeywordFilters.size){
      const kws = skuKeywordMatches(r.sku);
      if (!kws.some(k => activeSkuKeywordFilters.has(k))) return false;
    }
    if (activeMyAssetsFilter){
      if (!mySiteGroupIds.has(r.group)) return false;
    }
    if (activeCountryFilter){
      const grpItems = records.filter(x=>x.group===r.group);
      const meta = groupMeta(grpItems);
      if (meta.owner !== activeCountryFilter) return false;
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
      // 부모가 있고 그 부모가 현재 화면(필터링된 목록)에도 있다면, 이 법인은 최상위가 아니라
      // 부모 카드 안에 중첩되어 표시된다 (아래 groupCardHtml의 재귀 호출에서 그려짐).
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
      <button type="button" class="btn btn-primary" id="bmbMoveBtn">선택 항목 이동</button>
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
  }
  return bar;
}
function updateBulkMoveBar(){
  // 현재 목록에 더 이상 존재하지 않는 선택은 정리
  const validIds = new Set(records.map(r=>String(r.id)));
  [...selectedAssetIds].forEach(id => { if (!validIds.has(id)) selectedAssetIds.delete(id); });

  if (!canBulkMove() || selectedAssetIds.size === 0){
    const bar = document.getElementById('bulkMoveBar');
    if (bar) bar.classList.remove('open');
    return;
  }
  const bar = bulkMoveBarEl();
  document.getElementById('bmbCount').textContent = `${selectedAssetIds.size}개 항목 선택됨`;
  bar.classList.add('open');
}

function statusLabel(s){ return {ok:'정상', warn:'만료임박', crit:'만료됨', na:'기간정보없음'}[s]; }
function statusColorVar(s){ return {ok:'var(--green)', warn:'var(--amber)', crit:'var(--red)', na:'var(--text-faint)'}[s]; }

function snLink(r, groupSupportId){
  const sn = esc(r.sn);
  if (!sn) return '—';
  const supportId = r.support_id || groupSupportId;
  if (!supportId) return sn;
  const url = `https://support.broadcom.com/group/ecx/licensing?siteId=${encodeURIComponent(supportId)}&serialNumber=${encodeURIComponent(r.sn)}`;
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

function openCustContactsModal(gid){
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
  document.getElementById('custContactsModal').classList.add('open');
}
document.getElementById('custContactsModalCloseBtn').onclick = () => {
  document.getElementById('custContactsModal').classList.remove('open');
};

function groupRemarksHtml(meta){
  if (!meta.group_remarks) return '';
  return `<div class="sub group-remarks">${esc(meta.group_remarks)}</div>`;
}

// 법인명 옆에 나란히 Support ID를 보여준다 (펼치지 않아도, 별도 줄 없이 바로 이름 옆에 보임).
// - 부모-자식 관계가 없는 독립 법인, 자식 법인: 이 법인 자신의 Support ID만.
// - 부모 법인(모회사, 자식 카드들이 안에 중첩되어 표시됨): 자기 자신의 Support ID를 먼저 보여주고,
//   자식 법인에 더 있는 Support ID는 "외 N개"로 구분해서 보여준다 (부모 자신의 것과 헷갈리지 않도록).
// editableSid가 주어지면(=Support ID가 하나뿐인 독립 법인이라 하위 Support ID 영역을 생략한 경우),
// 그 배지를 클릭해서 바로 Support ID / 구축 엔지니어 / 구축 일자를 수정할 수 있게 한다.
function supportIdTitleHtml(gid, items, isChild, editableSid){
  const ownSids = ownSupportIds(items);

  if (isChild || !groupHasFamily(gid)){
    return supportIdChipSimple(gid, ownSids, editableSid);
  }

  // 부모 법인(가족 관계 있음)
  const familyAll = familySupportIds(gid);
  const extraCount = Math.max(0, familyAll.length - ownSids.length);
  if (!ownSids.length){
    if (!familyAll.length) return '';
    return `<span class="title-support-ids"><span class="family-sid-chip"><span class="meta-label">Support ID</span><span class="meta-value">하위 법인 ${familyAll.length}개</span></span></span>`;
  }
  const singleEditable = ownSids.length === 1 && extraCount === 0 && editableSid && ownSids[0] === editableSid && isCurrentUserAdmin();
  const attrs = singleEditable
    ? ` data-subgroup-gid="${esc(gid)}" data-subgroup-sid="${esc(ownSids[0])}" title="Support ID / 구축 엔지니어 / 구축 일자 수정"`
    : '';
  const valueText = ownSids.map(s=>esc(s)).join(', ') + (extraCount > 0 ? ` 외 ${extraCount}개` : '');
  return `<span class="title-support-ids"><span class="family-sid-chip${singleEditable ? ' family-sid-chip--editable' : ''}"${attrs}><span class="meta-label">Support ID</span><span class="meta-value">${valueText}</span></span></span>`;
}

// Support ID 배지 하나를 그려낸다 (가족 관계 없이 자기 자신의 Support ID만 있는 일반적인 경우용).
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

// (구) 부모-자식 관계가 있는 법인에서 "관계"(모회사/자회사) 칩을 보여주던 함수 — 더 이상 사용하지 않음.

function rowHtml(r, groupSupportId){
  const status = licenseStatus(r);
  const pct = licenseBarPct(r);
  const logCount = (r.work_log||[]).length;
  return `
  <tr data-id="${r.id}">
    ${canBulkMove() ? `<td class="col-select" data-label=""><input type="checkbox" class="asset-select-cb" data-select-asset="${r.id}" ${selectedAssetIds.has(String(r.id))?'checked':''} title="일괄 이동을 위해 선택"></td>` : ''}
    <td class="sku" data-label="SKU / 제품">${skuBadge(r.sku)}${skuKeywordTagsHtml(r.sku)}</td>
    <td class="sn" data-label="S/N">${snLink(r, groupSupportId)}</td>
    <td data-label="수량">${esc(r.qty)||''}</td>
    <td data-label="라이선스 기간">
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

// 국가/법인 즐겨찾기 — 로그인한 사용자별로 이 브라우저에만 저장 (팀 공유 데이터 아님)
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
  const owners = [...new Map(records.map(r=>{
    const grp = records.filter(x=>x.group===r.group);
    const meta = groupMeta(grp);
    return [meta.owner, meta];
  })).values()].sort((a,b)=>{
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

// My 버튼에 표시할 갯수: 실제 자산이 걸린 "사이트(leaf 그룹)" 수가 아니라,
// 하위 법인은 상위 법인에 묶어서 하나로 세는 "독립법인 + 상위법인" 수로 보여준다.
// (유지보수 관리 페이지의 법인 목록 기준과 동일한 maintenanceGroupList()를 재사용한다.)
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
// f_owner / f_country / f_location / f_support / f_check는 법인(그룹) 공통 정보이므로
// 이 창에서는 항상 읽기 전용으로 보여주기만 한다(값을 바꾸려면 "법인 정보 수정" 이용).
// 담당자(정/부)와 고객사 담당자는 더 이상 자산 단위로 입력받지 않으며, 법인 정보(공통 담당
// 엔지니어 / 고객사 담당자)를 저장할 때 자동으로 함께 채워진다.
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

// 특정 법인(gid)에 바로 자산을 추가한다. 법인명/국가/위치/점검방식/담당 엔지니어 등 법인 공통 정보는
// 그 법인 기준으로 자동 채워지고 잠기며(변경하려면 "법인 정보 수정" 이용), Support ID와 자산 고유 정보만 입력한다.
// 자식 법인을 둔 상위 법인(대표 이름 역할만 함)에는 자산을 직접 추가할 수 없다.
function openAddAssetToGroup(gid){
  if (!isCurrentUserAdmin()){ alert('마스터만 자산을 추가할 수 있습니다.'); return; }
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
  // Support ID가 이미 하나뿐이면 미리 채워 두고, 여러 개이거나 없으면 비워 둔다
  // (이 필드는 읽기 전용이며, Support ID를 바꾸려면 "법인 정보 수정"을 이용해야 한다).
  const sids = ownSupportIds(items);
  set('f_support', sids.length === 1 ? sids[0] : '');

  document.getElementById('addModalTitle').textContent = `"${meta.owner}" 법인에 자산 추가`;
  document.getElementById('saveAddBtn').textContent = '항목 저장';
  document.getElementById('addModal').classList.add('open');
}

// 마스터 관리자 전용: 작업이력을 남기지 않고 자산의 모든 필드를 바로 수정한다.
async function openDirectEditModal(recId){
  if (!isCurrentUserAdmin()){ alert('마스터 관리자만 직접 수정할 수 있습니다.'); return; }
  if (viewOnly || !sessionKey){ alert('먼저 마스터 비밀번호로 잠금을 해제해야 합니다.'); return; }
  const rec = records.find(r=>String(r.id)===String(recId));
  if (!rec) return;

  editingRecordId = recId;
  addAssetTargetGid = null;
  clearAssetForm();
  const set = (id, v) => { document.getElementById(id).value = v || ''; };
  // 법인/국가/위치/Support ID/점검 방식은 이 법인(그룹)의 공통 정보이므로, 이 자산 레코드
  // 하나가 아니라 그룹 전체 기준 값(groupMeta)을 보여준다 — 항상 정확한 값을 보여주고,
  // 그룹 안에서 값이 어긋나는 예전 방식의 데이터 불일치를 화면에 다시 노출하지 않기 위함이다.
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
    // 관리자 직접 수정: 작업이력을 남기지 않고 기존 레코드를 그대로 덮어쓴다.
    if (!isCurrentUserAdmin()){ alert('마스터 관리자만 직접 수정할 수 있습니다.'); return; }
    const rec = records.find(r=>String(r.id)===String(editingRecordId));
    if (!rec){ editingRecordId = null; document.getElementById('addModal').classList.remove('open'); return; }
    // 법인/국가/위치/Support ID/점검 방식은 화면에서 항상 읽기 전용(그룹 공통 정보)이므로
    // 여기서 폼 값으로 덮어쓰지 않고, 자산 고유 정보만 갱신한다.
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
    // 특정 법인에 자산 추가: 법인 공통 정보는 그 법인 기준으로 강제 적용하고, Support ID/자산 고유 정보만 입력받는다.
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
    // 첫 자산이라면 법인 생성 시 shell에 입력해 둔 구축 엔지니어/일자를 승계한다.
    // 이후 자산은 해당 Support ID의 실제 자산 메타를 우선한다.
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
let geCustContacts = []; // working copy of {name,phone,email} rows while modal is open

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

// 상위 법인(부모) 선택 드롭다운을 현재 존재하는 법인 목록으로 채운다.
// 자기 자신과, 자기 자신의 하위(자식/손자…) 법인은 골라도 순환 관계가 생기므로 목록에서 제외하고,
// "이 법인은 상위 법인입니다" 체크박스로 상위 법인이라고 표시된 법인만 후보로 보여준다.
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

// 현재 법인 정보 수정창에서 편집 중인 법인의 Support ID 하위 그룹 목록과, 체크박스를 켜기 전
// 원래 갖고 있던 구성방식 값(체크 해제 시 복원용)을 담아 둔다. openGroupEditModal에서 채워지고
// applyGeSidFieldState(체크박스 change 핸들러 포함)에서 참조한다.
let geSubGroupsCache = [];
let geOriginalConfigMode = '';

// "이 법인은 상위 법인입니다" 체크박스 상태와 Support ID 개수에 따라 Support ID / 구축 엔지니어 /
// 구축 일자 / 구성방식 입력창을 활성화·비활성화하고 값을 채운다. 체크박스를 켜면(상위 법인)
// 네 필드 모두 비우고 잠근다 — 상위 법인은 대표 이름 역할만 하기 때문이다.
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
  if (!isCurrentUserAdmin()){ alert('마스터만 법인 정보를 수정할 수 있습니다.'); return; }
  if (viewOnly || !sessionKey){ alert('법인 정보를 수정하려면 먼저 마스터 비밀번호로 잠금을 해제해야 합니다.'); return; }
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

  // Support ID / 구축 엔지니어 / 구축 일자 / 구성방식은 이 법인이 상위 법인이 아니고
  // Support ID가 하나뿐일 때만 여기서 함께 수정할 수 있다. Support ID가 여러 개면(각기 다른
  // 구축 엔지니어/일자를 가질 수 있으므로) 각 Support ID 영역의 ✎ 버튼으로 안내한다.
  // 다른 법인을 자식으로 둔 상위 법인(실제 관계)이거나 "이 법인은 상위 법인입니다"에 체크된
  // 경우는 대표 이름 역할만 하며 Support ID를 직접 가질 수 없으므로 항상 잠근다.
  const hasChildren = groupChildrenOf(gid).length > 0;
  geSubGroupsCache = buildSubGroups(items);
  const isParentCb = document.getElementById('ge_is_parent');
  isParentCb.checked = hasChildren || !!meta.is_parent;
  // 실제로 자식 법인이 있으면 상위 법인 상태를 해제할 수 없다.
  isParentCb.disabled = hasChildren;
  applyGeSidFieldState();

  populateParentGroupSelect(gid, meta.group_parent);
  geCustContacts = (meta.cust_contacts && meta.cust_contacts.length
    ? meta.cust_contacts.slice(0,5)
    : [{role:'',name:'',org:'',phone:'',email:''}]
  ).map(c=>({...c}));
  renderCustContactRows();
  updateGeCustSectionVisibility();
  document.getElementById('geError').textContent = '';
  document.getElementById('groupEditModal').classList.add('open');
}

// 하위 법인(부모가 지정된 법인)에는 고객사 담당자 정보가 필요 없으므로 해당 입력 영역을 숨긴다.
// 모달이 열려 있는 동안 상위 법인 선택을 바꾸면 그에 맞춰 즉시 보이거나 숨겨진다.
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
  if (!isCurrentUserAdmin()){ alert('마스터만 법인 정보를 수정할 수 있습니다.'); return; }
  if (!groupEditId) return;
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
  // Support ID / 구축 엔지니어 / 구축 일자는 이 법인에 Support ID가 하나뿐이었을 때만(입력창이 활성화된 경우만) 저장한다.
  // 여러 개인 경우, 또는 이 법인이 다른 법인을 자식으로 둔 상위 법인인 경우는 여기서 건드리지 않는다.
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
  // 방어적으로 한 번 더 확인: 자기 자신이나 자신의 하위 법인을 부모로 저장하지 않는다.
  const forbiddenParents = new Set([groupEditId, ...groupDescendantIds(groupEditId)]);
  const finalParentGid = (newParentGid && !forbiddenParents.has(newParentGid)) ? newParentGid : '';
  captureCustContactsFromDom();
  // 하위 법인(부모가 지정된 법인)에는 고객사 담당자 정보가 필요 없으므로 저장하지 않는다.
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
      // clear legacy single-contact fields now that the array field is authoritative
      r.cust_contact = ''; r.cust_phone = ''; r.cust_email = '';
      if (applySoloSid){
        r.support_id = newSupportId;
        r.build_engineer = newBuildEngineer;
        r.build_date = newBuildDate;
      }
    }
  });
  // 이 법인이 방금 어떤 법인의 첫 자식으로 새로 연결됐을 수 있으므로, 상위 법인 자신에게
  // 남아 있는 직속 Support ID/자산이 있다면 자식 법인으로 자동 이전해 규칙을 지킨다.
  enforceParentsHaveNoDirectAssets();
  document.getElementById('groupEditModal').classList.remove('open');
  groupEditId = null;
  render();
  buildFilters();
  scheduleAutoSync();
};

// ---------- 법인 추가 (좌측 패널 ＋ 버튼) ----------
// 새 법인의 회사 단위 정보(법인/Support ID/상위 법인/국가/위치/구축 엔지니어/구축 일자/
// 구성방식/담당 엔지니어/점검 방식/고객사 담당자/비고)만 입력받아 법인을 새로 만든다.
// 실제 자산(SKU/S/N/라이선스/OS/IP/ID/PW 등)은 법인을 만든 뒤 각 법인 카드의
// ＋(이 법인에 자산 추가) 버튼으로 따로 추가한다.
let ngCustContacts = []; // 작업 중인 고객사 담당자 목록 (모달이 열려 있는 동안의 임시 상태)

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

// 하위 법인(부모를 지정한 법인)에는 고객사 담당자 정보가 필요 없으므로 해당 입력 영역을 숨긴다.
function updateNgCustSectionVisibility(){
  const isChildNow = !!document.getElementById('ng_parent_group').value;
  document.getElementById('ng_cust_list').style.display = isChildNow ? 'none' : '';
  document.getElementById('ng_cust_add_btn').style.display = isChildNow ? 'none' : '';
  document.getElementById('ngCustHiddenHint').style.display = isChildNow ? '' : 'none';
}
document.getElementById('ng_parent_group').addEventListener('change', updateNgCustSectionVisibility);

// 상위 법인(부모) 선택 드롭다운을 현재 존재하는 법인 목록으로 채운다. 아직 만들어지지 않은
// 새 법인이라 자기 자신을 제외할 필요는 없다. "이 법인은 상위 법인입니다" 체크박스로
// 상위 법인이라고 표시된 법인만 후보로 보여준다.
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

// "이 법인은 상위 법인입니다" 체크박스 상태에 따라 Support ID / 구축 엔지니어 / 구축 일자 /
// 구성방식 입력창을 활성화·비활성화한다. 체크하면(=새로 만드는 법인이 상위 법인이라면) 네
// 필드 모두 비우고 잠근다 — 상위 법인은 대표 이름 역할만 하며 이 값들을 직접 갖지 않는다.
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
  // 일반 '법인 추가'는 항상 독립 법인에서 시작한다. 이전 모달 선택값이 남아 부모로 저장되는 것을 차단한다.
  document.getElementById('ng_parent_group').value = '';
  updateNgParentFlagState();
  if (presetParentGid){
    const sel = document.getElementById('ng_parent_group');
    // populateNewGroupParentSelect()가 채운 옵션 중에 실제로 존재할 때만(상위 법인으로 체크된
    // 법인일 때만) 미리 선택해 둔다.
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
  // 방금 지정한 상위 법인에게 그 자신 소유의 직속 자산이 남아 있다면, 규칙에 따라 자식 법인으로 자동 이전한다.
  enforceParentsHaveNoDirectAssets();
  expandGroupWithAncestors(gid);
  document.getElementById('addGroupModal').classList.remove('open');
  render();
  buildFilters();
  scheduleAutoSync();
};

// ---------- Support ID 하위 그룹 정보 수정 (Support ID / 구축 엔지니어 / 구축 일자) ----------
let subGroupEditTarget = null; // { gid, sid } 편집 중인 하위 그룹

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
let moveAssetRecIds = []; // 이동 대상 자산 id 목록 (단건이든 여러 건이든 항상 배열로 보관)
let selectedAssetIds = new Set(); // 목록에서 체크박스로 선택한 자산 id들 (일괄 이동용)

function canBulkMove(){
  return isCurrentUserAdmin() && !viewOnly && sessionKey;
}

// recIdOrIds: 단일 id(문자열/숫자) 또는 id 배열 모두 허용
function openMoveAssetModal(recIdOrIds){
  if (!isCurrentUserAdmin()){ alert('마스터만 자산을 다른 법인으로 이동할 수 있습니다.'); return; }
  if (viewOnly || !sessionKey){ alert('자산을 이동하려면 먼저 마스터 비밀번호로 잠금을 해제해야 합니다.'); return; }
  const ids = Array.isArray(recIdOrIds) ? recIdOrIds.map(String) : [String(recIdOrIds)];
  const recs = records.filter(r => ids.includes(String(r.id)));
  if (!recs.length) return;

  const sourceGids = new Set(recs.map(r=>r.group));
  // 선택한 자산이 전부 같은 법인 소속이면 그 법인은 이동 대상에서 제외, 여러 법인에 걸쳐 있으면 전체 법인을 보여준다.
  // 다른 법인을 자식으로 둔 상위 법인(대표 이름 역할만 함)은 Support ID/자산을 직접 가질 수 없으므로 이동 대상에서 제외한다.
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

  // 대상이 '법인만 먼저 생성된 상태'라면 shell에 저장된 Support ID/구축 정보가 대상 법인의 기준값이다.
  // 기존 자산을 이 법인으로 이동할 때 원래 법인의 Support ID를 끌고 오지 않고 대상 법인 값을 적용한다.
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
  // 부모 법인을 삭제하면 자식 법인은 삭제하지 않고 독립 법인으로 전환한다.
  records.forEach(r => { if (r.group_parent === gid) r.group_parent = ''; });
  records = records.filter(r=>r.group!==gid);
  expandedGroups.delete(gid);
  render();
  buildFilters();
  scheduleAutoSync();
}

// 마스터 전용: 이미 등록된 법인(그룹)의 자산 데이터를 그대로 복사해서
// 원본 바로 아래에 새 법인으로 추가한다. 새로 생긴 법인의 값은
// "법인 정보 수정"에서 필요한 만큼 고쳐 쓰면 된다.
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
    const copy = JSON.parse(JSON.stringify(r)); // work_log, cust_contacts 등 배열/객체 필드까지 그대로 깊은 복사
    copy.id = nextId++;
    copy.group = newGid;
    copy.owner = newOwnerName;
    // '새 법인 복제'는 원본의 부모 관계까지 복제하지 않는다. 항상 독립 법인으로 만든다.
    copy.group_parent = '';
    copy.is_parent = false;
    return copy;
  });

  // 원본 법인의 마지막 항목 바로 뒤에 끼워 넣어서, 화면에서도 원본 바로 아래에 나타나게 한다.
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
let agLoginPromptUserId = null; // 계정 게이트 목록에서 지금 비밀번호 입력창이 펼쳐진 계정
let agLoginPromptMode = 'login'; // 'login' | 'delete' | 'changepw' — 펼쳐진 폼이 로그인/삭제확인/비밀번호변경 중 무엇인지

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
function updateSidebarProfile(){
  const nameEl = document.getElementById('profileName');
  const subEl = document.getElementById('profileSub');
  if (!nameEl) return;
  const name = currentUserName();
  nameEl.textContent = name || '로그인 필요';
  if (subEl) subEl.textContent = isCurrentUserAdmin() ? '👑 마스터' : '로그인됨';
}
function updateUserBtnLabel(){ updateSidebarProfile(); } // (이전 이름 호환용 별칭)

// ---------- 계정 게이트 (앱 진입 전 1단계 로그인 화면) ----------
function showMasterGate(){
  document.getElementById('accountGateCard').style.display = 'none';
  const masterCard = document.getElementById('masterGateCard');
  masterCard.style.display = 'block';
  const p = document.getElementById('passInput');
  if (p) p.focus();
}

// 계정 로그인이 끝난 뒤 호출된다. 24시간 이내에 마스터 비밀번호를 이미 입력해 캐시가 남아있으면
// 마스터 비밀번호 화면 없이 바로 앱으로 들어가고, 그렇지 않으면 평소처럼 마스터 비밀번호 화면을 보여준다.
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

// 계정 삭제: 비밀번호로 본인 확인이 끝난 뒤 호출됨.
// 자산/작업이력 데이터 자체는 건드리지 않고 로그인용 계정 정보만 제거한다.
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
  // 이 시스템에 처음 만들어지는 계정은 자동으로 마스터 관리자 권한을 갖는다
  // (팀에서 가장 먼저 계정을 만든 사람 = 관리자를 지정해 줄 사람이 아직 없으므로).
  const isAdmin = users.length === 0;
  users.push({ id, name, pwSalt, pwIterations, pwHash, isAdmin });

  // 계정을 막 만든 사람은 이미 방금 비밀번호를 입력해 본인임이 확인된 상태이므로
  // 바로 로그인 상태로 전환한다.
  currentUserId = id;
  saveCurrentUserId(id);
  scheduleAutoSync();

  nameInput.value = ''; passInput.value = ''; pass2Input.value = '';
  errEl.textContent = '';
  await proceedPastAccountGate();
};

// 계정 목록은 비동기로 로드되므로, 로드되는 대로 게이트 화면에 그린다.
document.getElementById('ag_user_list').innerHTML = `<div class="user-list-empty">계정 목록을 불러오는 중…</div>`;
dataReady.then(renderAccountGateUserList);

// 이미 이 브라우저에 로그인 기록이 있고(currentUserId) 그 계정이 실제로 존재하면,
// 계정 게이트를 건너뛰고 바로 마스터 비밀번호 화면으로 넘어간다.
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
// 알림(최근 작업 이력)에서 한 번 클릭해서 확인한 항목은 다시 뜨지 않도록 "읽음/삭제" 상태를
// 로그인한 사용자별로 이 브라우저에 저장해 둔다. (팀 공유 데이터 아님 — 즐겨찾기와 동일한 방식)
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
      <div class="ra-author">작성: ${esc(entry.author)||'미상'}</div>
    </div>`).join('');
  wrap.querySelectorAll('[data-jump-group]').forEach(el=>{
    el.onclick = () => {
      const gid = el.dataset.jumpGroup;
      const recId = el.dataset.jumpRec;
      const key = el.dataset.activityKey;

      // 클릭한 항목은 알림 목록/뱃지에서 바로 사라지도록 "읽음" 처리한다.
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
    const errBody = await res.json().catch(()=>({}));
    throw new Error(`GitHub 저장 실패: HTTP ${res.status}${errBody.message? ' - '+errBody.message : ''}`);
  }
  const data = await res.json();
  return data.content.sha;
}

// ---------- work log ----------
function openWorkLogModal(recId){
  workLogRecordId = String(recId);
  const rec = records.find(r=>String(r.id)===workLogRecordId);
  if (!rec) return;
  document.getElementById('wlSubtitle').textContent =
    `${rec.sku||'장비'}${rec.sn? ' · S/N '+rec.sn : ''} — 비고와 별도로 구축/제거/교체/OS 변경/PM 이력을 남길 수 있습니다.`;
  document.getElementById('wl_type').value = '장비 구축';
  document.getElementById('wl_date').value = '';
  document.getElementById('wl_manager').value = '';
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
  { field:'id',  label:'계정 ID', type:'text', sensitive:true, encField:'id_enc' },
  { field:'pw',  label:'비밀번호', type:'text', sensitive:true, encField:'pw_enc' },
  { field:'enable_pw', label:'Enable 비밀번호', type:'text', sensitive:true, encField:'enable_pw_enc' },
];
function wlFieldDef(field){ return WL_FIELD_DEFS.find(d=>d.field===field); }

// Working state while the modal is open: which fields the user has picked
// to change, and whatever they've typed into each one so far.
let wlChangeFields = [];
let wlChangeValues = {};

function renderWlFieldSelect(){
  const sel = document.getElementById('wl_field_select');
  const available = WL_FIELD_DEFS.filter(d => !wlChangeFields.includes(d.field));
  sel.innerHTML = `<option value="">변경할 항목 선택…</option>` +
    available.map(d=>`<option value="${d.field}">${esc(d.label)}${d.sensitive?' 🔒':''}</option>`).join('');
}

function renderWlChangeRows(){
  const wrap = document.getElementById('wl_fieldchange_rows');
  wrap.innerHTML = wlChangeFields.map(field=>{
    const def = wlFieldDef(field);
    if (!def) return '';
    const val = esc(wlChangeValues[field]||'');
    const inputHtml = def.type==='textarea'
      ? `<textarea class="wl-fc-input" data-field="${field}">${val}</textarea>`
      : `<input class="wl-fc-input" data-field="${field}" value="${val}">`;
    return `
    <div class="wl-fc-row">
      <label>${esc(def.label)}${def.sensitive?' 🔒':''}</label>
      ${inputHtml}
      <button type="button" class="cc-remove-btn" data-remove="${field}" title="이 항목 제거">✕</button>
    </div>`;
  }).join('');
  wrap.querySelectorAll('.wl-fc-input').forEach(el=>{
    el.addEventListener('input', ()=>{ wlChangeValues[el.dataset.field] = el.value; });
  });
  wrap.querySelectorAll('[data-remove]').forEach(btn=>{
    btn.onclick = () => {
      const f = btn.dataset.remove;
      wlChangeFields = wlChangeFields.filter(x=>x!==f);
      delete wlChangeValues[f];
      renderWlChangeRows();
    };
  });
  renderWlFieldSelect();
}

document.getElementById('wl_field_add_btn').onclick = () => {
  const sel = document.getElementById('wl_field_select');
  const field = sel.value;
  if (!field || wlChangeFields.includes(field)) return;
  wlChangeFields.push(field);
  if (wlChangeValues[field] === undefined) wlChangeValues[field] = '';
  renderWlChangeRows();
};

function resetFieldChangeInputs(){
  document.getElementById('wl_apply_toggle').checked = false;
  document.getElementById('wl_fieldchange_section').style.display = 'none';
  wlChangeFields = [];
  wlChangeValues = {};
  renderWlChangeRows();
}

document.getElementById('wl_apply_toggle').addEventListener('change', (e) => {
  document.getElementById('wl_fieldchange_section').style.display = e.target.checked ? '' : 'none';
});

async function applyFieldChanges(rec){
  const changes = [];
  const fieldChanges = {};
  for (const field of wlChangeFields){
    const def = wlFieldDef(field);
    if (!def) continue;
    const val = (wlChangeValues[field]||'').trim();
    if (!val) continue;
    if (def.sensitive){
      changes.push({ field, label:def.label, sensitive:true });
      fieldChanges[field] = true;
      rec[def.encField] = await encryptField(val);
    } else {
      const from = rec[field] || '—';
      if (val === rec[field]) continue;
      changes.push({ field, label:def.label, from, to:val });
      fieldChanges[field] = val;
      rec[field] = val;
    }
  }
  return { changes, fieldChanges };
}

function fieldChangesSummary(changes){
  if (!changes || !changes.length) return '';
  return changes.map(c => c.sensitive ? `${c.label} 변경됨` : `${c.label}: ${c.from} → ${c.to}`).join(' · ');
}

function fmtDateDots(nativeVal){
  // nativeVal is "YYYY-MM-DD" from <input type="date">
  if (!nativeVal) return '';
  const [y,m,d] = nativeVal.split('-').map(Number);
  if (!y || !m || !d) return '';
  return `${y}.${m}.${d}`;
}
// 오늘 날짜를 "YYYY.M.D" 형식으로 반환한다 (점검일 기본값 등에 사용).
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

function renderWorkLogList(){
  const rec = records.find(r=>String(r.id)===workLogRecordId);
  const listEl = document.getElementById('wlList');
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
    btn.onclick = () => {
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
        Object.keys(entry.field_changes).forEach(field => {
          const def = wlFieldDef(field);
          if (!def) return;
          wlChangeFields.push(field);
          // Sensitive fields never had their plaintext stored on the entry —
          // leave that row blank; re-enter a value only if changing it again.
          wlChangeValues[field] = def.sensitive ? '' : entry.field_changes[field];
        });
        renderWlChangeRows();
      }
      setWorkLogFormMode(true);
    };
  });
  listEl.querySelectorAll('[data-wl-delete]').forEach(btn=>{
    btn.onclick = () => {
      const entryId = btn.dataset.wlDelete;
      if (!confirm('이 작업 이력을 삭제하시겠습니까?')) return;
      rec.work_log = (rec.work_log||[]).filter(e=>String(e.id)!==String(entryId));
      if (String(workLogEditId)===String(entryId)){
        workLogEditId = null;
        document.getElementById('wl_date').value = '';
        document.getElementById('wl_manager').value = '';
        document.getElementById('wl_note').value = '';
        setWorkLogFormMode(false);
      }
      renderWorkLogList();
      render();
      scheduleAutoSync();
    };
  });
}

document.getElementById('wlAddBtn').onclick = async () => {
  const rec = records.find(r=>String(r.id)===workLogRecordId);
  if (!rec) return;
  const type = document.getElementById('wl_type').value;
  const date = document.getElementById('wl_date').value.trim();
  const manager = document.getElementById('wl_manager').value.trim();
  const note = document.getElementById('wl_note').value.trim();
  if (!date && !manager && !note){ alert('날짜, 담당자, 내용 중 하나 이상을 입력해 주세요.'); return; }
  if (!Array.isArray(rec.work_log)) rec.work_log = [];

  const applyToggled = document.getElementById('wl_apply_toggle').checked;
  let changeSummary = '', fieldChanges = {};
  if (applyToggled){
    const sensitiveTouched = wlChangeFields.some(f => {
      const def = wlFieldDef(f);
      return def && def.sensitive && (wlChangeValues[f]||'').trim();
    });
    if (sensitiveTouched && (viewOnly || !sessionKey)){
      alert('IP / 계정 ID / 비밀번호를 변경하려면 먼저 마스터 비밀번호로 잠금을 해제해야 합니다.');
      return;
    }
    const result = await applyFieldChanges(rec);
    if (!result.changes.length){
      alert('자산 정보 변경을 선택했지만, 기존 값과 다른 내용이 입력되지 않았습니다.');
      return;
    }
    changeSummary = fieldChangesSummary(result.changes);
    fieldChanges = result.fieldChanges;
  }

  if (workLogEditId){
    const entry = rec.work_log.find(e=>String(e.id)===String(workLogEditId));
    if (entry){
      entry.type=type; entry.date=date; entry.manager=manager; entry.note=note;
      if (applyToggled){ entry.field_changes = fieldChanges; entry.change_summary = changeSummary; }
      else { delete entry.field_changes; delete entry.change_summary; }
    }
    workLogEditId = null;
    setWorkLogFormMode(false);
  } else {
    if (!currentUserId && !confirm('현재 로그인된 사용자가 없어 이 이력의 작성자가 "미상"으로 표시됩니다.\n로그인 없이 계속 저장할까요?\n\n(취소를 누르면 저장하지 않습니다 — 상단의 "👤 로그인"에서 먼저 본인 계정으로 로그인해 주세요.)')){
      return;
    }
    const entry = { id: Date.now(), type, date, manager, note, author: currentUserName() };
    if (applyToggled){ entry.field_changes = fieldChanges; entry.change_summary = changeSummary; }
    rec.work_log.push(entry);
  }
  document.getElementById('wl_date').value = '';
  document.getElementById('wl_manager').value = '';
  document.getElementById('wl_note').value = '';
  resetFieldChangeInputs();
  renderWorkLogList();
  render();
  scheduleAutoSync();
};

document.getElementById('wlCancelEditBtn').onclick = () => {
  workLogEditId = null;
  document.getElementById('wl_date').value = '';
  document.getElementById('wl_manager').value = '';
  document.getElementById('wl_note').value = '';
  resetFieldChangeInputs();
  setWorkLogFormMode(false);
};

document.getElementById('wlCloseBtn').onclick = () => {
  document.getElementById('workLogModal').classList.remove('open');
  workLogRecordId = null;
  workLogEditId = null;
};
