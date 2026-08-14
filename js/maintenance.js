/* Lazy feature: maintenance */
async function ensureMaintenanceDataLoaded(){
  if (maintenanceDataLoaded) return true;
  if (maintenanceDataLoadPromise) return maintenanceDataLoadPromise;

  maintenanceDataLoadPromise = (async () => {
    await dataReady;

    if (githubConfig && githubToken){
      const maConfig = maintenanceGithubConfigOf(githubConfig);
      try{
        const { json: maJson, sha: maSha } = await githubApiGet(maConfig, githubToken);
        maintenanceLogs = (maJson.maintenanceLogs || []).map(m => ({...m}));
        maintenanceSyncMutations = (maJson.syncMutations || []).map(m => ({...m}));
        maintenanceGithubSha = maSha;
        lastSyncedMaintenanceState = currentMaintenanceState();
      }
      catch(e){
        if (e.notFound){
          maintenanceLogs = (legacyMaintenanceLogs || []).map(m => ({...m}));
          maintenanceSyncMutations = [];
          maintenanceGithubSha = null;
          lastSyncedMaintenanceState = {maintenanceLogs:[], syncMutations:[]};
        } else {
          throw e;
        }
      }
    }
    else {
      try{
        const maRes = await fetch('ma.json', {cache:'no-cache'});
        if (!maRes.ok) throw new Error('HTTP ' + maRes.status);
        const maJson = await maRes.json();
        maintenanceLogs = (maJson.maintenanceLogs || []).map(m => ({...m}));
        maintenanceSyncMutations = (maJson.syncMutations || []).map(m => ({...m}));
        maintenanceGithubSha = null;
        lastSyncedMaintenanceState = currentMaintenanceState();
      }
      catch(e){
        console.warn('ma.json 지연 로드 실패, 기존 data.json 점검 기록을 사용합니다:', e);
        maintenanceLogs = (legacyMaintenanceLogs || []).map(m => ({...m}));
        maintenanceSyncMutations = [];
        maintenanceGithubSha = null;
        lastSyncedMaintenanceState = {maintenanceLogs:[], syncMutations:[]};
      }
    }

    maintenanceDataLoaded = true;
    return true;
  })();

  try{
    return await maintenanceDataLoadPromise;
  }
  finally{
    maintenanceDataLoadPromise = null;
  }
}

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

function maintenanceLogHasInspectionData(log){
  if (!log) return false;
  return !!(
    String(log.date || '').trim() ||
    String(log.manager || '').trim() ||
    String(log.note || '').trim() ||
    log.done ||
    log.incomplete ||
    log.uncontracted
  );
}

function maintenanceMailInquiryHtml(log){
  if (!log || !log.mail_inquiry) return '';
  const when = log.mail_inquiry_at
    ? new Date(log.mail_inquiry_at).toLocaleString('ko-KR')
    : '';
  const tip = [
    '점검 메일 문의',
    log.mail_inquiry_author ? `담당 ${log.mail_inquiry_author}` : '',
    when
  ].filter(Boolean).join(' · ');

  return `<div class="maint-cell-mail-inquiry" title="${esc(tip)}">메일 문의</div>`;
}

function markMaintenanceMailInquiry(gid, ym){
  if (!gid || !ym) return null;

  const mutationId = createMutationId('ma-mail');
  let log = maintenanceLogFor(gid, ym);

  if (!log){
    log = { id: Date.now(), group: gid, ym };
    maintenanceLogs.push(log);
  }

  log.mutation_id = mutationId;
  log.mail_inquiry = true;
  log.mail_inquiry_at = Date.now();
  log.mail_inquiry_author = currentUserName() || log.mail_inquiry_author || '';
  log.updated_at = Date.now();

  markMaintenanceDirty(mutationId);

  runMaintenanceSync().catch(e => {
    console.error('메일 문의 상태 저장 실패:', e);
  });

  return log;
}

function removeMaintenanceMailInquiry(gid, ym){
  const log = maintenanceLogFor(gid, ym);
  if (!log || !log.mail_inquiry) return false;

  const mutationId = createMutationId('ma-mail-delete');

  delete log.mail_inquiry;
  delete log.mail_inquiry_at;
  delete log.mail_inquiry_author;

  if (maintenanceLogHasInspectionData(log)){
    log.mutation_id = mutationId;
    log.updated_at = Date.now();
  } else {
    maintenanceLogs = maintenanceLogs.filter(
      m => !(m.group === gid && m.ym === ym)
    );
  }

  markMaintenanceDirty(mutationId);
  return true;
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
      const mailInquiryHtml = maintenanceMailInquiryHtml(log);
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
            ${mailInquiryHtml}
      
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
          ${mailInquiryHtml}
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
            ${mailInquiryHtml}
          </td>
        `;
      }
      return `<td class="maint-cell maint-cell-blank ${isCurrent?'is-current':''}" data-maint-cell="${esc(g.gid)}|${ym}" title="${esc(ymLabel(ym))} 점검 등록${log && log.mail_inquiry ? ' · 메일 문의' : ''}">
        ${mailInquiryHtml || '<span class="maint-cell-dash">–</span>'}
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

            <button type="button"
                    class="maint-license-notice-btn maint-mail-settings-btn"
                    id="maintenanceMailSettingsBtn"
                    title="내 점검 이메일 제목 및 내용 한글/영어 템플릿 등록">
              <span class="maint-license-notice-icon">✉</span>
              <span>점검 메일 템플릿 설정</span>
            </button>
        
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

  const maintenanceMailSettingsBtn =
    wrap.querySelector('#maintenanceMailSettingsBtn');
  if (maintenanceMailSettingsBtn){
    maintenanceMailSettingsBtn.onclick =
      openMaintenanceMailSettingsModal;
  }

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
  const hasInspectionLog = maintenanceLogHasInspectionData(log);
  document.getElementById('mlModalTitle').textContent = `${g.meta.owner} · ${ymLabel(ym)} 점검 등록`;

  const mailLanguageEl = document.getElementById('mlEmailLanguage');
  if (mailLanguageEl) mailLanguageEl.value = 'ko';

  const dateEl = document.getElementById('ml_date');
  const datePicker = document.getElementById('ml_date_picker');

  if (hasInspectionLog && !log.incomplete && !log.uncontracted){
    dateEl.value = log.date || '';

    if (log.date){
      const parts = String(log.date).split('.').map(Number);
      if (parts.length === 3 && parts.every(Number.isFinite)){
        datePicker.value =
          `${parts[0]}-${String(parts[1]).padStart(2,'0')}-${String(parts[2]).padStart(2,'0')}`;
      }
    } else {
      datePicker.value = `${ym}-01`;
    }
  }
  else if (hasInspectionLog){
    dateEl.value = '';
    datePicker.value = '';
  }
  else {
    const today = new Date();
    const todayYm =
      `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}`;

    if (ym === todayYm){
      dateEl.value = todayDots();
      datePicker.value =
        `${todayYm}-${String(today.getDate()).padStart(2,'0')}`;
    } else {
      dateEl.value = '';
      datePicker.value = `${ym}-01`;
    }
  }
  
  document.getElementById('ml_manager').value =
    hasInspectionLog
      ? (log.manager || '')
      : (currentUserName() || g.meta.owner_primary || '');
  
  document.getElementById('ml_done').checked =
    hasInspectionLog ? !!log.done : true;
  
  document.getElementById('ml_incomplete').checked =
    hasInspectionLog ? !!log.incomplete : false;
  
  document.getElementById('ml_uncontracted').checked =
    hasInspectionLog ? !!log.uncontracted : false;
  
  document.getElementById('ml_note').value =
    hasInspectionLog ? (log.note || '') : '';
  
  syncMaintenanceStatusControls();
  document.getElementById('mlError').textContent = '';
  document.getElementById('mlDeleteBtn').style.display = hasInspectionLog ? '' : 'none';

  const mailInquiryDeleteBtn =
    document.getElementById('mlMailInquiryDeleteBtn');
  
  const mailSendBtn =
    document.getElementById('mlEmailBtn');
  
  const hasMailInquiry =
    log?.mail_inquiry === true;
  
  const hasSavedInspectionStatus =
    !!log &&
    (
      log.done === true ||
      log.incomplete === true ||
      log.uncontracted === true
    );

  mailInquiryDeleteBtn?.classList.toggle(
    'is-hidden',
    !hasMailInquiry
  );
  
  const hideMailSendControls =
    hasMailInquiry ||
    hasSavedInspectionStatus;
  
  mailLanguageEl?.classList.toggle(
    'is-hidden',
    hideMailSendControls
  );
  
  mailSendBtn?.classList.toggle(
    'is-hidden',
    hideMailSendControls
  );
  
  if (!hideMailSendControls){
    refreshMaintenanceMailButton(gid);
  }
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

document.getElementById('mlEmailBtn').onclick = () => {
  openMaintenanceEmailCompose();
};

const mlMailInquiryDeleteBtn = document.getElementById('mlMailInquiryDeleteBtn');
if (mlMailInquiryDeleteBtn){
  mlMailInquiryDeleteBtn.onclick = async () => {
    if (!maintenanceEditTarget) return;

    const { gid, ym } = maintenanceEditTarget;
    const log = maintenanceLogFor(gid, ym);
    if (!log || !log.mail_inquiry) return;

    if (!confirm(`${ymLabel(ym)}의 '메일 문의' 표시를 삭제하시겠습니까?`)) return;
    if (!removeMaintenanceMailInquiry(gid, ym)) return;

    await syncWorkLogAndWait(
      `${ymLabel(ym)} 메일 문의 삭제 내용 동기화 중…`,
      () => {
        closeMaintenanceLogModal();
        renderMaintenance();
      },
      false,
      'maintenance'
    );
  };
}

document.getElementById('saveMlBtn').onclick = async () => {
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
  }
  else {
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

  const mutationId = createMutationId('ma');

  let log = maintenanceLogFor(gid, ym);
  if (!log){
    log = { id: Date.now(), group: gid, ym };
    maintenanceLogs.push(log);
  }

  log.mutation_id = mutationId;
  log.date = date;
  log.manager = manager;
  log.note = note;
  log.done = uncontracted ? false : done;
  log.incomplete = uncontracted ? false : incomplete;
  log.uncontracted = uncontracted;
  log.author = currentUserName() || log.author || '';
  log.updated_at = Date.now();

  markMaintenanceDirty(mutationId);

  await syncWorkLogAndWait(
    `${ymLabel(ym)} 유지보수 점검 동기화 중…`,
    () => {
      closeMaintenanceLogModal();
      renderMaintenance();
    },
    false,
    'maintenance'
  );
};

document.getElementById('mlDeleteBtn').onclick = async () => {
  if (!maintenanceEditTarget) return;
  if (!confirm('이 달의 점검 등록을 취소하시겠습니까?')) return;

  const { gid, ym } = maintenanceEditTarget;
  const mutationId = createMutationId('ma-delete');

  const existingLog = maintenanceLogFor(gid, ym);

  if (existingLog && existingLog.mail_inquiry){
    /* 점검 등록만 취소하고 메일 문의 이력은 유지 */
    existingLog.mutation_id = mutationId;
    existingLog.date = '';
    existingLog.manager = '';
    existingLog.note = '';
    existingLog.done = false;
    existingLog.incomplete = false;
    existingLog.uncontracted = false;
    existingLog.updated_at = Date.now();
  } else {
    maintenanceLogs = maintenanceLogs.filter(
      m => !(m.group === gid && m.ym === ym)
    );
  }

  markMaintenanceDirty(mutationId);

  await syncWorkLogAndWait(
    `${ymLabel(ym)} 유지보수 점검 삭제 내용 동기화 중…`,
    () => {
      closeMaintenanceLogModal();
      renderMaintenance();
    },
    false,
    'maintenance'
  );
};


window.__maFeatureLoaded = window.__maFeatureLoaded || {}; window.__maFeatureLoaded.maintenance = true;
