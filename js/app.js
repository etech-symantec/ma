/* App bootstrap: optional idle prefetch. data/ma.json is intentionally NOT prefetched. */
function maPrefetch(url, asType){
  if (document.querySelector(`link[data-ma-prefetch="${url}"]`)) return;
  const link=document.createElement('link');
  link.rel='prefetch'; link.href=url; link.dataset.maPrefetch=url;
  if (asType) link.as=asType;
  document.head.appendChild(link);
}

function scheduleFeaturePrefetch(){
  const conn=navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  if (conn && (conn.saveData || /(^|-)2g$/.test(conn.effectiveType || ''))) return;

  const run=()=>{
    maPrefetch(`js/dashboard.js?v=${MA_FILE_VERSIONS.dashboardJs}`,'script');
    maPrefetch(`css/dashboard.css?v=${MA_FILE_VERSIONS.dashboardCss}`,'style');
    setTimeout(()=>{
      maPrefetch(`js/mail.js?v=${MA_FILE_VERSIONS.mailJs}`,'script');
      maPrefetch(`js/maintenance.js?v=${MA_FILE_VERSIONS.maintenanceJs}`,'script');
      maPrefetch(`css/maintenance.css?v=${MA_FILE_VERSIONS.maintenanceCss}`,'style');
      maPrefetch(`js/history.js?v=${MA_FILE_VERSIONS.historyJs}`,'script');
      maPrefetch(`css/history.css?v=${MA_FILE_VERSIONS.historyCss}`,'style');
    },1200);
  };

  if ('requestIdleCallback' in window){
    requestIdleCallback(run,{timeout:3500});
  } else {
    setTimeout(run,2500);
  }
}

window.addEventListener('load',scheduleFeaturePrefetch,{once:true});
