/* Lazy feature: dashboard */
// ---------- 대시보드 (OS 버전별 / 태그별 / 위치별 / 국가별 / SKU별 현황 한눈에 보기) ----------
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

/*
  7.4.2 / 7.10.1 같은 버전을
  문자열이 아니라 숫자 단위로 비교
*/
function compareDashboardVersions(a, b){

  const av =
    String(a || '')
      .split('.')
      .map(v => Number(v) || 0);

  const bv =
    String(b || '')
      .split('.')
      .map(v => Number(v) || 0);

  const length =
    Math.max(
      av.length,
      bv.length
    );

  for (
    let i = 0;
    i < length;
    i++
  ){

    const an =
      av[i] || 0;

    const bn =
      bv[i] || 0;

    if (an < bn){
      return -1;
    }

    if (an > bn){
      return 1;
    }
  }

  return 0;
}


/*
  해당 태그 카드에서
  가장 낮은 버전 / 가장 높은 버전 계산
*/
function dashboardVersionExtremes(data){

  const versions =
    data
      .map(([label]) =>
        String(label || '').trim()
      )
      .filter(version =>
        /^\d+(?:\.\d+)*$/.test(version)
      )
      .sort(compareDashboardVersions);


  if (!versions.length){

    return {
      oldest:'',
      latest:''
    };
  }


  return {
    oldest:
      versions[0],

    latest:
      versions[
        versions.length - 1
      ]
  };
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

function dashboardSectionHtml(sectionKey, title, colorClass, data, clickable, highlightVersions = false){
  const max = data.length ? Math.max(
          ...data.map(
            row => row[1]
          )
        )
      : 1;
  
  const versionExtremes =
    highlightVersions
      ? dashboardVersionExtremes(data)
      : {
          oldest:'',
          latest:''
        };
  
  const rowsHtml =
    data.map(
      ([label, count, items], idx) => {
  
        const version =
          String(label || '').trim();
  
        const isOldest =
          highlightVersions &&
          version &&
          version ===
            versionExtremes.oldest;
  
        const isLatest =
          highlightVersions &&
          version &&
          version ===
            versionExtremes.latest;
  
        const isOnlyVersion =
          isOldest &&
          isLatest;
  
        let versionClass = '';
        let versionBadge = '';
  
        if (isOnlyVersion){
          versionClass =
            ' dash-version-only';
          versionBadge =
            `<span class="dash-version-badge dash-version-badge-only">유일 버전</span>`;
        }
        else if (isOldest){
          versionClass =
            ' dash-version-oldest';
  
          versionBadge =
            `<span class="dash-version-badge dash-version-badge-oldest">오래된</span>`;
        }
        else if (isLatest){
          versionClass =
            ' dash-version-latest';
          versionBadge =
            `<span class="dash-version-badge dash-version-badge-latest">최신</span>`;
        }
  
        const detailId = `dashDetail_${sectionKey}_${idx}`;
  
        const row = `<div class="dash-row${clickable ? ' dash-row-clickable' : ''}${versionClass}"
            ${clickable
              ? `data-dash-toggle="${detailId}"`
              : ''
            }
          >
  
            <span class="dash-version-label-wrap">
              <span class="dash-row-label" title="${esc(label)}">
                ${esc(label)}
              </span>
            
              ${versionBadge}
            </span>
  
            <div class="dash-bar-track">
              <div
                class="dash-bar-fill ${colorClass}"
                style="
                  width:${
                    Math.max(
                      5,
                      Math.round(
                        count /
                        max *
                        100
                      )
                    )
                  }%
                "
              ></div>
            </div>
  
            <span class="dash-row-count">
              ${count}
            </span>
  
            ${
              clickable
                ? '<span class="dash-row-caret">▾</span>'
                : ''
            }
          </div>
        `;
  
        const detail =
          clickable
  
            ? `
              <div
                class="dash-row-detail"
                id="${detailId}"
                style="display:none;"
              >
                ${dashboardCompanyListHtml(items)}
              </div>
            `
            : '';
  
        return row + detail;
      }
    );

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
    dashboardSectionHtml(`os_${g.tag}`, `${g.tag} 태그 · 버전별`, 'dash-c1', bucketGroups(g.items, r => osVersionTag(r.os_ver)), true, true)
  ).join('');
  const osNoTagCardHtml = osNoTagItems.length
    ? dashboardSectionHtml('os_none', '태그 없음 · 버전별', 'dash-c1', bucketGroups(osNoTagItems, r => osVersionTag(r.os_ver)), true, true)
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


window.__maFeatureLoaded = window.__maFeatureLoaded || {}; window.__maFeatureLoaded.dashboard = true;
