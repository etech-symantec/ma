/* Lazy feature: maintenance mail */
/* =========================================================
   유지보수 점검 이메일 - 사용자별 한글/English 템플릿 / Outlook 작성
   ========================================================= */
const DEFAULT_MAINTENANCE_MAIL_SUBJECT_KO =
  '[{법인명}] {점검월} 정기점검 일정 안내';

const DEFAULT_MAINTENANCE_MAIL_BODY_KO =
`안녕하세요.

{법인명} {점검월} 정기점검 관련하여 안내드립니다.

점검 예정일: {점검일}
점검 담당자: {담당자}

확인 부탁드립니다.
감사합니다.`;

const DEFAULT_MAINTENANCE_MAIL_SUBJECT_EN =
  '[{Company}] {InspectionMonth} Maintenance Inspection Schedule';

const DEFAULT_MAINTENANCE_MAIL_BODY_EN =
`Hello,

This is to inform you about the scheduled maintenance inspection for {Company} in {InspectionMonth}.

Inspection date: {InspectionDate}
Engineer: {Engineer}

Please review the schedule.
Thank you.`;

function currentUserRecord(){
  return users.find(
    x => String(x.id) === String(currentUserId)
  ) || null;
}

function openMaintenanceMailSettingsModal(){
  const user = currentUserRecord();

  if (!user){
    alert('로그인 사용자를 확인할 수 없습니다.');
    return;
  }

  const subjectKoEl = document.getElementById('mms_subject_ko');
  const bodyKoEl = document.getElementById('mms_body_ko');
  const subjectEnEl = document.getElementById('mms_subject_en');
  const bodyEnEl = document.getElementById('mms_body_en');
  const errEl = document.getElementById('mmsError');

  /* 기존 단일 한글 템플릿을 사용 중인 데이터도 자동 승계 */
  subjectKoEl.value =
    user.maintenance_mail_subject_ko ||
    user.maintenance_mail_subject ||
    DEFAULT_MAINTENANCE_MAIL_SUBJECT_KO;

  bodyKoEl.value =
    user.maintenance_mail_body_ko ||
    user.maintenance_mail_body ||
    DEFAULT_MAINTENANCE_MAIL_BODY_KO;

  subjectEnEl.value =
    user.maintenance_mail_subject_en ||
    DEFAULT_MAINTENANCE_MAIL_SUBJECT_EN;

  bodyEnEl.value =
    user.maintenance_mail_body_en ||
    DEFAULT_MAINTENANCE_MAIL_BODY_EN;


  errEl.textContent = '';

  document
    .getElementById('maintenanceMailSettingsModal')
    .classList.add('open');

  requestAnimationFrame(() => subjectKoEl.focus());
}

function closeMaintenanceMailSettingsModal(){
  document
    .getElementById('maintenanceMailSettingsModal')
    .classList.remove('open');
}

function maintenanceMailRecipientsForGroup(gid){
  const items = records.filter(r => r.group === gid);
  if (!items.length) return [];

  const meta = groupMeta(items);
  const seen = new Set();
  const out = [];

  (meta.cust_contacts || []).forEach(contact => {
    const email = String(contact?.email || '').trim();
    if (!email) return;

    email
      .split(/[;,\s]+/)
      .map(x => x.trim())
      .filter(Boolean)
      .forEach(addr => {
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr)) return;
        const key = addr.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        out.push(addr);
      });
  });

  return out;
}

function maintenanceMonthLabelEnglish(ym){
  const [year, month] = String(ym || '').split('-').map(Number);
  if (!year || !month) return String(ym || '');

  const monthNames = [
    'January','February','March','April','May','June',
    'July','August','September','October','November','December'
  ];

  return `${monthNames[month - 1]} ${year}`;
}

function maintenanceDateLabelEnglish(dateText){
  const raw = String(dateText || '').trim();
  if (!raw || raw === '미정') return 'TBD';

  const parts = raw.split(/[.\/-]/).map(Number);
  if (parts.length >= 3 && parts.slice(0,3).every(Number.isFinite)){
    const [year, month, day] = parts;
    const monthNames = [
      'January','February','March','April','May','June',
      'July','August','September','October','November','December'
    ];
    if (month >= 1 && month <= 12){
      return `${monthNames[month - 1]} ${day}, ${year}`;
    }
  }

  return raw;
}

function maintenanceMailTemplateValues(gid, ym, language = 'ko'){
  const items = records.filter(r => r.group === gid);
  const meta = groupMeta(items);

  const rawDate =
    String(document.getElementById('ml_date')?.value || '').trim() ||
    '미정';

  const manager =
    String(document.getElementById('ml_manager')?.value || '').trim() ||
    currentUserName() ||
    meta.owner_primary ||
    '미정';

  const koValues = {
    '{법인명}': meta.owner || '',
    '{위치}': meta.location || '',
    '{점검월}': ymLabel(ym),
    '{점검일}': rawDate,
    '{담당자}': manager
  };

  const enValues = {
    '{Company}': meta.owner || '',
    '{Location}': meta.location || '',
    '{InspectionMonth}': maintenanceMonthLabelEnglish(ym),
    '{InspectionDate}': maintenanceDateLabelEnglish(rawDate),
    '{Engineer}': manager
  };

  /* 어느 언어 템플릿에서도 두 종류 치환 문자를 모두 사용할 수 있게 지원 */
  return {
    ...koValues,
    ...enValues,
    '{점검월}': language === 'en' ? maintenanceMonthLabelEnglish(ym) : koValues['{점검월}'],
    '{점검일}': language === 'en' ? maintenanceDateLabelEnglish(rawDate) : koValues['{점검일}']
  };
}

function applyMaintenanceMailTemplate(text, values){
  let result = String(text || '');

  Object.entries(values || {}).forEach(([key, value]) => {
    result = result.split(key).join(String(value ?? ''));
  });

  return result;
}

function refreshMaintenanceMailButton(gid){
  const btn = document.getElementById('mlEmailBtn');
  if (!btn) return;

  const recipients = maintenanceMailRecipientsForGroup(gid);

  btn.title = recipients.length
    ? `등록된 고객사 담당자 ${recipients.length}명을 수신자로 넣고 제목을 채웁니다. 메일 내용은 클립보드에 자동 복사됩니다.`
    : '이 법인에 등록된 고객사 담당자 이메일이 없습니다.';
}

async function copyMaintenanceMailBodyToClipboard(text){
  const body = String(text || '');

  if (navigator.clipboard && window.isSecureContext){
    await navigator.clipboard.writeText(body);
    return true;
  }

  /* 구형/제한 브라우저 fallback */
  const ta = document.createElement('textarea');
  ta.value = body;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.left = '-9999px';
  ta.style.top = '0';
  document.body.appendChild(ta);
  ta.select();

  let copied = false;
  try{
    copied = document.execCommand('copy');
  }
  finally{
    ta.remove();
  }

  if (!copied){
    throw new Error('클립보드 복사에 실패했습니다.');
  }

  return true;
}

async function openMaintenanceEmailCompose(){
  if (!maintenanceEditTarget) return;

  const { gid, ym } = maintenanceEditTarget;
  const errEl = document.getElementById('mlError');
  const user = currentUserRecord();

  if (!user){
    errEl.textContent = '로그인 사용자를 확인할 수 없습니다.';
    return;
  }

  const recipients = maintenanceMailRecipientsForGroup(gid);

  if (!recipients.length){
    errEl.textContent =
      '이 법인에 등록된 고객사 담당자 이메일이 없습니다. 법인 정보의 고객사 담당자 이메일을 먼저 등록해 주세요.';
    return;
  }

  const language =
    document.getElementById('mlEmailLanguage')?.value === 'en'
      ? 'en'
      : 'ko';

  const subjectTemplate = language === 'en'
    ? String(user.maintenance_mail_subject_en || '').trim()
    : String(
        user.maintenance_mail_subject_ko ||
        user.maintenance_mail_subject ||
        ''
      ).trim();

  const bodyTemplate = language === 'en'
    ? String(user.maintenance_mail_body_en || '').trim()
    : String(
        user.maintenance_mail_body_ko ||
        user.maintenance_mail_body ||
        ''
      ).trim();

  if (!subjectTemplate || !bodyTemplate){
    errEl.textContent = language === 'en'
      ? '현재 사용자의 English 점검 메일 제목/내용이 등록되어 있지 않습니다. 점검 메일 설정에서 먼저 저장해 주세요.'
      : '현재 사용자의 한글 점검 메일 제목/내용이 등록되어 있지 않습니다. 점검 메일 설정에서 먼저 저장해 주세요.';
    openMaintenanceMailSettingsModal();
    return;
  }

  const values = maintenanceMailTemplateValues(gid, ym, language);
  const subject = applyMaintenanceMailTemplate(subjectTemplate, values);
  const body = applyMaintenanceMailTemplate(bodyTemplate, values);

  try{
    /* 본문은 mailto에 넣지 않고 클립보드로 복사 */
    await copyMaintenanceMailBodyToClipboard(body);
  }
  catch(e){
    console.error('점검 메일 본문 클립보드 복사 실패:', e);
    errEl.textContent =
      '메일 내용을 클립보드에 복사하지 못했습니다. 브라우저의 클립보드 권한을 확인해 주세요.';
    return;
  }

  const mailto =
    `mailto:${recipients.join(',')}` +
    `?subject=${encodeURIComponent(subject)}`;

  errEl.textContent = '';

  /* 해당 월에 메일 문의 이력을 남기고, 팝업 대신 점검 모달 안에서 안내 */
  markMaintenanceMailInquiry(gid, ym);
  showMaintenanceMailCopyNotice(gid, ym);

  /* 안내문이 먼저 화면에 그려진 뒤 기본 메일 앱을 연다. */
  requestAnimationFrame(() => {
    window.location.href = mailto;
  });
}

const cancelMmsBtn = document.getElementById('cancelMmsBtn');
if (cancelMmsBtn){
  cancelMmsBtn.onclick = closeMaintenanceMailSettingsModal;
}

const saveMmsBtn = document.getElementById('saveMmsBtn');
if (saveMmsBtn){
  saveMmsBtn.onclick = () => {
    const user = currentUserRecord();
    const errEl = document.getElementById('mmsError');

    if (!user){
      errEl.textContent = '로그인 사용자를 확인할 수 없습니다.';
      return;
    }

    const subjectKo =
      document.getElementById('mms_subject_ko').value.trim();
    const bodyKo =
      document.getElementById('mms_body_ko').value.trim();
    const subjectEn =
      document.getElementById('mms_subject_en').value.trim();
    const bodyEn =
      document.getElementById('mms_body_en').value.trim();

    const requiredFields = [
      ['한글 메일 제목', subjectKo, 'mms_subject_ko'],
      ['한글 메일 내용', bodyKo, 'mms_body_ko'],
      ['English 메일 제목', subjectEn, 'mms_subject_en'],
      ['English 메일 내용', bodyEn, 'mms_body_en']
    ];

    for (const [label, value, id] of requiredFields){
      if (!value){
        errEl.textContent = `${label}을(를) 입력해 주세요.`;
        document.getElementById(id).focus();
        return;
      }
    }

    const changed =
      user.maintenance_mail_subject_ko !== subjectKo ||
      user.maintenance_mail_body_ko !== bodyKo ||
      user.maintenance_mail_subject_en !== subjectEn ||
      user.maintenance_mail_body_en !== bodyEn;

    if (changed){
      const mutationId = createMutationId('mail-template');

      user.maintenance_mail_subject_ko = subjectKo;
      user.maintenance_mail_body_ko = bodyKo;
      user.maintenance_mail_subject_en = subjectEn;
      user.maintenance_mail_body_en = bodyEn;

      /* 구버전 앱에서 한글 템플릿을 계속 읽을 수 있도록 호환 필드도 유지 */
      user.maintenance_mail_subject = subjectKo;
      user.maintenance_mail_body = bodyKo;

      scheduleAutoSync(mutationId);
    }

    errEl.textContent = '';
    closeMaintenanceMailSettingsModal();
  };
}


window.__maFeatureLoaded = window.__maFeatureLoaded || {}; window.__maFeatureLoaded.mail = true;
