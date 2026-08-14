/*
 * Initial asset bundle
 * - 자산/법인/사용자/암호화/작업이력/동기화 공통 로직
 * - 대시보드/유지보수/메일/전체이력은 js/feature 파일로 지연 로드
 */
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

/* data.json 전용 SHA / 3-way merge 기준 */
let githubSha = null;
let lastSyncedState = null;

/* ma.json 전용 SHA / 3-way merge 기준 */
let maintenanceGithubSha = null;
let lastSyncedMaintenanceState = null;

/* 감사기록과 별개인 경량 동기화 작업 ID 목록 */
let dataSyncMutations = [];
let maintenanceSyncMutations = [];

function cloneSyncState(v){
  return v == null
    ? v
    : JSON.parse(JSON.stringify(v));
}

/* data.json: 법인/자산/사용자/감사기록만 저장 */
function currentSyncState(){
  return {
    salt: ENC_STORE.salt,
    iterations: ENC_STORE.iterations,

    records: cloneSyncState(records || []),
    users: cloneSyncState(users || []),
    auditLogs: cloneSyncState(auditLogs || []),
    syncMutations: cloneSyncState(dataSyncMutations || [])
  };
}

/* ma.json: 유지보수 점검 기록만 저장 */
function currentMaintenanceState(){
  return {
    maintenanceLogs: cloneSyncState(maintenanceLogs || []),
    syncMutations: cloneSyncState(maintenanceSyncMutations || [])
  };
}

// Hardcoded default repo location.
const DEFAULT_GITHUB_CONFIG = {
  repo: 'etech-symantec/ma',
  branch: 'main',
  path: 'data.json'
};

function maintenanceGithubConfigOf(cfg){
  return {
    ...cfg,
    path:'ma.json'
  };
}

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
let dataDirty = false;
let dataChangeVersion = 0;
let lastAutoSyncError = null;

/* ma.json 동기화는 data.json과 완전히 별도 상태로 관리 */
let maintenanceSyncInFlight = false;
let maintenanceSyncQueued = false;
let maintenanceDirty = false;
let maintenanceChangeVersion = 0;
let lastMaintenanceSyncError = null;

/* =========================================================
   브라우저 단일 저장 Queue
   - data.json / ma.json 포함 모든 GitHub 저장 요청을 한 줄로 직렬화
   - 같은 브라우저에서 GET → merge → PUT 작업이 절대 겹치지 않음
   ========================================================= */
let browserSyncQueue = Promise.resolve();
let browserSyncQueuePending = 0;
let activeSyncAbortController = null;
let activeSyncKind = null;
let syncStuckTimer = null;
let forceManualRetryBusy = false;
const SYNC_STUCK_MS = 5000; // 5초

function enqueueBrowserSync(kind, task){
  browserSyncQueuePending += 1;

  const run = async () => {
    try{
      return await task();
    }
    finally{
      browserSyncQueuePending = Math.max(0, browserSyncQueuePending - 1);
    }
  };

  const queued = browserSyncQueue.then(run, run);

  /* 앞 작업 실패가 다음 작업을 막지 않도록 Queue 체인은 항상 복구 */
  browserSyncQueue = queued.catch(() => {});

  return queued;
}

/* =========================================================
   변경 작업 고유 ID
   - 한 번의 사용자 변경 작업은 하나의 mutation_id를 사용
   - 자산/법인/사용자/작업이력/유지보수 점검에 기록
   ========================================================= */
function createMutationId(scope='data'){
  let randomPart = '';

  try{
    if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function'){
      randomPart = globalThis.crypto.randomUUID();
    }
  }
  catch(e){}

  if (!randomPart){
    randomPart =
      Math.random().toString(36).slice(2,10) +
      Math.random().toString(36).slice(2,10);
  }

  return `${scope}-${Date.now().toString(36)}-${randomPart}`;
}

function mutationComparable(value){
  if (value === null || value === undefined) return value;

  const cloned = cloneSyncState(value);

  const strip = obj => {
    if (!obj || typeof obj !== 'object') return;

    delete obj.last_mutation_id;
    delete obj.mutation_id;

    if (Array.isArray(obj.work_log)){
      obj.work_log.forEach(strip);
    }
    if (Array.isArray(obj.deleted_work_log)){
      obj.deleted_work_log.forEach(strip);
    }
  };

  strip(cloned);
  return cloned;
}

/* 현재 auditSnapshot과 비교해 실제로 변경된 data.json 객체에 mutation_id를 남긴다. */
function stampDataMutation(mutationId){
  if (!mutationId || !auditSnapshot) return;

  const beforeRecords = new Map(
    (auditSnapshot.records || []).map(r => [String(r.id), r])
  );
  const beforeUsers = new Map(
    (auditSnapshot.users || []).map(u => [String(u.id), u])
  );

  records.forEach(rec => {
    const before = beforeRecords.get(String(rec.id));
    const changed =
      !before ||
      !syncEqual(
        mutationComparable(before),
        mutationComparable(rec)
      );

    if (!changed) return;

    rec.last_mutation_id = mutationId;

    const oldWork = new Map(
      ((before && before.work_log) || []).map(e => [String(e.id), e])
    );
    (rec.work_log || []).forEach(entry => {
      const oldEntry = oldWork.get(String(entry.id));
      if (
        !oldEntry ||
        !syncEqual(
          mutationComparable(oldEntry),
          mutationComparable(entry)
        )
      ){
        entry.mutation_id = mutationId;
      }
    });

    const oldDeleted = new Map(
      ((before && before.deleted_work_log) || []).map(e => [String(e.history_id || e.id), e])
    );
    (rec.deleted_work_log || []).forEach(entry => {
      const key = String(entry.history_id || entry.id);
      const oldEntry = oldDeleted.get(key);
      if (
        !oldEntry ||
        !syncEqual(
          mutationComparable(oldEntry),
          mutationComparable(entry)
        )
      ){
        entry.mutation_id = mutationId;
      }
    });
  });

  users.forEach(user => {
    const before = beforeUsers.get(String(user.id));
    const changed =
      !before ||
      !syncEqual(
        mutationComparable(before),
        mutationComparable(user)
      );

    if (changed){
      user.last_mutation_id = mutationId;
    }
  });
}

function rememberSyncMutation(list, mutationId, scope){
  if (!mutationId) return;

  if (!list.some(x => String(x.id) === String(mutationId))){
    list.push({
      id: String(mutationId),
      ts: Date.now(),
      scope: String(scope || '')
    });
  }

  /* 동기화 메타데이터가 무한히 커지지 않도록 최근 500건만 유지 */
  if (list.length > 500){
    list.splice(0, list.length - 500);
  }
}

function markDataDirty(mutationId){
  const mid = mutationId || createMutationId('data');
  rememberSyncMutation(dataSyncMutations, mid, 'data');
  dataDirty = true;
  dataChangeVersion += 1;
  return mid;
}

function markMaintenanceDirty(mutationId){
  const mid = mutationId || createMutationId('ma');
  rememberSyncMutation(maintenanceSyncMutations, mid, 'maintenance');
  maintenanceDirty = true;
  maintenanceChangeVersion += 1;
  return mid;
}

let manualSyncRetryBusy = false;
async function retryFailedSyncManually(){
  if (manualSyncRetryBusy){
    return;
  }

  if (!githubConfig || !githubToken){
    setSyncStatus(
      'error',
      'GitHub 연결 정보가 없습니다.'
    );
    return;
  }

  const retryData =
    dataDirty === true;

  const retryMaintenance =
    maintenanceDirty === true;

  if (
    !retryData &&
    !retryMaintenance
  ){
    setSyncStatus('synced');
    return;
  }
  manualSyncRetryBusy = true;

  if (autoSyncTimer !== null){
    clearTimeout(autoSyncTimer);
    autoSyncTimer = null;
  }
  setSyncStatus('syncing');
  try{
    if (retryData){
      lastAutoSyncError = null;
      await runAutoSync();
      if (dataDirty){
        throw (
          lastAutoSyncError ||
          new Error(
            'data.json 재저장에 실패했습니다.'
          )
        );
      }
    }

    if (retryMaintenance){
      lastMaintenanceSyncError = null;
      await runMaintenanceSync();

      if (maintenanceDirty){
        throw (
          lastMaintenanceSyncError ||
          new Error(
            'ma.json 재저장에 실패했습니다.'
          )
        );
      }
    }

    setSyncStatus('synced');
  }
  catch(e){
    console.error(
      '수동 동기화 재시도 실패:',
      e
    );

    setSyncStatus(
      'error',
      e.message
    );
  }
  finally{
    manualSyncRetryBusy = false;
  }
}

async function forceManualResave(){
  if (forceManualRetryBusy){
    return;
  }
  if (!githubConfig || !githubToken){
    setSyncStatus(
      'error',
      'GitHub 연결 정보가 없습니다.'
    );
    return;
  }
  forceManualRetryBusy = true;

  let retryKind =
    activeSyncKind;

  if (!retryKind){
    if (maintenanceDirty && !dataDirty){
      retryKind = 'maintenance';
    }
    else {
      retryKind = 'data';
    }
  }

  try{
    clearTimeout(syncStuckTimer);
    syncStuckTimer = null;

    if (autoSyncTimer !== null){
      clearTimeout(autoSyncTimer);
      autoSyncTimer = null;
    }

    autoSyncQueued = false;
    maintenanceSyncQueued = false;

    if (
      activeSyncAbortController &&
      !activeSyncAbortController.signal.aborted
    ){
      console.warn(
        `진행 중인 ${retryKind} 동기화를 중단하고 수동 재저장을 시작합니다.`
      );
      activeSyncAbortController.abort();
    }

    setSyncStatus(
      'pending',
      '기존 요청 중단 후 다시 저장합니다.'
    );

    const waitStartedAt =
      Date.now();

    while (
      autoSyncInFlight ||
      maintenanceSyncInFlight
    ){
      await sleepMs(50);
      if (
        Date.now() -
        waitStartedAt >
        5000
      ){
        console.warn(
          '기존 동기화 종료 대기 시간이 초과되었습니다.'
        );
        break;
      }
    }

    if (retryKind === 'maintenance'){
      maintenanceDirty = true;
      lastMaintenanceSyncError =
        null;

      await runMaintenanceSync();
      if (maintenanceDirty){
        throw (
          lastMaintenanceSyncError ||
          new Error(
            'ma.json 수동 재저장에 실패했습니다.'
          )
        );
      }
    }
    else {
      dataDirty = true;
      lastAutoSyncError =
        null;

      await runAutoSync();
      if (dataDirty){
        throw (
          lastAutoSyncError ||
          new Error(
            'data.json 수동 재저장에 실패했습니다.'
          )
        );
      }
    }
    setSyncStatus('synced');
  }
  catch(e){
    console.error(
      '강제 수동 재저장 실패:',
      e
    );
    setSyncStatus(
      'error',
      e.message
    );
  }
  finally{
    forceManualRetryBusy =
      false;
  }
}

function setSyncStatus(state, msg){
  clearTimeout(syncStuckTimer);
  syncStuckTimer = null;
  const el = document.getElementById('githubSyncStatus');
  if (!el) return;
  el.onclick = null;
  el.removeAttribute('role');
  el.removeAttribute('tabindex');

  if (state === 'pending'){
    el.textContent = '저장 대기';
    el.title = '변경사항 GitHub 동기화 대기 중';
    el.className = 'sync-status pending';
  }
  else if (state === 'syncing'){
    el.textContent =
      '동기화 중…';
    el.title =
      'GitHub에 데이터를 저장하고 있습니다.';
    el.className =
      'sync-status syncing';
    clearTimeout(syncStuckTimer);
    syncStuckTimer =
      setTimeout(() => {
        if (
          !autoSyncInFlight &&
          !maintenanceSyncInFlight
        ){
          return;
        }
        el.textContent =
          '↻ 수동 재저장';
        el.title =
          '동기화가 오래 걸리고 있습니다.\n' +
          '클릭하면 현재 요청을 중단하고 최신 데이터를 다시 불러와 저장합니다.';
        el.className =
          'sync-status syncing sync-stuck';
        el.onclick =
          forceManualResave;
      }, SYNC_STUCK_MS);
  }
  else if (state === 'synced'){
    const time = new Date().toLocaleTimeString('ko-KR');
    el.textContent = '✓ 저장됨';
    el.title = `GitHub 동기화 완료 · ${time}`;
    el.className = 'sync-status synced';
  }
  else if (state === 'error'){
    el.textContent =
      '⚠ 저장 실패';
    el.title =
      'GitHub 동기화 실패: ' +
      (msg || '') +
      '\n\n클릭하면 다시 저장합니다.';
    el.className =
      'sync-status error';
    el.onclick =
      retryFailedSyncManually;
    el.setAttribute(
      'role',
      'button'
    );
    el.setAttribute(
      'tabindex',
      '0'
    );
  }
  else if (state === 'offline'){
    el.textContent = '';
    el.title = '';
    el.className = 'sync-status';
  }
}

document.getElementById('githubSyncStatus')?.addEventListener('keydown', e => {
      if ((e.key === 'Enter' || e.key === ' ') &&
        e.currentTarget
          .classList
          .contains('error')
      ){
        e.preventDefault();
        retryFailedSyncManually();
      }
    }
  );

function scheduleAutoSync(mutationId){
  const mid = mutationId || createMutationId('data');

  /* 실제 변경된 객체/작업이력에 같은 mutation_id를 기록 */
  stampDataMutation(mid);
  captureAuditFromStateDiff(mid);
  markDataDirty(mid);

  if (!githubConfig || !githubToken){
    setSyncStatus('error', 'GitHub 연결 정보가 없습니다.');
    return mid;
  }

  setSyncStatus('pending');
  clearTimeout(autoSyncTimer);
  autoSyncTimer = setTimeout(() => {
    autoSyncTimer = null;
    runAutoSync();
  }, 1200);

  return mid;
}

/* =========================================================
   작업 이력 - 저장 완료까지 화면 잠금
   ========================================================= */
let workLogSyncBusy = false;
let pendingWorkLogSyncTask = null;
let syncStartedAt = 0;
let syncCountdownTimer = null;

function sleepMs(ms){
  return new Promise(resolve =>
    setTimeout(resolve, ms)
  );
}


/* 중앙 동기화 화면을 필요할 때 자동 생성 */
function ensureWorkLogSyncOverlay(){

  let overlay =
    document.getElementById(
      'workLogSyncOverlay'
    );

  if (overlay){
    return overlay;
  }


  overlay =
    document.createElement('div');

  overlay.id =
    'workLogSyncOverlay';

  overlay.className =
    'worklog-sync-overlay';


  overlay.innerHTML = `
    <div class="worklog-sync-card">

      <div
        class="worklog-sync-spinner"
        id="workLogSyncSpinner"
      ></div>

      <div
        class="worklog-sync-title"
        id="workLogSyncTitle"
      >
        GitHub 동기화 중…
      </div>

      <div
        class="worklog-sync-message"
        id="workLogSyncMessage"
      >
        저장이 완료될 때까지 기다려 주세요.
      </div>

      <button
        type="button"
        class="btn btn-primary worklog-sync-retry"
        id="workLogSyncRetryBtn"
        disabled
      >
        ↻ 수동 재저장 (10초 후)
      </button>
    </div>
  `;


  document.body.appendChild(
    overlay
  );


  const retryBtn =
    document.getElementById(
      'workLogSyncRetryBtn'
    );


  retryBtn.onclick = async () => {
    if (retryBtn.disabled){
      return;
    }
    await forceManualResave();
  };

  return overlay;
}


/*
  저장 화면 표시
*/
function showWorkLogSyncOverlay(label){

  const overlay =
    ensureWorkLogSyncOverlay();


  overlay.classList.remove(
    'is-success',
    'is-error'
  );

  overlay.classList.add(
    'open'
  );


  document.getElementById(
    'workLogSyncSpinner'
  ).style.display = '';


  document.getElementById(
    'workLogSyncTitle'
  ).textContent =
    label || 'GitHub 동기화 중…';


  document.getElementById(
    'workLogSyncMessage'
  ).textContent =
    'GitHub 저장이 완료될 때까지 다른 작업을 할 수 없습니다.';


  const retryBtn =
    document.getElementById(
      'workLogSyncRetryBtn'
    );

  if (!syncStartedAt){
    syncStartedAt = Date.now();
  }
  
  retryBtn.style.display = '';
  retryBtn.disabled = true;
  
  if (syncCountdownTimer){
    clearInterval(syncCountdownTimer);
    syncCountdownTimer = null;
  }
    
  function updateForceRetryButton(){
    const elapsed =
      Date.now() - syncStartedAt;
    const remain =
      Math.max(
        0,
        Math.ceil(
          (SYNC_STUCK_MS - elapsed) / 1000
        )
      );
  
    if (remain > 0){
      retryBtn.disabled = true;
      retryBtn.textContent =
        `↻ 수동 재저장 (${remain}초 후)`;
      return;
    }
  
    retryBtn.disabled = false;
    retryBtn.textContent =
      '↻ 수동 재저장';
  
    if (syncCountdownTimer){
      clearInterval(
        syncCountdownTimer
      );
      syncCountdownTimer = null;
    }
  }
  updateForceRetryButton();
  syncCountdownTimer =
    setInterval(
      updateForceRetryButton,
      250
    );
}

async function flushAutoSyncNow(){
  const mutationId = createMutationId('data');
  stampDataMutation(mutationId);
  captureAuditFromStateDiff(mutationId);
  markDataDirty(mutationId);


  if (
    !githubConfig ||
    !githubToken
  ){
    throw new Error(
      'GitHub 연결 정보가 없습니다.'
    );
  }

  if (autoSyncTimer !== null){

    clearTimeout(
      autoSyncTimer
    );

    autoSyncTimer = null;
  }


  /*
    이미 다른 저장이 진행 중이라면
    먼저 끝날 때까지 기다림
  */
  while (autoSyncInFlight){

    await sleepMs(80);

  }


  autoSyncQueued = false;

  lastAutoSyncError = null;


  /*
    현재 최신 데이터를 즉시 저장
  */
  await runAutoSync();


  /*
    runAutoSync() 내부에서 오류를 catch하므로
    dataDirty로 최종 성공 여부 확인
  */
  if (dataDirty){

    throw (
      lastAutoSyncError ||
      new Error(
        'GitHub 동기화가 완료되지 않았습니다.'
      )
    );

  }


  return true;
}



/* ma.json 유지보수 점검을 즉시 동기화 */
async function flushMaintenanceSyncNow(){
  if (!maintenanceDirty){
    markMaintenanceDirty(createMutationId('ma-sync'));
  }

  if (!githubConfig || !githubToken){
    throw new Error('GitHub 연결 정보가 없습니다.');
  }

  while (maintenanceSyncInFlight){
    await sleepMs(80);
  }

  maintenanceSyncQueued = false;
  lastMaintenanceSyncError = null;

  await runMaintenanceSync();

  if (maintenanceDirty){
    throw (
      lastMaintenanceSyncError ||
      new Error('유지보수 점검 GitHub 동기화가 완료되지 않았습니다.')
    );
  }

  return true;
}

/*
  작업 이력 저장 전용

  성공할 때까지 화면 전체 클릭 차단.
  실패하면 화면은 계속 잠긴 상태이고
  "다시 시도"만 사용할 수 있음.
*/
async function syncWorkLogAndWait(
  label,
  onSuccess,
  isRetry = false,
  syncKind = 'data'
){

  if (workLogSyncBusy){
    return false;
  }


  /*
    최초 호출에서만 성공 후 처리내용 기억
    → 실패 후 다시 시도해도 동일한 후처리가 실행됨
  */
  if (!isRetry){

    pendingWorkLogSyncTask = {
      label:
        label ||
        'GitHub 동기화 중…',

      onSuccess:
        typeof onSuccess === 'function'
          ? onSuccess
          : null,

      syncKind:
        syncKind === 'maintenance'
          ? 'maintenance'
          : 'data'
    };

  }


  workLogSyncBusy = true;


  showWorkLogSyncOverlay(
    label
  );


  const overlay =
    document.getElementById(
      'workLogSyncOverlay'
    );

  const spinner =
    document.getElementById(
      'workLogSyncSpinner'
    );

  const title =
    document.getElementById(
      'workLogSyncTitle'
    );

  const message =
    document.getElementById(
      'workLogSyncMessage'
    );

  const retryBtn =
    document.getElementById(
      'workLogSyncRetryBtn'
    );


  try{

    if (syncKind === 'maintenance'){
      await flushMaintenanceSyncNow();
    } else {
      await flushAutoSyncNow();
    }

    const completeTask =
      pendingWorkLogSyncTask;

    pendingWorkLogSyncTask =
      null;

    if (
      completeTask &&
      completeTask.onSuccess
    ){
      try{
        await completeTask.onSuccess();
      }
      catch(e){
        console.error(
          '작업 이력 저장 후 화면 갱신 오류:',
          e
        );
      }
    }

    overlay.classList.add(
      'is-success'
    );

    spinner.style.display =
      'none';

    title.textContent =
      '✓ 동기화 완료';

    message.textContent =
      'GitHub에 정상적으로 저장되었습니다.';

    retryBtn.style.display =
      'none';
    await sleepMs(500);
    if (syncCountdownTimer){
      clearInterval(syncCountdownTimer);
      syncCountdownTimer = null;
    }
    
    syncStartedAt = 0;
    overlay.classList.remove(
      'open',
      'is-success',
      'is-error'
    );


    return true;

  }
  catch(e){

    console.error(
      '작업 이력 GitHub 동기화 실패:',
      e
    );

    overlay.classList.add(
      'is-error'
    );

    spinner.style.display =
      'none';

    title.textContent =
      '⚠ 동기화 실패';

    message.textContent =
      '입력한 내용은 현재 화면에 유지됩니다. GitHub 저장이 완료될 때까지 다시 시도해 주세요.';

    if (syncCountdownTimer){
      clearInterval(syncCountdownTimer);
      syncCountdownTimer = null;
    }
    
    syncStartedAt = 0;
    
    retryBtn.style.display = '';
    retryBtn.disabled = false;
    retryBtn.textContent = '↻ 다시 저장';
    
    retryBtn.onclick = async () => {
      await forceManualResave();
    };

    return false;
  }
  finally{

    workLogSyncBusy = false;

  }
}

/* =========================================================
   GitHub 동시 저장 충돌 방지 - 3-way merge
   ========================================================= */
function syncEqual(a, b){
  return JSON.stringify(a ?? null) ===
         JSON.stringify(b ?? null);
}

function mergeObject3Way(base, local, remote){
  if (base && !local){
    return null;
  }
  if (
    base &&
    !remote &&
    syncEqual(local, base)
  ){
    return null;
  }
  if (!base && local && !remote){
    return cloneSyncState(local);
  }

  if (!base && !local && remote){
    return cloneSyncState(remote);
  }

  if (!local && !remote){
    return null;
  }

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

    if (syncEqual(l, b)){
      result[key] = cloneSyncState(r);
      return;
    }
    if (syncEqual(r, b)){
      result[key] = cloneSyncState(l);
      return;
    }
    if (syncEqual(l, r)){
      result[key] = cloneSyncState(l);
      return;
    }
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

function mergeSyncMutationLogs(...logs){
  const map = new Map();

  logs.flat().filter(Boolean).forEach(item => {
    const id = String(item.id || '');
    if (!id) return;

    const prev = map.get(id);
    if (!prev || Number(item.ts || 0) >= Number(prev.ts || 0)){
      map.set(id, cloneSyncState(item));
    }
  });

  return [...map.values()]
    .sort((a,b) => Number(a.ts || 0) - Number(b.ts || 0))
    .slice(-500);
}

function mergeSyncStates(
  base,
  local,
  remote
){
  base = base || {
    records:[],
    users:[],
    auditLogs:[],
    syncMutations:[]
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
    auditLogs:
      mergeStateArray(
        base.auditLogs || [],
        local.auditLogs || [],
        remote.auditLogs || [],
        a => a.id
      ),
    syncMutations:
      mergeSyncMutationLogs(
        base.syncMutations || [],
        local.syncMutations || [],
        remote.syncMutations || []
      )
  };
}

function mergeMaintenanceStates(
  base,
  local,
  remote
){
  base = base || {
    maintenanceLogs:[],
    syncMutations:[]
  };

  return {
    maintenanceLogs:
      mergeStateArray(
        base.maintenanceLogs || [],
        local.maintenanceLogs || [],
        remote.maintenanceLogs || [],
        m => m.id || `${m.group}|${m.ym}`
      ),
    syncMutations:
      mergeSyncMutationLogs(
        base.syncMutations || [],
        local.syncMutations || [],
        remote.syncMutations || []
      )
  };
}

async function runDataSyncCore(){
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
  const syncController = new AbortController();
  activeSyncAbortController = syncController;
  activeSyncKind = 'data';
  const syncVersion = dataChangeVersion;

  try{
    if (!dataDirty){
      return true;
    }

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
          githubToken,
          syncController.signal
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
            new Date().toLocaleString('ko-KR'),
            syncController.signal
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
      if (dataChangeVersion === syncVersion){
        /* 저장 도중 추가 변경이 없었다면 서버 병합 결과를 그대로 적용 */
        records = cloneSyncState(mergedState.records || []);
        users = cloneSyncState(mergedState.users || []);
        auditLogs = cloneSyncState(mergedState.auditLogs || []);
        dataSyncMutations = cloneSyncState(mergedState.syncMutations || []);
        dataDirty = false;
      }
      else {
        /*
          저장 중 사용자가 새 변경을 한 경우:
          방금 저장한 서버 결과로 현재 화면을 덮어쓰면 새 변경이 사라질 수 있다.
          저장 시작 시점(localState)을 BASE로 하여
          현재 화면(liveState) + 방금 저장한 서버 결과(mergedState)를 다시 병합한다.
        */
        const liveState = currentSyncState();
        const rebasedState = mergeSyncStates(
          localState,
          liveState,
          mergedState
        );

        records = cloneSyncState(rebasedState.records || []);
        users = cloneSyncState(rebasedState.users || []);
        auditLogs = cloneSyncState(rebasedState.auditLogs || []);
        dataSyncMutations = cloneSyncState(rebasedState.syncMutations || []);

        dataDirty = true;
        autoSyncQueued = true;
      }

      githubSha = savedSha;
      /* BASE는 실제 GitHub에 저장된 상태로 유지 */
      lastSyncedState = cloneSyncState(mergedState);
      refreshAuditSnapshot();
    }
    finally{
      suppressAuditCapture = false;
    }
    lastAutoSyncError = null;

    setSyncStatus(dataDirty ? 'pending' : 'synced');
  }
  catch(e){
    dataDirty = true;
    if (
      e?.name === 'AbortError' ||
      syncController.signal.aborted
    ){
      console.warn(
        '기존 data.json 동기화를 수동으로 중단했습니다.'
      );
    }
    else {
      lastAutoSyncError = e;
      console.error(
        '자동 동기화 실패:',
        e
      );
      setSyncStatus(
        'error',
        e.message
      );
    }
  }
  finally{
    if (
      activeSyncAbortController ===
      syncController
    ){
      activeSyncAbortController = null;
      activeSyncKind = null;
    }
    autoSyncInFlight = false;
    if (autoSyncQueued){
      runAutoSync();
    }
  }
}

function runAutoSync(){
  return enqueueBrowserSync(
    'data',
    () => runDataSyncCore()
  );
}

async function runMaintenanceSyncCore(){
  if (!githubConfig || !githubToken){
    return;
  }

  if (maintenanceSyncInFlight){
    maintenanceSyncQueued = true;
    return;
  }

  maintenanceSyncInFlight = true;
  maintenanceSyncQueued = false;
  setSyncStatus('syncing');
  const syncController = new AbortController();
  activeSyncAbortController = syncController;
  activeSyncKind = 'maintenance';
  const syncVersion = maintenanceChangeVersion;

  try{
    if (!maintenanceDirty){
      return true;
    }

    const localState = currentMaintenanceState();
    const maConfig = maintenanceGithubConfigOf(githubConfig);

    let mergedState = null;
    let savedSha = null;
    const MAX_RETRY = 5;

    for (let attempt = 1; attempt <= MAX_RETRY; attempt++){
      let remoteState;
      let remoteSha;

      try{
        const remote = await githubApiGet(maConfig, githubToken, syncController.signal);
        remoteState = remote.json || {maintenanceLogs:[]};
        remoteSha = remote.sha;
      }
      catch(e){
        if (e.notFound){
          remoteState = {maintenanceLogs:[]};
          remoteSha = null;
        } else {
          throw e;
        }
      }

      mergedState = mergeMaintenanceStates(
        lastSyncedMaintenanceState,
        localState,
        remoteState
      );

      try{
        savedSha = await githubApiPut(
          maConfig,
          githubToken,
          mergedState,
          remoteSha,
          '유지보수 점검 데이터 자동 병합 동기화 - ' +
            new Date().toLocaleString('ko-KR'),
            syncController.signal
        );
        break;
      }
      catch(e){
        if (
          (e.status === 409 || e.status === 422) &&
          attempt < MAX_RETRY
        ){
          console.warn(
            `ma.json 동시 저장 충돌 - 자동 재병합 ${attempt}/${MAX_RETRY}`
          );
          await sleepMs(250 * attempt);
          continue;
        }
        throw e;
      }
    }

    if (!savedSha || !mergedState){
      throw new Error('ma.json 동시 저장 충돌을 자동으로 해결하지 못했습니다.');
    }

    if (maintenanceChangeVersion === syncVersion){
      maintenanceLogs = cloneSyncState(
        mergedState.maintenanceLogs || []
      );
      maintenanceSyncMutations = cloneSyncState(
        mergedState.syncMutations || []
      );
      maintenanceDirty = false;
    }
    else {
      const liveState = currentMaintenanceState();
      const rebasedState = mergeMaintenanceStates(
        localState,
        liveState,
        mergedState
      );

      maintenanceLogs = cloneSyncState(
        rebasedState.maintenanceLogs || []
      );
      maintenanceSyncMutations = cloneSyncState(
        rebasedState.syncMutations || []
      );

      maintenanceDirty = true;
      maintenanceSyncQueued = true;
    }

    maintenanceGithubSha = savedSha;
    /* BASE는 실제 ma.json에 저장된 상태 */
    lastSyncedMaintenanceState = cloneSyncState(mergedState);

    lastMaintenanceSyncError = null;

    setSyncStatus(maintenanceDirty ? 'pending' : 'synced');
  }
  catch(e){
    maintenanceDirty = true;
    if (
      e?.name === 'AbortError' ||
      syncController.signal.aborted
    ){
      console.warn(
        '기존 ma.json 동기화를 수동으로 중단했습니다.'
      );
    }
    else {
      lastMaintenanceSyncError = e;
      console.error(
        '유지보수 점검 자동 동기화 실패:',
        e
      );
      setSyncStatus(
        'error',
        e.message
      );
    }
  }
  finally{
    if (
      activeSyncAbortController ===
      syncController
    ){
      activeSyncAbortController = null;
      activeSyncKind = null;
    }
    maintenanceSyncInFlight = false;
    if (maintenanceSyncQueued){
      runMaintenanceSync();
    }
  }
}

/* ma.json 저장 요청도 같은 브라우저 공용 Queue를 반드시 통과 */
function runMaintenanceSync(){
  return enqueueBrowserSync(
    'maintenance',
    () => runMaintenanceSyncCore()
  );
}

window.addEventListener('beforeunload', (e) => {
  const syncPending =
    dataDirty ||
    autoSyncInFlight ||
    autoSyncTimer !== null ||
    maintenanceDirty ||
    maintenanceSyncInFlight ||
    browserSyncQueuePending > 0;
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
      /* data.json: 법인/자산/사용자/감사기록 */
      const { json, sha } = await githubApiGet(cfg, token);
      ENC_STORE = json;
      records = (ENC_STORE.records || []).map(r => ({...r}));
      users = (ENC_STORE.users || []).map(u => ({...u}));
      auditLogs = (ENC_STORE.auditLogs || []).map(a => ({...a}));
      dataSyncMutations = (ENC_STORE.syncMutations || []).map(m => ({...m}));

      /* ma.json은 초기 화면 속도를 위해 유지보수 메뉴를 열 때 지연 로드 */
      legacyMaintenanceLogs =
        (ENC_STORE.maintenanceLogs || []).map(m => ({...m}));

      githubConfig = cfg;
      githubToken = token;
      githubSha = sha;
      lastSyncedState = currentSyncState();

      maintenanceLogs = [];
      maintenanceSyncMutations = [];
      maintenanceGithubSha = null;
      lastSyncedMaintenanceState = {maintenanceLogs:[], syncMutations:[]};
      maintenanceDataLoaded = false;

      return;
    }
    catch(e){
      console.warn(
        'GitHub 자동 불러오기 실패, 로컬 JSON으로 대체합니다:',
        e
      );
    }
  }

  /* 로컬 fallback: data.json + ma.json */
  const r = await fetch('data.json');
  if (!r.ok) throw new Error('HTTP ' + r.status);

  const json = await r.json();
  ENC_STORE = json;
  records = (ENC_STORE.records || []).map(r => ({...r}));
  users = (ENC_STORE.users || []).map(u => ({...u}));
  auditLogs = (ENC_STORE.auditLogs || []).map(a => ({...a}));
  dataSyncMutations = (ENC_STORE.syncMutations || []).map(m => ({...m}));

  /* 로컬 fallback에서도 ma.json은 유지보수 메뉴를 열 때 지연 로드 */
  legacyMaintenanceLogs =
    (ENC_STORE.maintenanceLogs || []).map(m => ({...m}));
  maintenanceLogs = [];
  maintenanceSyncMutations = [];
  maintenanceGithubSha = null;
  lastSyncedMaintenanceState = {maintenanceLogs:[], syncMutations:[]};
  maintenanceDataLoaded = false;

  lastSyncedState = currentSyncState();
})().catch(err => {
  console.error('데이터 로드 실패:', err);
});

let sessionKey = null;
let viewOnly = false;
let records = [];
let users = [];
let maintenanceLogs = [];
/* ma.json은 유지보수 메뉴 최초 진입 시에만 로드 */
var legacyMaintenanceLogs = [];
var maintenanceDataLoaded = false;
var maintenanceDataLoadPromise = null;
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

/* =========================================================
   SKU 표시 색상
   - SKU 문자열이 아니라 SKU_TAG_RULES에서 판별된 Tag 기준
   ========================================================= */

const SKU_TAG_STYLES = {

  ASG:{
    color:'#C76A00',
    background:'#FFF1D6',
    border:'#F2C778'
  },

  SG:{
    color:'#9A7600',
    background:'#FFF7C7',
    border:'#EAD56C'
  },

  MC:{
    color:'#16834A',
    background:'#E7F7EE',
    border:'#9CD6B7'
  },

  RP:{
    color:'#2563EB',
    background:'#EAF2FF',
    border:'#AFC8F7'
  },

  CA:{
    color:'#8B6BC9',
    background:'#F3EDFC',
    border:'#D8C8EF'
  },

  MA:{
    color:'#6D28D9',
    background:'#EEE5FC',
    border:'#C5A9ED'
  },

  ISG:{
    color:'#D73A49',
    background:'#FDEBED',
    border:'#F2B6BC'
  },

  ELK:{
    color:'#D9468B',
    background:'#FCEAF3',
    border:'#F3B8D4'
  },

  PAC:{
    color:'#8B5A2B',
    background:'#F5EBDD',
    border:'#D8BC98'
  },

  WSS:{
    color:'#1688C4',
    background:'#E7F6FD',
    border:'#A8D9F0'
  },

  /*
    어두운 진회색 배경 + 에메랄드
  */
  WPS:{
    color:'#34D399',
    background:'#3F474F',
    border:'#59636E'
  },

  /*
    어두운 진회색 배경 + 파랑
  */
  BCWF:{
    color:'#60A5FA',
    background:'#3F474F',
    border:'#59636E'
  },
  
  BCIS:{
    color:'#60A5FA',
    background:'#3F474F',
    border:'#59636E'
  }
};


/*
  하나의 SKU가 여러 Tag에 동시에 매칭될 경우
  아래 순서의 Tag 색상을 우선 적용
*/
const SKU_COLOR_TAG_PRIORITY = [
  'ASG',
  'SG',
  'MC',
  'RP',
  'CA',
  'MA',
  'ISG',
  'ELK',
  'PAC',
  'WSS',
  'WPS',
  'BCWF',
  'BCIS'
];


function skuTagStyle(sku){

  if (!sku){
    return null;
  }

  const tags =
    skuKeywordMatches(sku);

  const tag =
    SKU_COLOR_TAG_PRIORITY.find(
      key => tags.includes(key)
    );

  if (!tag){
    return null;
  }

  return {
    tag,
    ...SKU_TAG_STYLES[tag]
  };
}

function skuBadge(sku){
  const label =
    esc(sku) || '—';
  if (!sku){
    return label;
  }
  const tags = skuKeywordMatches(sku);
  const style = skuTagStyle(sku);
  const borderStyle = tags.includes('VA')
      ? 'dashed'
      : 'solid';

  if (!style){
    return `
      <span
        class="sku-tag"
        style="border-style:${borderStyle};"
      >
        ${label}
      </span>
    `;
  }

  return `
    <span
      class="sku-tag"
      data-sku-color-tag="${esc(style.tag)}"
      style="
        color:${style.color};
        background:${style.background};
        border-color:${style.border};
        border-style:${borderStyle};
      "
    >
      <span
        class="sku-dot"
        style="background:${style.color}"
      ></span>

      ${label}
    </span>
  `;
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
      return s.startsWith('CAS-') || s.startsWith('CA-') || s.startsWith('ISG-CA');
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

function normalizeCustMailRecipientType(value){
  const type = String(value || '').toLowerCase();
  if (type === 'cc' || type === 'exclude') return type;
  return 'to';
}

function normalizeCustContact(contact){
  return {
    ...(contact || {}),
    mail_recipient_type: normalizeCustMailRecipientType(
      contact?.mail_recipient_type
    )
  };
}

function getGroupCustContacts(items){
  const withArr = items.find(i => Array.isArray(i.cust_contacts) && i.cust_contacts.length);
  if (withArr){
    return withArr.cust_contacts
      .slice(0,5)
      .map(normalizeCustContact);
  }

  const legacy = items
    .map(i => ({
      name:i.cust_contact||'',
      phone:i.cust_phone||'',
      email:i.cust_email||'',
      mail_recipient_type:'to'
    }))
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

/*
  SSP-S 부모 바로 아래에 연결된 ISG- 자산들을 배치
*/
function sortAssetsWithHierarchy(items){

  const sorted =
    sortAssetsByOrder(items);

  const byId =
    new Map(
      sorted.map(r => [
        String(r.id),
        r
      ])
    );


  const childrenByParent =
    new Map();

  const childIds =
    new Set();

  const parentIds =
    new Set();


  sorted.forEach(rec => {

    if (!isIsgChildAsset(rec)){
      return;
    }


    const parentId =
      String(
        rec.asset_parent_id || ''
      ).trim();


    if (!parentId){
      return;
    }


    const parent =
      byId.get(parentId);


    /*
      부모가 없어졌거나
      SSP-S가 아니라면 하위 자산으로 취급하지 않음
    */
    if (
      !parent ||
      !isSspParentAsset(parent)
    ){
      return;
    }


    childIds.add(
      String(rec.id)
    );

    parentIds.add(
      String(parent.id)
    );


    if (
      !childrenByParent.has(parentId)
    ){
      childrenByParent.set(
        parentId,
        []
      );
    }


    childrenByParent
      .get(parentId)
      .push(rec);

  });


  const result = [];


  sorted.forEach(rec => {

    const id =
      String(rec.id);


    /*
      자식은 여기서 출력하지 않고
      부모를 만났을 때 바로 아래에 출력
    */
    if (childIds.has(id)){
      return;
    }


    result.push(rec);


    const children =
      childrenByParent.get(id);


    if (children?.length){

      children
        .slice()
        .sort(
          (a, b) =>
            assetOrderValue(a) -
            assetOrderValue(b)
        )
        .forEach(child => {
          result.push(child);
        });

    }

  });


  return {
    items:result,
    childIds,
    parentIds
  };
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
    const hierarchy =
      sortAssetsWithHierarchy(its);
    
    return {
      sid,
    
      items:
        hierarchy.items,
    
      childIds:
        hierarchy.childIds,
    
      parentIds:
        hierarchy.parentIds,
    
      meta:
        subGroupMeta(
          hierarchy.items
        )
    };
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
  const worst = aggregateLicenseStatus(
    collectSubtreeLicenseStatuses(gid, groupsMap, new Set())
  );

  /*
    닫힌 법인은 자산 table/rowHtml을 만들지 않는다.
    제목 표시용 Support ID 정보만 가볍게 계산하고,
    실제 subgroup/자산 행은 펼쳤을 때만 생성한다.
  */
  const sidList = ownSupportIds(items);
  const collapseSubHead = sidList.length <= 1;
  const editableSid = collapseSubHead ? (sidList[0] ?? '') : null;
  let soloSubMeta = null;

  if (collapseSubHead){
    const sid = editableSid || '';
    const sidItems = realItems.filter(r => (r.support_id || '').trim() === sid);
    const source = sidItems.length ? sidItems : realItems;
    if (source.length) soloSubMeta = subGroupMeta(source);
  }

  const isParentGroup = groupChildrenOf(gid).length > 0;
  const isParentDisplay = isParentGroup || meta.is_parent;
  const displayItemCount = isParentDisplay ? groupTotalItemCount(gid) : realItems.length;
  const displayConfigMode = isParentDisplay
    ? groupDescendantConfigModes(gid)
    : meta.config_mode;

  let subgroupsHtml = '';
  let childrenHtml = '';

  if (isOpen){
    const subGroups = buildSubGroups(realItems);
    const soloSubGroup = subGroups.length <= 1 ? (subGroups[0] || null) : null;

    subgroupsHtml = subGroups.map(sg => `
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
                ${sg.items.map(r =>
                  rowHtml(
                    r,
                    sg.sid,
                    sg.childIds?.has(String(r.id)),
                    sg.parentIds?.has(String(r.id))
                  )
                ).join('')}
              </tbody>
            </table>
          </div>`).join('');

    const childGids = groupChildrenOf(gid).filter(cg => groupsMap.has(cg));
    childrenHtml = childGids
      .map(cg => groupCardHtml(cg, groupsMap.get(cg), groupsMap, depth + 1, visited))
      .join('');
  }

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
                ${soloSubMeta ? buildEngineerInlineHtml(soloSubMeta) : ''}
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
          ${isOpen ? subgroupsHtml : ''}
          ${isOpen && childrenHtml ? `<div class="child-groups">${childrenHtml}</div>` : ''}
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

    const mailRecipientType = normalizeCustMailRecipientType(
      c.mail_recipient_type
    );
    const mailRecipientLabel = mailRecipientType === 'cc'
      ? 'CC'
      : mailRecipientType === 'exclude'
        ? '미포함'
        : '수신자';
    const mailRecipientTag = `<span class="cust-mail-recipient-tag cust-mail-recipient-${mailRecipientType}">${mailRecipientLabel}</span>`;

    const rows = [];
    if (c.org) rows.push(`<span class="ccm-field"><b>소속</b> ${esc(c.org)}</span>`);
    if (c.phone) rows.push(`<span class="ccm-field"><b>연락처</b> ${esc(c.phone)}</span>`);
    if (c.email) rows.push(`<span class="ccm-field"><b>이메일</b> ${esc(c.email)}</span>`);
    return `<div class="ccm-card">
      <div class="ccm-head">${roleTag}${mailRecipientTag}<span class="ccm-name">${esc(c.name||'(이름 미입력)')}</span></div>
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
    : [{role:'',name:'',org:'',phone:'',email:'',mail_recipient_type:'to'}]
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
        <select class="cc-mail-recipient-type" title="점검 메일 포함 방식">
          <option value="to" ${normalizeCustMailRecipientType(c.mail_recipient_type)==='to'?'selected':''}>수신자</option>
          <option value="cc" ${normalizeCustMailRecipientType(c.mail_recipient_type)==='cc'?'selected':''}>CC</option>
          <option value="exclude" ${normalizeCustMailRecipientType(c.mail_recipient_type)==='exclude'?'selected':''}>미포함</option>
        </select>
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
    mail_recipient_type: normalizeCustMailRecipientType(
      row.querySelector('.cc-mail-recipient-type')?.value
    ),
  }));
}

function updateCceCustAddBtnState(){
  const btn = document.getElementById('cce_cust_add_btn');
  btn.style.display = cceCustContacts.length >= 5 ? 'none' : '';
}

document.getElementById('cce_cust_add_btn').onclick = () => {
  captureCceCustContactsFromDom();
  if (cceCustContacts.length >= 5) return;
  cceCustContacts.push({role:'', name:'', org:'', phone:'', email:'', mail_recipient_type:'to'});
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
function isSspParentAsset(rec){
  return String(rec?.sku || '')
    .trim()
    .toUpperCase()
    .startsWith('SSP-S');
}

function isIsgChildAsset(rec){
  return String(rec?.sku || '')
    .trim()
    .toUpperCase()
    .startsWith('ISG-');
}

/*
  ISG- 자산을 SSP-S 자산 아래에 넣을 수 있는지 확인
*/
function canNestAsset(source, target){
  return !!(
    source &&
    target &&
    source !== target &&
    isIsgChildAsset(source) &&
    isSspParentAsset(target) &&
    sameAssetOrderScope(source, target)
  );
}

/*
  ISG 자산 → SSP-S 자산 하위 연결
*/
function nestAssetUnderParent(source, target){

  if (!canNestAsset(source, target)){
    return false;
  }

  source.asset_parent_id =
    String(target.id);

  /*
    현재 프로그램에 mutation_id 처리 기능을
    이미 넣어둔 경우 여기에서도 변경 ID 갱신
  */
  if (typeof makeMutationId === 'function'){
    source.last_mutation_id =
      createMutationId('asset-parent')
  }

  return true;
}

/*
  일반 위치로 다시 드래그하면
  부모 연결을 해제할 때 사용
*/
function detachAssetFromParent(rec){
  if (!rec) return;

  delete rec.asset_parent_id;

  if (typeof makeMutationId === 'function'){
    rec.last_mutation_id =
      createMutationId('asset-detach')
  }
}

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
  document.querySelectorAll(
    'tr.asset-dragging, ' +
    'tr.asset-drop-before, ' +
    'tr.asset-drop-after, ' +
    'tr.asset-drop-parent'
  ).forEach(row => {
    row.classList.remove(
      'asset-dragging',
      'asset-drop-before',
      'asset-drop-after',
      'asset-drop-parent'
    );
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
      const source =
        records.find(
          r =>
            String(r.id) ===
            draggingAssetId
        );
      
      const target =
        records.find(
          r =>
            String(r.id) ===
            targetId
        );
      
      
      if (
        !sameAssetOrderScope(
          source,
          target
        )
      ){
        return;
      }
      
      
      e.preventDefault();
      
      
      if (e.dataTransfer){
        e.dataTransfer.dropEffect =
          'move';
      }
      
      
      /*
        기존 표시 전부 제거
      */
      document
        .querySelectorAll(
          'tr.asset-drop-before, ' +
          'tr.asset-drop-after, ' +
          'tr.asset-drop-parent'
        )
        .forEach(el => {
      
          if (el !== row){
            el.classList.remove(
              'asset-drop-before',
              'asset-drop-after',
              'asset-drop-parent'
            );
          }
      
        });
      
      
      /*
        ISG- → SSP-S 드래그라면
        순서 이동이 아니라 하위 자산 연결
      */
      if (
        canNestAsset(
          source,
          target
        )
      ){
      
        row.classList.remove(
          'asset-drop-before',
          'asset-drop-after'
        );
      
        row.classList.add(
          'asset-drop-parent'
        );
      
        return;
      }
      
      
      /*
        기존 일반 순서 이동
      */
      row.classList.remove(
        'asset-drop-parent'
      );
      
      
      const rect =
        row.getBoundingClientRect();
      
      
      const insertAfter =
        e.clientY >
        rect.top +
        rect.height / 2;
      
      
      row.classList.toggle(
        'asset-drop-before',
        !insertAfter
      );
      
      row.classList.toggle(
        'asset-drop-after',
        insertAfter
      );
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
      /*
        ISG-를 SSP-S 위에 드롭
        → 하위 자산으로 연결
      */
      if (
        canNestAsset(
          source,
          target
        )
      ){
      
        e.preventDefault();
      
      
        nestAssetUnderParent(
          source,
          target
        );
      
      
        draggingAssetId =
          null;
      
      
        clearAssetDragVisuals();
      
      
        render();
      
        scheduleAutoSync();
      
        return;
      }
      
      
      /*
        기존에 하위 자산이었던 ISG를
        일반 자산 위치로 드래그하면
        부모 관계 해제
      */
      if (
        source.asset_parent_id &&
        !isSspParentAsset(target)
      ){
      
        detachAssetFromParent(
          source
        );
      
      }
      
      
      const insertAfter =
        row.classList.contains(
          'asset-drop-after'
        );
      
      
      const sourceId =
        draggingAssetId;
      
      
      draggingAssetId =
        null;
      
      
      clearAssetDragVisuals();
      
      
      reorderAssetRows(
        sourceId,
        targetId,
        insertAfter
      );
    });
  });
}

function assetSkuDisplayHtml(
  r,
  isAssetChild = false,
  hasAssetChildren = false
){

  if (
    isAssetChild &&
    isIsgChildAsset(r)
  ){
    return `
      <div class="asset-app-display-simple">
        <span class="asset-child-arrow" aria-hidden="true"></span>
  
        <div class="asset-app-main">
          ${skuBadge(r.sku)}
          ${skuKeywordTagsHtml(r.sku)}
        </div>
      </div>
    `;
  }

  if (
    hasAssetChildren &&
    isSspParentAsset(r)
  ){
    return `
      <div class="asset-host-display-simple">
        ${skuBadge(r.sku)}
        ${skuKeywordTagsHtml(r.sku)}
      </div>
    `;
  }

  return `
    ${skuBadge(r.sku)}
    ${skuKeywordTagsHtml(r.sku)}
  `;
}

function rowHtml(
    r,
    groupSupportId,
    isAssetChild = false,
    hasAssetChildren = false
  ){
  
    const status =
      licenseStatus(r);
  
    const pct =
      licenseBarPct(r);
  
    const logCount =
      (r.work_log || []).length;
  
  
    return `
    <tr
      data-id="${r.id}"
      class="${
        isAssetChild
          ? 'asset-child-row'
          : ''
      } ${
        hasAssetChildren
          ? 'asset-parent-row'
          : ''
      }"
      ${
        isAssetChild
          ? `data-asset-parent="${esc(r.asset_parent_id)}"`
          : ''
      }
    >
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
    <td class="sku col-sku ${isAssetChild? 'col-sku-app': (
              hasAssetChildren
                ? 'col-sku-host'
                : ''
            )
      }"
      data-label="SKU / 제품"
    >
      ${assetSkuDisplayHtml(
        r,
        isAssetChild,
        hasAssetChildren
      )}
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
  
  kwBox.innerHTML = SKU_TAG_KEYS.map(k => {
        const cnt = records.filter(
            r =>
              !r.is_group_shell &&
              skuKeywordMatches(r.sku).includes(k)
          ).length;
  
        return {
          key: k,
          count: cnt
        };
  
      })
      .filter(item =>
        item.count > 0
      )
  
      .map(item => `
        <div
          class="filter-item ${
            activeSkuKeywordFilters.has(item.key)
              ? 'active'
              : ''
          }"
          data-skukw="${esc(item.key)}"
        >
          <span>${esc(item.key)}</span>
          <span class="cnt">${item.count}</span>
        </div>
      `)
  
      .join('');
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

  let count = 0;
  const groups = groupRecords(records);

  for (const items of groups.values()){
    if (!items.length) continue;

    const meta = groupMeta(items);
    const hasRealAsset = items.some(r => !r.is_group_shell);
    const isTopLevel = !meta.group_parent && (meta.is_parent || hasRealAsset);

    if (isTopLevel && meta.owner_primary === me){
      count++;
    }
  }

  return count;
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

let assetSearchDebounceTimer = null;
document.getElementById('searchInput').addEventListener('input', () => {
  clearTimeout(assetSearchDebounceTimer);
  assetSearchDebounceTimer = setTimeout(render, 180);
});

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
  if (groupChildrenOf(gid).length || groupMeta(records.filter(r=>r.group===gid)).is_parent){ alert('상위 법인은 대표 이름 역할만 하므로 자산을 직접 추가할 수 없습니다. 해당 자산이 속할 하위 법인(Support ID)에 추가해 주세요.'); return; }
  const items = records.filter(r=>r.group===gid);
  if (!items.length) return;
  const meta = groupMeta(items);

  editingRecordId = null;
  addAssetTargetGid = gid;
  clearAssetForm();
  document.getElementById('f_support').disabled = true;
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
  document.getElementById('f_support').disabled = false;
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
      support_id: val('f_support'),
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
        <select class="cc-mail-recipient-type" title="점검 메일 포함 방식">
          <option value="to" ${normalizeCustMailRecipientType(c.mail_recipient_type)==='to'?'selected':''}>수신자</option>
          <option value="cc" ${normalizeCustMailRecipientType(c.mail_recipient_type)==='cc'?'selected':''}>CC</option>
          <option value="exclude" ${normalizeCustMailRecipientType(c.mail_recipient_type)==='exclude'?'selected':''}>미포함</option>
        </select>
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
    mail_recipient_type: normalizeCustMailRecipientType(
      row.querySelector('.cc-mail-recipient-type')?.value
    ),
  }));
}

function updateCustAddBtnState(){
  const btn = document.getElementById('ge_cust_add_btn');
  btn.style.display = geCustContacts.length >= 5 ? 'none' : '';
}

document.getElementById('ge_cust_add_btn').onclick = () => {
  captureCustContactsFromDom();
  if (geCustContacts.length >= 5) return;
  geCustContacts.push({role:'', name:'', org:'', phone:'', email:'', mail_recipient_type:'to'});
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
    ? meta.cust_contacts.slice(0,5).map(normalizeCustContact)
    : [{role:'',name:'',org:'',phone:'',email:'',mail_recipient_type:'to'}]
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
        <select class="cc-mail-recipient-type" title="점검 메일 포함 방식">
          <option value="to" ${normalizeCustMailRecipientType(c.mail_recipient_type)==='to'?'selected':''}>수신자</option>
          <option value="cc" ${normalizeCustMailRecipientType(c.mail_recipient_type)==='cc'?'selected':''}>CC</option>
          <option value="exclude" ${normalizeCustMailRecipientType(c.mail_recipient_type)==='exclude'?'selected':''}>미포함</option>
        </select>
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
    mail_recipient_type: normalizeCustMailRecipientType(
      row.querySelector('.cc-mail-recipient-type')?.value
    ),
  }));
}

function updateNgCustAddBtnState(){
  const btn = document.getElementById('ng_cust_add_btn');
  btn.style.display = ngCustContacts.length >= 5 ? 'none' : '';
}

document.getElementById('ng_cust_add_btn').onclick = () => {
  captureNgCustContactsFromDom();
  if (ngCustContacts.length >= 5) return;
  ngCustContacts.push({role:'', name:'', org:'', phone:'', email:'', mail_recipient_type:'to'});
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
  ngCustContacts = [{role:'',name:'',org:'',phone:'',email:'',mail_recipient_type:'to'}];
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
    users: auditClone(users || [])
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
function workHistoryDateTime(ts, fallbackDate){
  const n = Number(ts);
  if (Number.isFinite(n) && n > 1000000000000){
    return auditDateText(n);
  }
  return fallbackDate || '날짜 미기재';
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
  const ignore = new Set([
    ...ignoreFields,
    'last_mutation_id',
    'mutation_id'
  ]);
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

function addAuditLog({action, targetType, targetId='', group='', owner='', label='', sn='', summary='', changes=[], actorName='', actorRole='', actorId='', mutationId=''}){
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
    actor_role:actor.role,
    mutation_id: mutationId || createMutationId('audit')
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

function captureAuditFromStateDiff(mutationId = createMutationId('data')){
  if (suppressAuditCapture){ refreshAuditSnapshot(); return; }
  if (!auditSnapshot){ refreshAuditSnapshot(); return; }

  const before = auditSnapshot;
  const after = auditSnapshotState();
  const seen = new Set();
  const pushUnique = (sig, log) => {
    if (seen.has(sig)) return;
    seen.add(sig);
    addAuditLog({...log, mutationId});
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

  const oldUsers = new Map((before.users || []).map(u => [String(u.id),u]));
  const newUsers = new Map((after.users || []).map(u => [String(u.id),u]));
  const userIds = new Set([...oldUsers.keys(),...newUsers.keys()]);
  userIds.forEach(id => {
    const a=oldUsers.get(id), b=newUsers.get(id);
    if (!a && b){
      addAuditLog({action:'add',targetType:'사용자 계정',targetId:id,label:b.name,summary:`사용자 계정 추가 · ${b.name}${b.isAdmin?' · 마스터':''}`,mutationId});
    } else if (a && !b){
      addAuditLog({action:'delete',targetType:'사용자 계정',targetId:id,label:a.name,summary:`사용자 계정 삭제 · ${a.name}`,actorName:a.name,actorRole:a.isAdmin?'마스터':'일반사용자',actorId:a.id,mutationId});
    } else if (a && b){
      const changes=auditFieldChanges(a,b,['id','maintenance_mail_subject','maintenance_mail_body','maintenance_mail_subject_ko','maintenance_mail_body_ko','maintenance_mail_subject_en','maintenance_mail_body_en']);
      if (changes.length){
        const pwChanged=changes.some(c=>['pwHash','pwSalt','pwIterations'].includes(c.field));
        const visible=changes.filter(c=>!['pwSalt','pwIterations'].includes(c.field));
        addAuditLog({action:'edit',targetType:'사용자 계정',targetId:id,label:b.name,summary:pwChanged?`사용자 비밀번호 변경 · ${b.name}`:`사용자 계정 ${visible.length}개 항목 수정 · ${b.name}`,changes:visible,actorName:b.name,actorRole:b.isAdmin?'마스터':'일반사용자',actorId:b.id,mutationId});
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


// ---------- recent activity (최근 업데이트 알림) ----------
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

function dismissAllActivity(){
  const set =
    getDismissedActivity();
  records.forEach(rec => {
    (rec.work_log || []).forEach(entry => {
      set.add(
        activityKeyOf(
          rec.id,
          entry.id
        )
      );
    });
  });
  try{
    localStorage.setItem(
      dismissedActivityKey(),
      JSON.stringify([...set])
    );
  }
  catch(e){
    console.warn(
      '알림 삭제 상태 저장 실패:',
      e
    );
  }
  updateActivityBadge();
  renderRecentActivity();
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
    wrap.innerHTML =
      `<div class="ra-empty">새로운 알림이 없습니다.</div>`;
    const clearBtn =
      document.getElementById('raClearAllBtn');
    if (clearBtn){
      clearBtn.disabled = true;
    }
    return;
  }
  const clearBtn =
    document.getElementById('raClearAllBtn');
  if (clearBtn){
    clearBtn.disabled = false;
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
document.getElementById('raClearAllBtn')?.addEventListener('click', e => {
    e.preventDefault();
    e.stopPropagation();
    const count =
      getRecentWorkLogEntries(
        Number.MAX_SAFE_INTEGER
      ).length;

    if (!count){
      return;
    }
    if (!confirm(
      `현재 알림 ${count}건을 모두 삭제하시겠습니까?\n\n` +
      `작업 이력 자체는 삭제되지 않고 알림창에서만 사라집니다.`
    )){
      return;
    }
    dismissAllActivity();
  });

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
  const normalParts = [];
  const sensitiveLabels = [];
  changes.forEach(c => {
    const cleanLabel = String(c.label || '')
      .replace(/\s*\([^)]*\)\s*/g, '')
      .trim();

    if (c.sensitive){
      if (
        cleanLabel &&
        !sensitiveLabels.includes(cleanLabel)
      ){
        sensitiveLabels.push(cleanLabel);
      }
      return;
    }

    normalParts.push(
      `${cleanLabel}: ${c.from} → ${c.to}`
    );
  });

  if (sensitiveLabels.length){
    normalParts.push(
      `${sensitiveLabels.join(' · ')} 변경됨`
    );
  }
  return normalParts.join(' · ');
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
        ${entry.change_summary ? `
            <div class="wl-changes">
              <div class="wl-changes-title">
                🔧 자산 정보 반영
              </div>
          
              ${entry.change_summary
                .split(' · ')
                .filter(Boolean)
                .map(item => `
                  <div class="wl-change-line">
                    ${esc(item)}
                  </div>
                `)
                .join('')
              }
            </div>
          ` : ''}
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

      const synced =
        await syncWorkLogAndWait(
          '작업 이력 삭제 내용 동기화 중…',
          () => {
            renderWorkLogList();
            render();
          }
        );
      if (
        synced &&
        result.skipped > 0
      ){
        alert(
          `작업 이력이 삭제되었습니다.\n\n` +
          `${result.reverted}개 항목은 변경 전 값으로 원복되었습니다.\n` +
          `${result.skipped}개 항목은 이후 다른 변경이 있어 현재 값을 유지했습니다.`
        );
      }
    };
  });
}

document.getElementById('wlAddBtn').onclick = async () => {
  const wasEditingWorkLog =
    !!workLogEditId;
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

    const synced =
      await syncWorkLogAndWait(
        `선택한 ${targetRecs.length}개 자산 작업 이력 동기화 중…`,
        () => {
          document
            .getElementById(
              'workLogModal'
            )
            .classList
            .remove('open');
    
          workLogRecordIds = [];
          wlMultiChangeState = {};
          selectedAssetIds.clear();
          render();
        }
      );
    if (
      synced &&
      applyChanges &&
      totalChangedFields
    ){
      alert(
        `작업 이력이 ${targetRecs.length}개 자산에 등록되었습니다.\n\n` +
        `자산 정보 변경: ${totalChangedAssets}개 자산 · ${totalChangedFields}개 항목`
      );
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

  await syncWorkLogAndWait(
    wasEditingWorkLog
      ? '수정된 작업 이력 동기화 중…'
      : '새 작업 이력 동기화 중…',
    () => {
      document
        .getElementById('wl_date')
        .value =
          todayDots();
      document
        .getElementById('wl_manager')
        .value =
          currentUserName() || '';
      document
        .getElementById('wl_note')
        .value =
          '';
      resetFieldChangeInputs();
      renderWorkLogList();
      render();
    }
  );
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


// =========================================================
// ESC 키로 현재 열려 있는 최상단 모달 닫기
// =========================================================
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const syncOverlay =
    document.getElementById('workLogSyncOverlay');
  if (
    syncOverlay &&
    syncOverlay.classList.contains('open')
  ){
    return;
  }

  const openModals =
    Array.from(
      document.querySelectorAll(
        [
          '#addModal.open',
          '#workLogModal.open',
          '#groupEditModal.open',
          '#addGroupModal.open',
          '#subGroupEditModal.open',
          '#custContactsModal.open',
          '#moveAssetModal.open',
          '#maintenanceLogModal.open',
          '#maintenanceMailSettingsModal.open'
        ].join(',')
      )
    );

  if (!openModals.length){
    return;
  }

  const topModal =
    openModals
      .slice()
      .sort((a, b) => {
        const za =
          Number(
            getComputedStyle(a).zIndex
          ) || 0;
        const zb =
          Number(
            getComputedStyle(b).zIndex
          ) || 0;
        if (za !== zb){
          return za - zb;
        }

        return (
          Array.from(
            document.body.querySelectorAll('*')
          ).indexOf(a) -
          Array.from(
            document.body.querySelectorAll('*')
          ).indexOf(b)
        );
      })
      .pop();

  if (!topModal){
    return;
  }

  e.preventDefault();
  e.stopPropagation();

  const closeButtonMap = {
    addModal:
      'cancelAddBtn',
    workLogModal:
      'wlCloseBtn',
    groupEditModal:
      'cancelGeBtn',
    addGroupModal:
      'cancelNgBtn',
    subGroupEditModal:
      'cancelSgBtn',
    custContactsModal:
      'custContactsModalCloseBtn',
    moveAssetModal:
      'cancelMaBtn',
    maintenanceLogModal:
      'cancelMlBtn',
    maintenanceMailSettingsModal:
      'cancelMmsBtn'
  };
  const closeBtnId =
    closeButtonMap[topModal.id];
  const closeBtn =
    closeBtnId
      ? document.getElementById(closeBtnId)
      : null;
  if (closeBtn){
    closeBtn.click();
  }
  else {
    topModal.classList.remove('open');
  }
});
