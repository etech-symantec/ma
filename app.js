// ---------- global header offset ----------
// header.js (loaded from etech-symantec.github.io) injects its markup at the
// top of <body>, before our #lockOverlay/#app. We need to know its total
// rendered height so our own sticky topbar/stats/sidebar sit right below it
// instead of overlapping it.
//
// Earlier this measured `.header-wrap` directly via getBoundingClientRect().
// That undercounts the real header height whenever header.js renders extra
// content as a SIBLING outside that wrapper (e.g. a separate title/version
// bar next to the nav pills) — the result is our topbar/stats end up
// positioned too high and get visually clipped behind the (higher z-index)
// header. Instead we measure #app's natural in-flow offset from the top of
// <body> (offsetTop): that number is, by definition, the combined height of
// everything rendered above it in normal flow, no matter how many separate
// elements header.js uses or what it names them. (#lockOverlay is
// position:fixed and doesn't affect this.)
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

// ---------- sticky offsets: topbar ----------
// The sidebar filter panel stacks directly below the sticky topbar. Its
// offset depends on the topbar's *actual* rendered height, which can vary
// (button wrapping, font metrics, responsive layout) — so, exactly like the
// global header height above, we measure it live instead of hardcoding a
// pixel guess that goes stale.
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

// ---------- embedded access token (restricted-use deployment only) ----------
// IMPORTANT — read before relying on this:
// This only stops someone from finding the token by glancing at the file or
// grepping for "ghp_"/"github_pat_". It is NOT real security. Anyone who opens
// this page's dev tools, sets a breakpoint, or simply pastes
//   copy(_decodeAuth())
// into the browser console gets the plaintext token in one line, because the
// browser itself has to be able to decode it to make API calls. Only use this
// if: (1) this page is not on the public internet (intranet/VPN only, or
// behind auth), and (2) the token is a FINE-GRAINED PAT scoped to ONLY this
// repo with ONLY "Contents: Read and write" permission, with an expiration
// date set, so a leak has minimal blast radius. Rotate it periodically.
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

// ---------- auto-sync ----------
// Any local mutation (add/edit/delete asset, work-log change, password
// change) schedules a debounced push to GitHub so the repo file stays in
// sync automatically, as long as a token is available for this session.
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
    const payload = { salt: ENC_STORE.salt, iterations: ENC_STORE.iterations, records };
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
})().catch(err => {
  console.error('데이터 로드 실패:', err);
});

let sessionKey = null;      // CryptoKey, present only after unlock
let viewOnly = false;
let records = [];           // working array (mutable, in-memory)
let expandedGroups = new Set();
let activeStatusFilters = new Set(['ok','warn','na']);
let activeCountryFilter = null;
let activeDeviceTypeFilter = null;
let activeSkuKeywordFilters = new Set();
let workLogRecordId = null; // which record's modal is currently open
let workLogEditId = null;   // work-log entry id currently being edited (null = adding new)
let editingRecordId = null; // asset record id currently being edited via addModal (null = adding new)

// ---------- device type ----------
const DEVICE_COLORS = ['#31D8C9','#F2AE40','#EC5F4B','#7C9EFF','#C792EA','#48D48A','#FF8A65','#4FC3F7','#BA68C8','#AED581'];
function deviceTypeLabel(r){ return (r.device_type && r.device_type.trim()) || '미지정'; }
function deviceTypeColor(label){
  let hash = 0;
  for (let i=0;i<label.length;i++) hash = (hash*31 + label.charCodeAt(i)) >>> 0;
  return DEVICE_COLORS[hash % DEVICE_COLORS.length];
}
function deviceBadge(r){
  const label = deviceTypeLabel(r);
  const color = deviceTypeColor(label);
  return `<span class="device-badge" style="color:${color}; border-color:${color}55; background:${color}1a;">
    <span class="device-dot" style="background:${color}"></span>${esc(label)}
  </span>`;
}

// ---------- SKU category tags ----------
// Rules are checked in order (first match wins) and grouped into color
// "families" (related hues) for related prefixes — e.g. all ISG-* patterns
// share a violet family, just at different shades, per spec.
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
  { key:'MC',   test: sku => sku.toUpperCase().includes('MC') },
  { key:'RP',   test: sku => sku.toUpperCase().includes('RP') },
  { key:'ISG',  test: sku => sku.toUpperCase().includes('ISG') },
  { key:'SG',   test: sku => sku.toUpperCase().includes('SG') },
  { key:'PS',   test: sku => sku.toUpperCase().includes('PS') },
  { key:'SSP',  test: sku => sku.toUpperCase().includes('SSP') },
  { key:'VA',   test: sku => sku.toUpperCase().includes('VA') },
  { key:'ELK',  test: sku => sku.toUpperCase().includes('ELK') },
  { key:'CLD',  test: sku => sku.toUpperCase().includes('CLD') },
  { key:'BCWF', test: sku => sku.toUpperCase().includes('BCWF') },
  { key:'WSS',  test: sku => sku.toUpperCase().includes('WSS') },
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
    false,
    ['encrypt','decrypt']
  );
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

// Key-parametrized variants (used for master-password rotation, where we need
// to decrypt with the OLD key and encrypt with the NEW key in the same pass,
// independent of whatever is currently sitting in the global sessionKey).
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

async function tryUnlock(passphrase){
  const key = await deriveKey(passphrase, ENC_STORE.salt, ENC_STORE.iterations);
  // verify against first record that actually has an encrypted field
  const probe = ENC_STORE.records.find(r => r.ip_enc || r.id_enc || r.pw_enc);
  if (probe){
    const f = probe.ip_enc || probe.id_enc || probe.pw_enc;
    try{
      const iv = b64ToBuf(f.iv);
      const ct = new Uint8Array(b64ToBuf(f.ct));
      const tag = new Uint8Array(b64ToBuf(f.tag));
      const combined = new Uint8Array(ct.length+tag.length); combined.set(ct,0); combined.set(tag,ct.length);
      await crypto.subtle.decrypt({name:'AES-GCM', iv}, key, combined.buffer);
    }catch(e){ return false; }
  }
  sessionKey = key;
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
  alert('마스터 비밀번호는 이 페이지를 만들 때 채팅으로 전달된 문자열입니다. 안전한 곳(비밀번호 관리자 등)에 보관하세요. 비밀번호를 바꾸고 싶다면, 잠금 해제 후 상단의 "🔑 비밀번호 변경" 버튼을 이용하세요.');
};

function boot(){
  document.getElementById('lockOverlay').style.display = 'none';
  document.getElementById('app').classList.add('ready');
  document.getElementById('lockState').textContent = viewOnly ? '👁 보기 전용 (민감정보 숨김)' : '🔓 잠금 해제됨 · 이 세션 동안만 유지';
  updateGithubButtonState();
  render();
  requestAnimationFrame(() => { syncGlobalHeaderHeight(); syncStickyOffsets(); });
}

// ---------- date / status ----------
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

function getGroupCustContacts(items){
  // Prefer the new multi-contact array field; fall back to legacy single
  // cust_contact/cust_phone/cust_email fields for older data.
  const withArr = items.find(i => Array.isArray(i.cust_contacts) && i.cust_contacts.length);
  if (withArr) return withArr.cust_contacts.slice(0,3);
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
    support_id: items.map(i=>i.support_id).find(Boolean) || '',
    owner_primary: items.map(i=>i.owner_primary).find(Boolean) || '',
    owner_secondary: items.map(i=>i.owner_secondary).find(Boolean) || '',
    cust_contacts: getGroupCustContacts(items),
    group_remarks: items.map(i=>i.group_remarks).find(Boolean) || ''
  };
}

function maskedField(rec, kind){
  const encKey = kind+'_enc';
  const hasVal = !!rec[encKey];
  if (!hasVal) return `<span class="sec-val masked">—</span>`;
  const id = rec.id + '_' + kind;
  return `
    <span class="sec-field">
      <span class="sec-val masked" id="disp_${id}">••••••••</span>
      <button class="sec-toggle" data-id="${rec.id}" data-kind="${kind}" title="표시/숨기기">${eyeSvg()}</button>
    </span>`;
}
function eyeSvg(){ return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8Z"/><circle cx="12" cy="12" r="3"/></svg>`; }
function pencilSvg(){ return `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>`; }
function trashSvg(){ return `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>`; }
function clipboardSvg(){ return `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="2" width="8" height="4" rx="1"/><path d="M9 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2h-3"/><path d="M9 12h6"/><path d="M9 16h6"/></svg>`; }

function render(){
  const q = document.getElementById('searchInput').value.trim().toLowerCase();
  let list = records.filter(r => {
    if (!activeStatusFilters.has(licenseStatus(r))) return false;
    if (activeDeviceTypeFilter && deviceTypeLabel(r) !== activeDeviceTypeFilter) return false;
    if (activeSkuKeywordFilters.size){
      const kws = skuKeywordMatches(r.sku);
      if (!kws.some(k => activeSkuKeywordFilters.has(k))) return false;
    }
    if (activeCountryFilter){
      const grpItems = records.filter(x=>x.group===r.group);
      const meta = groupMeta(grpItems);
      if (meta.owner !== activeCountryFilter) return false;
    }
    if (q){
      const custBits = (r.cust_contacts||[]).flatMap(c=>[c.name,c.phone,c.email]);
      const hay = [r.owner,r.location,r.sku,r.sn,r.support_id,r.owner_primary,r.owner_secondary,r.cust_contact,...custBits,deviceTypeLabel(r),r.remarks,r.group_remarks,skuKeywordMatches(r.sku).join(' ')].join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  const groups = groupRecords(list);
  const content = document.getElementById('content');

  if (groups.size === 0){
    content.innerHTML = `<div class="empty-state"><h3>조건에 맞는 자산이 없습니다</h3><p>검색어나 필터를 조정해 보세요.</p></div>`;
  } else {
    let html = '';
    for (const [gid, items] of groups){
      const meta = groupMeta(items);
      const isOpen = expandedGroups.has(gid);
      const worst = items.reduce((acc,r)=>{
        const s = licenseStatus(r);
        const rank = {crit:3,warn:2,ok:1,na:0};
        return rank[s]>rank[acc]?s:acc;
      },'na');
      html += `
      <div class="group-card" data-gid="${gid}">
        <div class="group-head ${isOpen?'expanded':''}" data-toggle="${gid}">
          <div class="group-head-left">
            <div class="group-title">
              <div class="title-row">
                <h3 class="group-title-name">${esc(meta.owner)}</h3>
                <div class="sub title-meta">
                  <span>${esc(meta.location)||'위치 미입력'}</span>
                  <span><b>Support ID</b> ${esc(meta.support_id)||'—'}</span>
                  <span><b>항목</b> ${items.length}건</span>
                </div>
              </div>
              ${groupContactsHtml(meta)}
            </div>
          </div>
          <div class="group-badges">
            <div class="group-title-actions">
              <button class="wl-action-btn icon-only" data-group-edit="${gid}" title="법인 정보 수정 (법인명/위치/Support ID/담당자/고객사 담당자)">${pencilSvg()}</button>
              <button class="wl-action-btn icon-only danger" data-group-delete="${gid}" title="법인 전체 삭제">${trashSvg()}</button>
            </div>
            <span class="badge ${worst==='crit'?'tag-x':worst==='warn'?'':'tag-o'}" style="color:${worst==='crit'?'var(--red)':worst==='warn'?'var(--amber)':worst==='ok'?'var(--green)':'var(--text-faint)'}">${statusLabel(worst)}</span>
            <span class="chev ${isOpen?'open':''}">›</span>
          </div>
        </div>
        <div class="items ${isOpen?'open':''}">
          <table>
            <thead><tr>
              <th>SKU / 제품</th><th>S/N</th><th>수량</th><th>라이선스 기간</th>
              <th>IP</th><th>ID</th><th>PW</th><th>OS / 점검</th><th>비고</th><th>작업이력</th><th>관리</th>
            </tr></thead>
            <tbody>
              ${items.map(r=>rowHtml(r, meta.support_id)).join('')}
            </tbody>
          </table>
        </div>
      </div>`;
    }
    content.innerHTML = html;
  }

  document.querySelectorAll('[data-toggle]').forEach(el=>{
    el.onclick = () => {
      const gid = el.dataset.toggle;
      if (expandedGroups.has(gid)) expandedGroups.delete(gid); else expandedGroups.add(gid);
      render();
    };
  });

  document.querySelectorAll('[data-group-edit]').forEach(btn=>{
    btn.onclick = (e) => { e.stopPropagation(); openGroupEditModal(btn.dataset.groupEdit); };
  });
  document.querySelectorAll('[data-group-delete]').forEach(btn=>{
    btn.onclick = (e) => { e.stopPropagation(); deleteGroup(btn.dataset.groupDelete); };
  });
  document.querySelectorAll('[data-kwtag]').forEach(tag=>{
    tag.onclick = (e) => {
      e.stopPropagation();
      const k = tag.dataset.kwtag;
      if (activeSkuKeywordFilters.has(k)) activeSkuKeywordFilters.delete(k); else activeSkuKeywordFilters.add(k);
      render();
    };
  });
  document.querySelectorAll('.sec-toggle').forEach(btn=>{
    btn.onclick = async (e) => {
      e.stopPropagation();
      const id = btn.dataset.id, kind = btn.dataset.kind;
      const rec = records.find(r=>String(r.id)===String(id));
      const dispEl = document.getElementById(`disp_${id}_${kind}`);
      if (!dispEl) return;
      if (dispEl.classList.contains('masked')){
        if (viewOnly || !sessionKey){ alert('민감정보를 보려면 마스터 비밀번호로 잠금을 해제해야 합니다.'); return; }
        const val = await decryptField(rec[kind+'_enc']);
        dispEl.textContent = val;
        dispEl.classList.remove('masked');
      } else {
        dispEl.textContent = '••••••••';
        dispEl.classList.add('masked');
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

  buildFilters();
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

function groupContactsHtml(meta){
  const parts = [];
  if (meta.owner_primary || meta.owner_secondary){
    const names = [];
    if (meta.owner_primary) names.push(`<span class="mgr-primary">${esc(meta.owner_primary)}</span>`);
    if (meta.owner_secondary) names.push(esc(meta.owner_secondary));
    parts.push(`<span><b>담당자</b> ${names.join(' ')}</span>`);
  }
  if (meta.cust_contacts && meta.cust_contacts.length){
    const people = meta.cust_contacts
      .map(c => [c.name, c.phone, c.email].filter(Boolean).map(esc).join(' · '))
      .filter(Boolean);
    if (people.length) parts.push(`<span><b>고객사 담당자</b> ${people.join(' / ')}</span>`);
  }
  let html = '';
  if (parts.length) html += `<div class="sub group-contacts">${parts.join('')}</div>`;
  if (meta.group_remarks) html += `<div class="sub group-remarks">${esc(meta.group_remarks)}</div>`;
  return html;
}

function rowHtml(r, groupSupportId){
  const status = licenseStatus(r);
  const pct = licenseBarPct(r);
  const logCount = (r.work_log||[]).length;
  return `
  <tr data-id="${r.id}">
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
    <td data-label="IP">${maskedField(r,'ip')}</td>
    <td data-label="ID">${maskedField(r,'id')}</td>
    <td data-label="PW">${maskedField(r,'pw')}</td>
    <td data-label="OS / 점검">${esc(r.os_ver)||'—'}${r.check_method? `<div style="color:var(--text-faint); font-size:11px; margin-top:2px;">${esc(r.check_method)}</div>`:''}</td>
    <td class="remarks-cell" data-label="비고"><div class="remarks-txt">${esc(r.remarks)||'—'}</div></td>
    <td data-label="작업이력">
      <button class="worklog-btn" data-worklog="${r.id}" title="작업이력 (${logCount}건)">${clipboardSvg()}<span class="cnt">${logCount}</span></button>
    </td>
    <td data-label="관리">
      <div style="display:flex; gap:6px;">
        <button class="wl-action-btn icon-only danger" data-delete-asset="${r.id}" title="삭제">${trashSvg()}</button>
      </div>
    </td>
  </tr>`;
}

function buildFilters(){
  const statusBox = document.getElementById('statusFilters');
  const statuses = [['ok','정상'],['warn','만료임박'],['crit','만료됨'],['na','기간없음']];
  statusBox.innerHTML = statuses.map(([k,l])=>`
    <div class="filter-item ${activeStatusFilters.has(k)?'active':''}" data-status="${k}">
      <span>${l}</span><span class="cnt">${records.filter(r=>licenseStatus(r)===k).length}</span>
    </div>`).join('');
  statusBox.querySelectorAll('[data-status]').forEach(el=>{
    el.onclick = ()=>{
      const k = el.dataset.status;
      if (activeStatusFilters.has(k)) activeStatusFilters.delete(k); else activeStatusFilters.add(k);
      render();
    };
  });

  const countryBox = document.getElementById('countryFilters');
  const owners = [...new Map(records.map(r=>{
    const grp = records.filter(x=>x.group===r.group);
    const meta = groupMeta(grp);
    return [meta.owner, meta];
  })).values()];
  countryBox.innerHTML = owners.map(m=>`
    <div class="filter-item ${activeCountryFilter===m.owner?'active':''}" data-owner="${esc(m.owner)}">
      <span>${esc(m.owner)}</span>
    </div>`).join('');
  countryBox.querySelectorAll('[data-owner]').forEach(el=>{
    el.onclick = ()=>{
      const v = el.dataset.owner;
      activeCountryFilter = activeCountryFilter===v ? null : v;
      render();
    };
  });

  const deviceBox = document.getElementById('deviceTypeFilters');
  const deviceTypes = [...new Set(records.map(deviceTypeLabel))].sort((a,b)=>a.localeCompare(b,'ko'));
  deviceBox.innerHTML = deviceTypes.map(t=>{
    const color = deviceTypeColor(t);
    return `
    <div class="filter-item ${activeDeviceTypeFilter===t?'active':''}" data-devicetype="${esc(t)}">
      <span><span class="device-dot" style="display:inline-block; background:${color}; margin-right:6px;"></span>${esc(t)}</span>
      <span class="cnt">${records.filter(r=>deviceTypeLabel(r)===t).length}</span>
    </div>`;
  }).join('');
  deviceBox.querySelectorAll('[data-devicetype]').forEach(el=>{
    el.onclick = ()=>{
      const v = el.dataset.devicetype;
      activeDeviceTypeFilter = activeDeviceTypeFilter===v ? null : v;
      render();
    };
  });

  const kwBox = document.getElementById('skuKeywordFilters');
  kwBox.innerHTML = SKU_TAG_KEYS.map(k=>{
    const cnt = records.filter(r=>skuKeywordMatches(r.sku).includes(k)).length;
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
}

document.getElementById('searchInput').addEventListener('input', render);
document.getElementById('expandAllBtn').onclick = () => {
  const allOpen = expandedGroups.size > 0;
  if (allOpen){ expandedGroups.clear(); }
  else { records.forEach(r=>expandedGroups.add(r.group)); }
  render();
};

// ---------- add / edit / delete record ----------
const ASSET_FORM_IDS = ['f_owner','f_location','f_support','f_device_type','f_sku','f_sn','f_qty','f_start','f_end','f_os','f_check','f_ip','f_id','f_pw','f_owner_primary','f_owner_secondary','f_cust','f_remarks'];

function clearAssetForm(){
  ASSET_FORM_IDS.forEach(id=>document.getElementById(id).value='');
}

document.getElementById('addBtn').onclick = () => {
  editingRecordId = null;
  clearAssetForm();
  document.getElementById('addModalTitle').textContent = '새 자산 항목 추가';
  document.getElementById('saveAddBtn').textContent = '항목 저장';
  document.getElementById('addModal').classList.add('open');
};
document.getElementById('cancelAddBtn').onclick = () => {
  document.getElementById('addModal').classList.remove('open');
  editingRecordId = null;
};

function deleteAsset(recId){
  const rec = records.find(r=>String(r.id)===String(recId));
  if (!rec) return;
  if (!confirm(`이 자산 항목을 삭제하시겠습니까?\n${rec.sku||''} ${rec.sn? '(S/N '+rec.sn+')':''}`)) return;
  records = records.filter(r=>String(r.id)!==String(recId));
  render();
  scheduleAutoSync();
}

document.getElementById('saveAddBtn').onclick = async () => {
  if (viewOnly || !sessionKey){ alert('자산을 추가하려면 먼저 마스터 비밀번호로 잠금을 해제해야 합니다.'); return; }
  const val = id => document.getElementById(id).value.trim();

  const newId = Math.max(0,...records.map(r=>r.id)) + 1;
  const gid = 'custom-' + newId;
  const rec = {
    id:newId, group:gid, flag:'', owner:val('f_owner')||'(신규 항목)', location:val('f_location'),
    support_id:val('f_support'), device_type:val('f_device_type'), sku:val('f_sku'), sn:val('f_sn'), qty:val('f_qty'),
    start:val('f_start'), end:val('f_end'), remarks:val('f_remarks'), deploy_date:'',
    mode:'', os_ver:val('f_os'), owner_primary:val('f_owner_primary'), owner_secondary:val('f_owner_secondary'), check_method:val('f_check'),
    cust_contact:val('f_cust'), cust_phone:'', cust_email:'', work_log:[],
    ip_enc: await encryptField(val('f_ip')),
    id_enc: await encryptField(val('f_id')),
    pw_enc: await encryptField(val('f_pw')),
  };
  records.push(rec);
  expandedGroups.add(gid);

  document.getElementById('addModal').classList.remove('open');
  clearAssetForm();
  render();
  scheduleAutoSync();
};

// ---------- group (title bar) edit / delete ----------
let groupEditId = null;
let geCustContacts = []; // working copy of {name,phone,email} rows while modal is open

function renderCustContactRows(){
  const wrap = document.getElementById('ge_cust_list');
  wrap.innerHTML = geCustContacts.map((c,idx)=>`
    <div class="cust-contact-row" data-idx="${idx}">
      <input class="cc-name" placeholder="이름" value="${esc(c.name||'')}">
      <input class="cc-phone" placeholder="연락처" value="${esc(c.phone||'')}">
      <input class="cc-email" placeholder="이메일" value="${esc(c.email||'')}">
      <button type="button" class="cc-remove-btn" data-remove="${idx}" title="이 담당자 삭제">✕</button>
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
    name: row.querySelector('.cc-name').value.trim(),
    phone: row.querySelector('.cc-phone').value.trim(),
    email: row.querySelector('.cc-email').value.trim(),
  }));
}

function updateCustAddBtnState(){
  const btn = document.getElementById('ge_cust_add_btn');
  btn.style.display = geCustContacts.length >= 3 ? 'none' : '';
}

document.getElementById('ge_cust_add_btn').onclick = () => {
  captureCustContactsFromDom();
  if (geCustContacts.length >= 3) return;
  geCustContacts.push({name:'', phone:'', email:''});
  renderCustContactRows();
};

function openGroupEditModal(gid){
  if (viewOnly || !sessionKey){ alert('법인 정보를 수정하려면 먼저 마스터 비밀번호로 잠금을 해제해야 합니다.'); return; }
  const items = records.filter(r=>r.group===gid);
  if (!items.length) return;
  const meta = groupMeta(items);
  groupEditId = gid;
  document.getElementById('ge_owner').value = meta.owner==='(법인명 미확인)' ? '' : meta.owner;
  document.getElementById('ge_location').value = meta.location || '';
  document.getElementById('ge_support').value = meta.support_id || '';
  document.getElementById('ge_owner_primary').value = meta.owner_primary || '';
  document.getElementById('ge_owner_secondary').value = meta.owner_secondary || '';
  document.getElementById('ge_remarks').value = meta.group_remarks || '';
  geCustContacts = (meta.cust_contacts && meta.cust_contacts.length
    ? meta.cust_contacts.slice(0,3)
    : [{name:'',phone:'',email:''}]
  ).map(c=>({...c}));
  renderCustContactRows();
  document.getElementById('geError').textContent = '';
  document.getElementById('groupEditModal').classList.add('open');
}

document.getElementById('cancelGeBtn').onclick = () => {
  document.getElementById('groupEditModal').classList.remove('open');
  groupEditId = null;
};

document.getElementById('saveGeBtn').onclick = () => {
  if (!groupEditId) return;
  const val = id => document.getElementById(id).value.trim();
  const newOwner = val('ge_owner');
  if (!newOwner){ document.getElementById('geError').textContent = '법인명을 입력해 주세요.'; return; }
  const newLocation = val('ge_location');
  const newSupport = val('ge_support');
  const newPrimary = val('ge_owner_primary');
  const newSecondary = val('ge_owner_secondary');
  const newRemarks = val('ge_remarks');
  captureCustContactsFromDom();
  const newContacts = geCustContacts.filter(c => c.name || c.phone || c.email).slice(0,3);
  records.forEach(r => {
    if (r.group === groupEditId){
      r.owner = newOwner;
      r.location = newLocation;
      r.support_id = newSupport;
      r.owner_primary = newPrimary;
      r.owner_secondary = newSecondary;
      r.group_remarks = newRemarks;
      r.cust_contacts = newContacts;
      // clear legacy single-contact fields now that the array field is authoritative
      r.cust_contact = ''; r.cust_phone = ''; r.cust_email = '';
    }
  });
  document.getElementById('groupEditModal').classList.remove('open');
  groupEditId = null;
  render();
  scheduleAutoSync();
};

function deleteGroup(gid){
  if (viewOnly || !sessionKey){ alert('법인 정보를 삭제하려면 먼저 마스터 비밀번호로 잠금을 해제해야 합니다.'); return; }
  const items = records.filter(r=>r.group===gid);
  if (!items.length) return;
  const meta = groupMeta(items);
  if (!confirm(`"${meta.owner}" 법인의 자산 항목 ${items.length}건이 모두 삭제됩니다. 계속하시겠습니까?`)) return;
  records = records.filter(r=>r.group!==gid);
  expandedGroups.delete(gid);
  render();
  scheduleAutoSync();
}

// ---------- change master password ----------
document.getElementById('changePassBtn').onclick = () => {
  if (viewOnly || !sessionKey){
    alert('비밀번호를 변경하려면 먼저 마스터 비밀번호로 잠금을 해제해야 합니다.');
    return;
  }
  document.getElementById('cp_old').value = '';
  document.getElementById('cp_new').value = '';
  document.getElementById('cp_new2').value = '';
  document.getElementById('cpError').textContent = '';
  document.getElementById('changePassModal').classList.add('open');
};
document.getElementById('cancelCpBtn').onclick = () => {
  document.getElementById('changePassModal').classList.remove('open');
};

document.getElementById('saveCpBtn').onclick = async () => {
  const errEl = document.getElementById('cpError');
  const oldPass = document.getElementById('cp_old').value;
  const newPass = document.getElementById('cp_new').value;
  const newPass2 = document.getElementById('cp_new2').value;

  if (!oldPass || !newPass || !newPass2){ errEl.textContent = '모든 항목을 입력해 주세요.'; return; }
  if (newPass !== newPass2){ errEl.textContent = '새 비밀번호가 일치하지 않습니다.'; return; }
  if (newPass.length < 8){ errEl.textContent = '새 비밀번호는 8자 이상으로 설정해 주세요.'; return; }
  if (newPass === oldPass){ errEl.textContent = '현재 비밀번호와 다른 비밀번호를 입력해 주세요.'; return; }

  errEl.textContent = '현재 비밀번호 확인 중…';

  const oldKey = await deriveKey(oldPass, ENC_STORE.salt, ENC_STORE.iterations);
  const probe = records.find(r => r.ip_enc || r.id_enc || r.pw_enc);
  if (probe){
    const f = probe.ip_enc || probe.id_enc || probe.pw_enc;
    try{ await decryptWithKey(f, oldKey); }
    catch(e){ errEl.textContent = '현재 비밀번호가 올바르지 않습니다.'; return; }
  }

  errEl.textContent = '민감정보 재암호화 중… (항목이 많으면 몇 초 걸릴 수 있습니다)';

  // Decrypt every sensitive field with the OLD key first. If anything fails
  // partway through, bail out without touching any data.
  let plainMap;
  try{
    plainMap = [];
    for (const rec of records){
      plainMap.push({
        ip: rec.ip_enc ? await decryptWithKey(rec.ip_enc, oldKey) : null,
        id: rec.id_enc ? await decryptWithKey(rec.id_enc, oldKey) : null,
        pw: rec.pw_enc ? await decryptWithKey(rec.pw_enc, oldKey) : null,
      });
    }
  }catch(e){
    errEl.textContent = '기존 데이터 복호화에 실패했습니다. 비밀번호가 변경되지 않았습니다.';
    return;
  }

  // Derive a brand-new key (new salt) from the new password, then re-encrypt.
  const newSalt = bufToB64(crypto.getRandomValues(new Uint8Array(16)).buffer);
  const newIterations = ENC_STORE.iterations || 250000;
  const newKey = await deriveKey(newPass, newSalt, newIterations);

  for (let i = 0; i < records.length; i++){
    const rec = records[i], p = plainMap[i];
    rec.ip_enc = p.ip ? await encryptWithKey(p.ip, newKey) : null;
    rec.id_enc = p.id ? await encryptWithKey(p.id, newKey) : null;
    rec.pw_enc = p.pw ? await encryptWithKey(p.pw, newKey) : null;
  }

  ENC_STORE.salt = newSalt;
  ENC_STORE.iterations = newIterations;
  sessionKey = newKey;

  document.getElementById('changePassModal').classList.remove('open');
  errEl.textContent = '';
  render();
  if (githubConfig && githubToken){
    scheduleAutoSync();
    alert('비밀번호가 변경되었습니다. GitHub에 연결되어 있으므로 잠시 후 저장소에 자동으로 동기화됩니다.');
  } else {
    alert('비밀번호가 변경되었습니다.\n\n지금 바로 "내보내기"를 눌러 새 백업 파일을 저장한 뒤, 서버의 data.json을 그 파일로 교체해 주세요.\n교체하지 않으면 예전 비밀번호로 암호화된 data.json이 그대로 남아, 다음에 열 때는 여전히 예전 비밀번호가 필요합니다.');
  }
};

// ---------- export / import ----------
document.getElementById('exportBtn').onclick = () => {
  const payload = { salt: ENC_STORE.salt, iterations: ENC_STORE.iterations, records };
  const blob = new Blob([JSON.stringify(payload, null, 2)], {type:'application/json'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  const d = new Date();
  a.download = `broadcom-assets-${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}.json`;
  a.click();
};
document.getElementById('importBtn').onclick = () => document.getElementById('importFile').click();
document.getElementById('importFile').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try{
      const data = JSON.parse(reader.result);
      if (!data.records) throw new Error('invalid');
      ENC_STORE.salt = data.salt; ENC_STORE.iterations = data.iterations;
      records = data.records.map(r=>({...r}));
      sessionKey = null; viewOnly = true;
      alert('가져오기 완료. 민감정보를 보려면 이 파일을 만들 때 사용한 마스터 비밀번호로 다시 잠금 해제해 주세요.');
      document.getElementById('lockOverlay').style.display='flex';
      document.getElementById('app').classList.remove('ready');
    }catch(err){ alert('올바른 백업 파일이 아닙니다.'); }
  };
  reader.readAsText(file);
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

function updateGithubButtonState(){
  const connected = !!(githubConfig && githubConfig.repo && githubToken);
  if (!connected) setSyncStatus('offline');
}

function openGithubConnectModal(){
  const cfg = githubConfig || loadGithubConfigFromStorage() || DEFAULT_GITHUB_CONFIG;
  document.getElementById('gh_repo').value = cfg.repo || '';
  document.getElementById('gh_branch').value = cfg.branch || 'main';
  document.getElementById('gh_path').value = cfg.path || 'data.json';
  document.getElementById('gh_token').value = githubToken || loadRememberedToken() || _decodeAuth() || '';
  document.getElementById('gh_remember').checked = !!loadRememberedToken();
  document.getElementById('githubError').textContent = '';
  document.getElementById('githubModal').classList.add('open');
}
document.getElementById('githubSyncStatus').onclick = openGithubConnectModal;
document.getElementById('cancelGithubBtn').onclick = () => {
  document.getElementById('githubModal').classList.remove('open');
};

document.getElementById('githubConnectLoadBtn').onclick = async () => {
  const errEl = document.getElementById('githubError');
  const cfg = {
    repo: document.getElementById('gh_repo').value.trim(),
    branch: document.getElementById('gh_branch').value.trim() || 'main',
    path: document.getElementById('gh_path').value.trim() || 'data.json',
  };
  const token = document.getElementById('gh_token').value.trim();
  const remember = document.getElementById('gh_remember').checked;

  if (!parseOwnerRepo(cfg.repo)){ errEl.textContent = '저장소는 owner/repo 형식으로 입력해 주세요.'; return; }
  if (!token){ errEl.textContent = 'Personal Access Token을 입력해 주세요.'; return; }

  errEl.textContent = 'GitHub에서 불러오는 중…';
  try{
    const { json, sha } = await githubApiGet(cfg, token);
    ENC_STORE = json;
    records = json.records.map(r=>({...r}));
    githubConfig = cfg; githubToken = token; githubSha = sha;
    saveGithubConfigToStorage(cfg);
    if (remember) saveRememberedToken(token); else clearRememberedToken();
    updateGithubButtonState();

    sessionKey = null; viewOnly = true;
    document.getElementById('githubModal').classList.remove('open');
    alert('GitHub에서 데이터를 불러왔습니다. 민감정보를 보려면 이 데이터의 마스터 비밀번호로 다시 잠금 해제해 주세요.');
    document.getElementById('lockOverlay').style.display = 'flex';
    document.getElementById('app').classList.remove('ready');
  }catch(e){
    if (e.notFound){
      // No file yet at this path — treat as a fresh connection; "GitHub에 저장" will create it.
      githubConfig = cfg; githubToken = token; githubSha = null;
      saveGithubConfigToStorage(cfg);
      if (remember) saveRememberedToken(token); else clearRememberedToken();
      updateGithubButtonState();
      errEl.textContent = '';
      document.getElementById('githubModal').classList.remove('open');
      alert('연결되었습니다. 저장소에 아직 파일이 없어 "GitHub에 저장"을 누르면 현재 데이터로 새로 생성됩니다.');
    } else {
      errEl.textContent = e.message || 'GitHub 연결에 실패했습니다.';
    }
  }
};

document.getElementById('githubSaveBtn').onclick = async () => {
  if (!githubConfig || !githubToken){
    alert('먼저 GitHub 저장소에 연결해 주세요.');
    openGithubConnectModal();
    return;
  }
  const btn = document.getElementById('githubSaveBtn');
  const originalText = btn.textContent;
  btn.textContent = '저장 중…';
  btn.disabled = true;
  clearTimeout(autoSyncTimer);
  setSyncStatus('syncing');
  try{
    const payload = { salt: ENC_STORE.salt, iterations: ENC_STORE.iterations, records };
    const newSha = await githubApiPut(githubConfig, githubToken, payload, githubSha);
    githubSha = newSha;
    setSyncStatus('synced');
    alert(`GitHub 저장소(${githubConfig.repo})에 저장되었습니다.`);
  }catch(e){
    setSyncStatus('error', e.message);
    alert(e.message || 'GitHub 저장에 실패했습니다.');
  }finally{
    btn.textContent = originalText;
    btn.disabled = false;
  }
};

updateGithubButtonState();
dataReady.then(() => updateGithubButtonState());

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
const WL_FIELD_MAP = [
  { input:'wl_new_start', field:'start', label:'라이선스 시작일' },
  { input:'wl_new_end',   field:'end',   label:'라이선스 종료일' },
  { input:'wl_new_os',    field:'os_ver', label:'OS 버전' },
  { input:'wl_new_check', field:'check_method', label:'점검 방식' },
];

function resetFieldChangeInputs(){
  document.getElementById('wl_apply_toggle').checked = false;
  document.getElementById('wl_fieldchange_grid').style.display = 'none';
  WL_FIELD_MAP.forEach(f => document.getElementById(f.input).value = '');
}

document.getElementById('wl_apply_toggle').addEventListener('change', (e) => {
  document.getElementById('wl_fieldchange_grid').style.display = e.target.checked ? '' : 'none';
});

// Reads the optional "apply to asset" fields and, for any that were filled
// in, applies them to the record and returns a small { field, label, from, to }
// list describing what changed (used both to mutate the record and to leave
// a readable trail on the work-log entry itself).
function applyFieldChanges(rec){
  const changes = [];
  const fieldChanges = {};
  WL_FIELD_MAP.forEach(f => {
    const val = document.getElementById(f.input).value.trim();
    if (!val) return;
    const from = rec[f.field] || '—';
    if (val === rec[f.field]) return;
    changes.push({ field:f.field, label:f.label, from, to:val });
    fieldChanges[f.field] = val;
    rec[f.field] = val;
  });
  return { changes, fieldChanges };
}

function fieldChangesSummary(changes){
  if (!changes || !changes.length) return '';
  return changes.map(c => `${c.label}: ${c.from} → ${c.to}`).join(' · ');
}

function fmtDateDots(nativeVal){
  // nativeVal is "YYYY-MM-DD" from <input type="date">
  if (!nativeVal) return '';
  const [y,m,d] = nativeVal.split('-').map(Number);
  if (!y || !m || !d) return '';
  return `${y}.${m}.${d}`;
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
        <div class="wl-meta">${esc(entry.date)||'날짜 미기재'} · ${esc(entry.manager)||'담당자 미기재'}</div>
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
        document.getElementById('wl_fieldchange_grid').style.display = '';
        WL_FIELD_MAP.forEach(f => {
          if (entry.field_changes[f.field] !== undefined) document.getElementById(f.input).value = entry.field_changes[f.field];
        });
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

document.getElementById('wlAddBtn').onclick = () => {
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
    const result = applyFieldChanges(rec);
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
    const entry = { id: Date.now(), type, date, manager, note };
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
