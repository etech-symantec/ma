// ---------- data loading (external JSON / GitHub) ----------
let ENC_STORE = null;
let githubConfig = null;   // {repo, branch, path} - non-sensitive, persisted in localStorage
let githubToken = null;    // PAT - only persisted if user opts in
let githubSha = null;      // sha of the last-loaded file, needed to PUT updates

const dataReady = (async () => {
  const cfg = loadGithubConfigFromStorage();
  const token = loadRememberedToken();
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

// ---------- crypto helpers ----------
function b64ToBuf(b64){ return Uint8Array.from(atob(b64), c => c.charCodeAt(0)).buffer; }
function bufToB64(buf){ return btoa(String.fromCharCode(...new Uint8Array(buf))); }

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

function groupMeta(items){
  const head = items.find(r => r.owner) || items[0];
  return {
    flag: head.flag || '',
    owner: head.owner || '(법인명 미확인)',
    location: items.map(i=>i.location).find(Boolean) || '',
    support_id: items.map(i=>i.support_id).find(Boolean) || '',
    owner_primary: items.map(i=>i.owner_primary).find(Boolean) || '',
    owner_secondary: items.map(i=>i.owner_secondary).find(Boolean) || '',
    cust_contact: items.map(i=>i.cust_contact).find(Boolean) || '',
    cust_phone: items.map(i=>i.cust_phone).find(Boolean) || '',
    cust_email: items.map(i=>i.cust_email).find(Boolean) || ''
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

function render(){
  const q = document.getElementById('searchInput').value.trim().toLowerCase();
  let list = records.filter(r => {
    if (!activeStatusFilters.has(licenseStatus(r))) return false;
    if (activeDeviceTypeFilter && deviceTypeLabel(r) !== activeDeviceTypeFilter) return false;
    if (activeCountryFilter){
      const grpItems = records.filter(x=>x.group===r.group);
      const meta = groupMeta(grpItems);
      if (meta.owner !== activeCountryFilter) return false;
    }
    if (q){
      const hay = [r.owner,r.location,r.sku,r.sn,r.support_id,r.owner_primary,r.owner_secondary,r.cust_contact,deviceTypeLabel(r),r.remarks].join(' ').toLowerCase();
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
            <div class="group-flag">${esc(meta.flag)}</div>
            <div class="group-title">
              <h3>${esc(meta.owner)}</h3>
              <div class="sub">
                <span>${esc(meta.location)||''}</span>
                ${meta.support_id? `<span><b>Support ID</b> ${esc(meta.support_id)}</span>`:''}
                <span><b>항목</b> ${items.length}건</span>
              </div>
              ${groupContactsHtml(meta)}
            </div>
          </div>
          <div class="group-badges">
            <span class="badge ${worst==='crit'?'tag-x':worst==='warn'?'':'tag-o'}" style="color:${worst==='crit'?'var(--red)':worst==='warn'?'var(--amber)':worst==='ok'?'var(--green)':'var(--text-faint)'}">${statusLabel(worst)}</span>
            <span class="chev ${isOpen?'open':''}">›</span>
          </div>
        </div>
        <div class="items ${isOpen?'open':''}">
          <table>
            <thead><tr>
              <th>장비 종류</th><th>SKU / 제품</th><th>S/N</th><th>수량</th><th>라이선스 기간</th>
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
  document.querySelectorAll('[data-edit-asset]').forEach(btn=>{
    btn.onclick = async (e) => {
      e.stopPropagation();
      await openEditAssetModal(btn.dataset.editAsset);
    };
  });
  document.querySelectorAll('[data-delete-asset]').forEach(btn=>{
    btn.onclick = (e) => {
      e.stopPropagation();
      deleteAsset(btn.dataset.deleteAsset);
    };
  });

  updateStats();
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
  if (meta.owner_primary) parts.push(`<span><b>담당(정)</b> ${esc(meta.owner_primary)}</span>`);
  if (meta.owner_secondary) parts.push(`<span><b>담당(부)</b> ${esc(meta.owner_secondary)}</span>`);
  if (meta.cust_contact || meta.cust_phone || meta.cust_email){
    const bits = [meta.cust_contact, meta.cust_phone, meta.cust_email].filter(Boolean).map(esc).join(' · ');
    parts.push(`<span><b>고객사 담당자</b> ${bits}</span>`);
  }
  if (!parts.length) return '';
  return `<div class="sub group-contacts">${parts.join('')}</div>`;
}

function rowHtml(r, groupSupportId){
  const status = licenseStatus(r);
  const pct = licenseBarPct(r);
  const logCount = (r.work_log||[]).length;
  return `
  <tr data-id="${r.id}">
    <td data-label="장비 종류">${deviceBadge(r)}</td>
    <td class="sku" data-label="SKU">${esc(r.sku)||'—'}</td>
    <td class="sn" data-label="S/N">${snLink(r, groupSupportId)}</td>
    <td data-label="수량">${esc(r.qty||r.entitlement)||'—'}</td>
    <td data-label="라이선스 기간">
      <div class="lic-bar-wrap">
        <div class="lic-dates">${esc(r.start)||'-'} → ${esc(r.end)||'-'}</div>
        <div class="lic-bar"><i style="width:${pct}%; background:${statusColorVar(status)}"></i></div>
        <div class="lic-status ${status}">${statusLabel(status)}</div>
      </div>
    </td>
    <td data-label="IP">${maskedField(r,'ip')}</td>
    <td data-label="ID">${maskedField(r,'id')}</td>
    <td data-label="PW">${maskedField(r,'pw')}</td>
    <td data-label="OS / 점검">${esc(r.os_ver)||'—'}${r.check_method? `<div style="color:var(--text-faint); font-size:11px; margin-top:2px;">${esc(r.check_method)}</div>`:''}</td>
    <td class="remarks-cell" data-label="비고"><div class="remarks-txt">${esc(r.remarks)||'—'}</div></td>
    <td data-label="작업이력">
      <button class="worklog-btn" data-worklog="${r.id}">이력 <span class="cnt">${logCount}</span></button>
    </td>
    <td data-label="관리">
      <div style="display:flex; gap:6px;">
        <button class="wl-action-btn" data-edit-asset="${r.id}">수정</button>
        <button class="wl-action-btn danger" data-delete-asset="${r.id}">삭제</button>
      </div>
    </td>
  </tr>`;
}

function updateStats(){
  document.getElementById('statTotal').textContent = records.length;
  document.getElementById('statOk').textContent = records.filter(r=>licenseStatus(r)==='ok').length;
  document.getElementById('statWarn').textContent = records.filter(r=>licenseStatus(r)==='warn').length;
  document.getElementById('statExpired').textContent = records.filter(r=>licenseStatus(r)==='crit').length;
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

async function openEditAssetModal(recId){
  if (viewOnly || !sessionKey){ alert('자산을 수정하려면 먼저 마스터 비밀번호로 잠금을 해제해야 합니다.'); return; }
  const rec = records.find(r=>String(r.id)===String(recId));
  if (!rec) return;
  editingRecordId = rec.id;
  const set = (id,val) => document.getElementById(id).value = val || '';
  set('f_owner', rec.owner==='(신규 항목)'?'':rec.owner);
  set('f_location', rec.location);
  set('f_support', rec.support_id);
  set('f_device_type', rec.device_type);
  set('f_sku', rec.sku);
  set('f_sn', rec.sn);
  set('f_qty', rec.qty || rec.entitlement);
  set('f_start', rec.start);
  set('f_end', rec.end);
  set('f_os', rec.os_ver);
  set('f_check', rec.check_method);
  set('f_ip', rec.ip_enc ? await decryptField(rec.ip_enc) : '');
  set('f_id', rec.id_enc ? await decryptField(rec.id_enc) : '');
  set('f_pw', rec.pw_enc ? await decryptField(rec.pw_enc) : '');
  set('f_owner_primary', rec.owner_primary);
  set('f_owner_secondary', rec.owner_secondary);
  set('f_cust', rec.cust_contact);
  set('f_remarks', rec.remarks);
  document.getElementById('addModalTitle').textContent = '자산 항목 수정';
  document.getElementById('saveAddBtn').textContent = '변경사항 저장';
  document.getElementById('addModal').classList.add('open');
}

function deleteAsset(recId){
  const rec = records.find(r=>String(r.id)===String(recId));
  if (!rec) return;
  if (!confirm(`이 자산 항목을 삭제하시겠습니까?\n${rec.sku||''} ${rec.sn? '(S/N '+rec.sn+')':''}`)) return;
  records = records.filter(r=>String(r.id)!==String(recId));
  render();
}

document.getElementById('saveAddBtn').onclick = async () => {
  if (viewOnly || !sessionKey){ alert('자산을 추가/수정하려면 먼저 마스터 비밀번호로 잠금을 해제해야 합니다.'); return; }
  const val = id => document.getElementById(id).value.trim();

  if (editingRecordId){
    const rec = records.find(r=>String(r.id)===String(editingRecordId));
    if (!rec){ editingRecordId = null; document.getElementById('addModal').classList.remove('open'); return; }
    rec.owner = val('f_owner')||'(신규 항목)';
    rec.location = val('f_location');
    rec.support_id = val('f_support');
    rec.device_type = val('f_device_type');
    rec.sku = val('f_sku');
    rec.sn = val('f_sn');
    rec.qty = val('f_qty');
    rec.start = val('f_start');
    rec.end = val('f_end');
    rec.os_ver = val('f_os');
    rec.check_method = val('f_check');
    rec.owner_primary = val('f_owner_primary');
    rec.owner_secondary = val('f_owner_secondary');
    rec.cust_contact = val('f_cust');
    rec.remarks = val('f_remarks');
    rec.ip_enc = await encryptField(val('f_ip'));
    rec.id_enc = await encryptField(val('f_id'));
    rec.pw_enc = await encryptField(val('f_pw'));
    editingRecordId = null;
  } else {
    const newId = Math.max(0,...records.map(r=>r.id)) + 1;
    const gid = 'custom-' + newId;
    const rec = {
      id:newId, group:gid, flag:'', owner:val('f_owner')||'(신규 항목)', location:val('f_location'),
      support_id:val('f_support'), device_type:val('f_device_type'), sku:val('f_sku'), sn:val('f_sn'), entitlement:'🔗', qty:val('f_qty'),
      start:val('f_start'), end:val('f_end'), remarks:val('f_remarks'), deploy_date:'',
      mode:'', os_ver:val('f_os'), owner_primary:val('f_owner_primary'), owner_secondary:val('f_owner_secondary'), check_method:val('f_check'),
      cust_contact:val('f_cust'), cust_phone:'', cust_email:'', work_log:[],
      ip_enc: await encryptField(val('f_ip')),
      id_enc: await encryptField(val('f_id')),
      pw_enc: await encryptField(val('f_pw')),
    };
    records.push(rec);
    expandedGroups.add(gid);
  }

  document.getElementById('addModal').classList.remove('open');
  clearAssetForm();
  render();
};

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
  alert('비밀번호가 변경되었습니다.\n\n지금 바로 "내보내기"를 눌러 새 백업 파일을 저장한 뒤, 서버의 data.json을 그 파일로 교체해 주세요.\n교체하지 않으면 예전 비밀번호로 암호화된 data.json이 그대로 남아, 다음에 열 때는 여전히 예전 비밀번호가 필요합니다.');
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
  document.getElementById('githubConnectBtn').classList.toggle('on', connected);
  document.getElementById('githubConnectBtn').textContent = connected ? `🐙 ${githubConfig.repo}` : '🐙 GitHub';
}

document.getElementById('githubConnectBtn').onclick = () => {
  const cfg = githubConfig || loadGithubConfigFromStorage() || {};
  document.getElementById('gh_repo').value = cfg.repo || '';
  document.getElementById('gh_branch').value = cfg.branch || 'main';
  document.getElementById('gh_path').value = cfg.path || 'data.json';
  document.getElementById('gh_token').value = githubToken || loadRememberedToken() || '';
  document.getElementById('gh_remember').checked = !!loadRememberedToken();
  document.getElementById('githubError').textContent = '';
  document.getElementById('githubModal').classList.add('open');
};
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
    alert('먼저 "🐙 GitHub" 버튼으로 저장소에 연결해 주세요.');
    document.getElementById('githubConnectBtn').click();
    return;
  }
  const btn = document.getElementById('githubSaveBtn');
  const originalText = btn.textContent;
  btn.textContent = '저장 중…';
  btn.disabled = true;
  try{
    const payload = { salt: ENC_STORE.salt, iterations: ENC_STORE.iterations, records };
    const newSha = await githubApiPut(githubConfig, githubToken, payload, githubSha);
    githubSha = newSha;
    alert(`GitHub 저장소(${githubConfig.repo})에 저장되었습니다.`);
  }catch(e){
    alert(e.message || 'GitHub 저장에 실패했습니다.');
  }finally{
    btn.textContent = originalText;
    btn.disabled = false;
  }
};

updateGithubButtonState();

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
  workLogEditId = null;
  setWorkLogFormMode(false);
  renderWorkLogList();
  document.getElementById('workLogModal').classList.add('open');
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

  if (workLogEditId){
    const entry = rec.work_log.find(e=>String(e.id)===String(workLogEditId));
    if (entry){ entry.type=type; entry.date=date; entry.manager=manager; entry.note=note; }
    workLogEditId = null;
    setWorkLogFormMode(false);
  } else {
    rec.work_log.push({ id: Date.now(), type, date, manager, note });
  }
  document.getElementById('wl_date').value = '';
  document.getElementById('wl_manager').value = '';
  document.getElementById('wl_note').value = '';
  renderWorkLogList();
  render();
};

document.getElementById('wlCancelEditBtn').onclick = () => {
  workLogEditId = null;
  document.getElementById('wl_date').value = '';
  document.getElementById('wl_manager').value = '';
  document.getElementById('wl_note').value = '';
  setWorkLogFormMode(false);
};

document.getElementById('wlCloseBtn').onclick = () => {
  document.getElementById('workLogModal').classList.remove('open');
  workLogRecordId = null;
  workLogEditId = null;
};
