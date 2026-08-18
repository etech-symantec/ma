/* GitHub API / storage helpers - initial load */
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

async function githubApiGet(cfg, token, signal = null){
  const or = parseOwnerRepo(cfg.repo);
  if (!or) throw new Error('저장소는 owner/repo 형식으로 입력해 주세요.');
  const branch = cfg.branch || 'main';
  const path = cfg.path || 'data.json';
  const url = `https://api.github.com/repos/${or.owner}/${or.repo}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(branch)}`;
  const res = await fetch(url, {headers: {'Authorization':'Bearer '+token, 'Accept':'application/vnd.github+json'}, cache:'no-store', signal});
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

async function githubApiPut(cfg, token, jsonObj, sha, message, signal = null){
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
    body: JSON.stringify(body),
    signal
  });
  if (!res.ok){
    const errBody =
      await res.json().catch(()=>({}));
    const err =
      new Error(
        `GitHub 저장 실패: HTTP ${res.status}` +
        `${errBody.message ? ' - ' + errBody.message : ''}`
      );
    err.status = res.status;
    err.githubBody = errBody;
    throw err;
  }
  const data = await res.json();
  return data.content.sha;
}

