/* Lazy feature: full work history */
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
        author:audit.actor_name || '미상',
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
    <div class="maint-sticky-top wh-sticky-top">
      <div class="maint-header">
        <div class="maint-header-row"><h2>업데이트 전체보기</h2></div>
        <p class="maint-sub">모든 업데이트 내역(추가·편집·삭제 기록)을 한 곳에서 확인합니다 · 총 ${total}건</p>
      </div>
      <div class="wh-toolbar">
        <!-- 왼쪽 : 전체 선택 / 선택 삭제 -->
        ${isCurrentUserAdmin() ? `
          <div class="wh-admin-actions">
            <label class="wh-select-all">
              <input type="checkbox" id="whSelectAll">
              <span>전체 선택</span>
            </label>
            <span class="wh-selected-count" id="whSelectedCount">0건 선택</span>
            <button type="button" class="btn wh-delete-selected" id="whDeleteSelected" disabled>선택 삭제</button>
          </div>
        ` : `<div></div>`}
      
        <!-- 오른쪽 : 검색 / 구분 / 정렬 -->
        <div class="wh-filter-actions">
          <div class="tf-search wh-search">
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
            >
              <circle cx="11" cy="11" r="8"/>
              <path d="m21 21-4.3-4.3"/>
            </svg>
      
            <input type="text" id="whSearchInput" placeholder="법인·자산·사용자·내용으로 검색" value="${esc(whSearch)}"></div>
      
          <select id="whTypeSelect" class="wh-select"><option value="">전체 구분</option>      
            ${types.map(t => `
              <option
                value="${esc(t)}"
                ${whTypeFilter===t ? 'selected' : ''}
              >
                ${esc(t)}
              </option>
            `).join('')}
          </select>
      
          <select id="whSortSelect" class="wh-select">
            <option value="desc" ${whSort==='desc' ? 'selected' : ''}>최신순</option>
      
            <option value="asc" ${whSort==='asc' ? 'selected' : ''}>오래된순</option>
          </select>
        </div>
      </div>

      <!-- 업데이트 목록 열 제목 -->
      <div class="wh-column-header" aria-hidden="true">
        <div class="wh-col-select"></div>
        <div class="wh-col-date">날짜 / 시간</div>
        <div class="wh-col-type">작업명</div>
        <div class="wh-col-asset">자산</div>
        <div class="wh-col-note">내용</div>
        <div class="wh-col-changes">변경 내용</div>
        <div class="wh-col-author">담당자</div>
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
  items.sort((a,b) =>
    whSort === 'desc'
      ? (b.historyTs || 0) - (a.historyTs || 0)
      : (a.historyTs || 0) - (b.historyTs || 0)
  );

  listEl.innerHTML = items.length ? items.map(item => {
    const {
      entry,
      recId,
      recGroup,
      recOwner,
      recLabel,
      recSn,
      deleted,
      source,
      key,
      historyTs
    } = item;
  
    const deletedAtText =
      deleted && entry.deleted_at
        ? new Date(entry.deleted_at).toLocaleString('ko-KR')
        : '';
  
    const revert =
      entry.delete_revert_result || null;
  
    const revertText =
      deleted && revert
        ? `삭제 시 자산 정보 원복 ${Number(revert.reverted || 0)}건${
            Number(revert.skipped || 0)
              ? ` · 유지 ${Number(revert.skipped || 0)}건`
              : ''
          }`
        : '';
  
    const canJump =
      !!recGroup;

    const displayAuthor =
      String(entry.author || '')
        .replace(
          /\s*·\s*(마스터|일반사용자)\s*$/g,
          ''
        )
        .trim();
  
    return `
      <div
        class="wh-item
          ${deleted ? 'wh-item-deleted' : ''}
          ${source === 'audit' ? 'wh-item-audit' : ''}"
        ${canJump
          ? `data-jump-group="${esc(recGroup)}"
             data-jump-rec="${esc(recId)}"`
          : ''}
        data-history-key="${esc(key)}"
      >
  
        <div class="wh-top">
  
          ${isCurrentUserAdmin() ? `
            <label
              class="wh-history-check"
              title="삭제할 이력 선택"
            >
              <input
                type="checkbox"
                class="wh-history-checkbox"
                data-wh-select="${esc(key)}"
                ${whSelectedKeys.has(key) ? 'checked' : ''}
              >
            </label>
          ` : ''}
  
          <!-- 날짜 + 시간 -->
          <span class="ra-date">
            ${esc(
              workHistoryDateTime(
                historyTs,
                entry.date
              )
            )}
          </span>

          <!-- 작업명 -->
          <span class="ra-type">
            ${esc(entry.type)}
          
            ${deleted
              ? '<span class="wh-deleted-badge">삭제됨</span>'
              : ''}
          </span>
        </div>
  
        <!-- 법인 / 자산 -->
        <div class="ra-asset" title="${esc(recOwner || '—')} ${recLabel ? ' · ' + esc(recLabel) : ''}${recSn ? ' · S/N ' + esc(recSn) : ''}">
          <span class="wh-owner">${esc(recOwner) || '—'}</span>        
          ${recLabel ? `
            <span class="wh-sku-badge">
              ${esc(recLabel)}
            </span>
          ` : ''}
        
          ${recSn ? `
            <span class="wh-sn-badge">
              S/N ${esc(recSn)}
            </span>
          ` : ''}
        </div>
  
        <!-- 작업 내용 -->
        <div
          class="ra-note"
          title="${esc(entry.note || '')}"
        >
          ${esc(entry.note) || '—'}
        </div>
  
        <!-- 변경 내용 -->
        ${entry.change_summary ? `
          <div class="ra-changes">
  
            <div class="ra-changes-label">
              ${source === 'audit'
                ? '📝 변경 내용'
                : `🔧 자산 정보 변경${deleted ? ' · 삭제 시 원복 처리' : ''}`
              }
            </div>
  
            ${changeSummaryRowsHtml(
              entry.change_summary
            )}
  
          </div>
        ` : ''}
  
        <!-- 작업자 -->
        <div class="ra-author">
          ${source === 'audit'
            ? `작업자: ${esc(displayAuthor) || '미상'}`
            : `담당자: ${esc(entry.manager) || '미기재'} · 작성: ${esc(displayAuthor) || '미상'}`
          }
        </div>
  
        <!-- 삭제 정보 -->
        ${deleted ? `
          <div class="wh-delete-meta">
  
            삭제:
            ${esc(entry.deleted_by) || '미상'}
            ·
            ${esc(deletedAtText) || '시간 미기재'}
  
            ${revertText
              ? ` · ${esc(revertText)}`
              : ''}
  
          </div>
        ` : ''}
      </div>
    `;
  
  }).join('') : `
    <div class="ra-empty wh-empty">
      조건에 맞는 이력이 없습니다.
    </div>
  `;

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


window.__maFeatureLoaded = window.__maFeatureLoaded || {}; window.__maFeatureLoaded.history = true;
