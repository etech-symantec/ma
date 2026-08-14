/*
 * UI core + feature loader
 * 대시보드/유지보수/전체이력은 최초 접속 때 실행하지 않고 사용자가 눌렀을 때 불러옵니다.
 */
var currentViewMode = 'list';
var dashboardMode = false;
var maintenanceMode = false;

const MA_FILE_VERSIONS = Object.freeze({
  dashboardCss:'20260814-fast01', dashboardJs:'20260814-fast01',
  maintenanceCss:'20260814-fast01', mailJs:'20260814-fast01', maintenanceJs:'20260814-fast01',
  historyCss:'20260814-fast01', historyJs:'20260814-fast01'
});

const maLoadedScripts = new Map();
const maLoadedStyles = new Map();

function loadStyleOnce(href, key){
  if (maLoadedStyles.has(key)) return maLoadedStyles.get(key);
  const existing = document.querySelector(`link[data-ma-feature-css="${key}"]`);
  if (existing){
    const p = Promise.resolve(existing);
    maLoadedStyles.set(key,p);
    return p;
  }
  const p = new Promise((resolve,reject) => {
    const link=document.createElement('link');
    link.rel='stylesheet'; link.href=href; link.dataset.maFeatureCss=key;
    link.onload=()=>resolve(link);
    link.onerror=()=>reject(new Error(`CSS 로드 실패: ${href}`));
    document.head.appendChild(link);
  });
  maLoadedStyles.set(key,p);
  return p;
}

function loadScriptOnce(src, key){
  if (maLoadedScripts.has(key)) return maLoadedScripts.get(key);
  const p = new Promise((resolve,reject) => {
    const script=document.createElement('script');
    script.src=src; script.defer=true; script.dataset.maFeatureJs=key;
    script.onload=()=>resolve(script);
    script.onerror=()=>reject(new Error(`JS 로드 실패: ${src}`));
    document.head.appendChild(script);
  });
  maLoadedScripts.set(key,p);
  return p;
}

async function ensureFeatureLoaded(mode){
  if (mode === 'dashboard'){
    const css=loadStyleOnce(`css/dashboard.css?v=${MA_FILE_VERSIONS.dashboardCss}`,'dashboard');
    const js=loadScriptOnce(`js/dashboard.js?v=${MA_FILE_VERSIONS.dashboardJs}`,'dashboard');
    await Promise.all([css,js]);
    return;
  }

  if (mode === 'maintenance'){
    const css=loadStyleOnce(`css/maintenance.css?v=${MA_FILE_VERSIONS.maintenanceCss}`,'maintenance');
    await Promise.all([
      css,
      loadScriptOnce(`js/mail.js?v=${MA_FILE_VERSIONS.mailJs}`,'mail')
    ]);
    await loadScriptOnce(`js/maintenance.js?v=${MA_FILE_VERSIONS.maintenanceJs}`,'maintenance');
    await ensureMaintenanceDataLoaded();
    return;
  }

  if (mode === 'history'){
    const css=loadStyleOnce(`css/history.css?v=${MA_FILE_VERSIONS.historyCss}`,'history');
    const js=loadScriptOnce(`js/history.js?v=${MA_FILE_VERSIONS.historyJs}`,'history');
    await Promise.all([css,js]);
  }
}

function applyViewVisibility(mode){
  const contentEl=document.getElementById('content');
  const dashEl=document.getElementById('dashboardView');
  const maintEl=document.getElementById('maintenanceView');
  const histEl=document.getElementById('workHistoryView');
  const dashBtn=document.getElementById('dashboardToggle');
  const maintBtn=document.getElementById('maintenanceToggle');
  const histBtn=document.getElementById('workHistoryToggle');

  if (contentEl) contentEl.style.display=(mode==='list')?'':'none';
  if (dashEl) dashEl.style.display=(mode==='dashboard')?'':'none';
  if (maintEl) maintEl.style.display=(mode==='maintenance')?'':'none';
  if (histEl) histEl.style.display=(mode==='history')?'':'none';

  if (dashBtn){
    dashBtn.classList.toggle('on',mode==='dashboard');
    dashBtn.title=mode==='dashboard'?'대시보드 닫기 (다시 클릭)':'대시보드 보기';
  }
  if (maintBtn){
    maintBtn.classList.toggle('on',mode==='maintenance');
    maintBtn.title=mode==='maintenance'?'유지보수 점검 관리 닫기 (다시 클릭)':'유지보수 점검 관리';
  }
  if (histBtn){
    histBtn.classList.toggle('on',mode==='history');
    histBtn.title=mode==='history'?'업데이트 전체보기 닫기 (다시 클릭)':'업데이트 전체보기';
  }
}

async function setViewMode(mode){
  currentViewMode=mode;
  dashboardMode=(mode==='dashboard');
  maintenanceMode=(mode==='maintenance');
  applyViewVisibility(mode);

  if (mode === 'list') return;

  const targetId = mode==='dashboard' ? 'dashboardView' : mode==='maintenance' ? 'maintenanceView' : 'workHistoryView';
  const target=document.getElementById(targetId);
  if (target && !target.innerHTML.trim()){
    target.innerHTML='<div class="feature-loading">필요한 화면을 불러오는 중…</div>';
  }

  try{
    await ensureFeatureLoaded(mode);
    if (mode==='dashboard') renderDashboard();
    else if (mode==='maintenance') renderMaintenance();
    else if (mode==='history') renderWorkHistoryPage();
  }
  catch(e){
    console.error(`${mode} 기능 지연 로드 실패:`,e);
    if (target) target.innerHTML=`<div class="empty-state"><h3>화면을 불러오지 못했습니다</h3><p>${String(e.message||e)}</p></div>`;
  }
}

function setDashboardMode(on){ setViewMode(on ? 'dashboard' : 'list'); }

document.getElementById('dashboardToggle').onclick=()=>setViewMode(dashboardMode?'list':'dashboard');
document.getElementById('maintenanceToggle').onclick=()=>setViewMode(maintenanceMode?'list':'maintenance');
document.getElementById('workHistoryToggle').onclick=()=>setViewMode(currentViewMode==='history'?'list':'history');
