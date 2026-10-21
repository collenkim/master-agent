import { renderInteractions } from './interactions.mjs';
import { renderHistory, renderStageDetails } from './history.mjs';
const $ = id => document.getElementById(id);
const labels = {
  completed: '완료', cancelled: '취소', paused: '일시 정지', running: '실행 중',
  'approval-processing': '승인 처리 중', 'approval-pending': '승인 처리 대기', 'human-input': '사람 답 필요',
  blocked: '장애·점검 필요', 'verification-pending': '검증 대기', verifying: '검증 중', 'handoff-pending': '인계 대기',
  ready: '진행 가능', waiting: '선행 작업 대기', analyzing: '분석 중', planning: '계획 준비',
  observed: '조회 성공', unobserved: '미조회', 'not-installed': '미설치', timeout: '조회 시간 초과',
  'process-error': '조회 실패', 'invalid-json': '응답 오류', 'invalid-state': '상태 오류', 'wrong-project': '프로젝트 불일치',
  'unsupported-version': '지원하지 않는 버전', unobservable: '관측 불가',
  'no-work': '현재 작업 없음', 'needs-human': '사람 판단 필요', 'ownership-conflict': '소유권 충돌',
  'replan-required': '재계획 필요', 'reapproval-required': '재승인 필요', 'limit-reached': '한도 도달',
  'stale-request': '요청 상태 변경', wait: '대기',
  'setup-required': '실행 준비 필요',
  queued: '접수·시작 대기', failed: '실행 오류', interrupted: '실행기 중단',
  skipped: '건너뜀', 'needs-attention': '결과 확인 필요',
};
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const date = value => value ? new Date(value).toLocaleString('ko-KR') : '기록 없음';
const attention = p => p.attention;
const unavailable = p => p.observation.status !== 'observed' || p.observation.stale;
const badge = status => `<span class="badge ${['blocked', 'human-input', 'process-error', 'timeout'].includes(status) ? 'danger' : ['completed', 'observed'].includes(status) ? 'success' : ''}">${escape(labels[status] ?? status)}</span>`;
const connectionLabels = { connected: '제어 연결됨', 'pairing-available': '제어 연결 가능', 'trust-missing': 'PC 신뢰 필요', 'enabled-unbound': '연동 켜짐 · 이 DB 미등록',
  'owned-by-other': '다른 제어자 소유', legacy: '터미널 연결 필요', unknown: '연결 확인 전', 'not-installed': 'code-agent 없음', stale: '연결 갱신 필요', observer: '관찰 연결' };
function connectionView(p) {
  const c = p.connection, last = p.pairing, unsettled = last && ['sending', 'unknown', 'bind-failed'].includes(last.state);
  const tone = c.state === 'connected' && !c.renewal ? 'success' : ['owned-by-other', 'stale'].includes(c.state) || c.expired ? 'danger' : 'warning';
  return `<div class="connection"><span class="badge ${tone}">${escape(connectionLabels[c.state] ?? c.state)}</span>
    ${c.state === 'connected' ? `<span class="muted">${escape(p.control?.controller)}${p.control?.expiresAt ? ` · 사람 응답 채널 만료 ${escape(date(p.control.expiresAt))}` : ''}</span>` : ''}
    ${c.state !== 'connected' || c.renewal ? `<small>${escape(c.message)}</small>` : ''}
    ${c.canTrust ? '<button type="button" class="trust-pc">PC 신뢰</button>' : ''}
    ${c.command ? `<small>${c.canTrust ? '또는 ' : ''}터미널(PC당 1회): <code>${escape(c.command)}</code></small>` : ''}
    ${last?.state === 'failed' ? `<small class="error">마지막 연결 실패: ${escape(last.error?.message ?? last.error?.code)}</small>` : ''}
    ${unsettled ? `<small class="error">연결 결과 ${last.state === 'bind-failed' ? 'DB 등록 실패' : '미확인'}${last.error ? `: ${escape(last.error.message)}` : ''}</small><button type="button" class="retry-pairing" data-id="${escape(last.id)}">같은 접수 번호로 연결 결과 확인</button>`
      : c.canPair ? `<button type="button" class="pair-project" data-id="${escape(p.id)}">${['connected', 'stale'].includes(c.state) ? '다시 연결' : '제어 연결'}</button>` : ''}</div>`;
}
const hostNames = { claude: 'Claude', codex: 'Codex' };
const otherHost = host => host === 'claude' ? 'codex' : 'claude';
// 요청의 실행 host — 개발 host와 master 계획·판단을 함께 정한다. host 없이 접수된 요청은 계획·판단 provider만 기록돼 있다
const hostLabel = (execution, provider) => !execution ? `개발 host 프로젝트 설정 · 계획·판단 ${hostNames[provider] ?? provider ?? 'Claude'}`
  : execution.mode === 'both' ? `${hostNames[execution.main]} 주 · ${hostNames[otherHost(execution.main)]} 교차 검증` : `${hostNames[execution.mode]} 단독`;
let latest, inFlight = false, timer;

function render() {
  if (!latest) return;
  const { projects, missions, counts } = latest;
  $('metrics').innerHTML = [[counts.projects, '등록 프로젝트'], [counts.activeMissions, '진행 중 목표'], [counts.attention, '판단·점검 필요 프로젝트'], [counts.unavailable, '조회 오류·오래된 관측']]
    .map(([value, label]) => `<article class="metric"><span>${label}</span><strong>${value}</strong></article>`).join('');
  const query = $('search').value.toLocaleLowerCase(), filter = $('filter').value;
  const visible = projects.filter(p => `${p.name} ${p.id} ${p.path} ${p.work?.id ?? ''}`.toLocaleLowerCase().includes(query) &&
    (filter === 'all' || filter === 'attention' && attention(p) || filter === 'unavailable' && unavailable(p) || filter === 'working' && p.work));
  $('project-count').textContent = `${visible.length} / ${projects.length}`;
  const openProjects = new Set([...document.querySelectorAll('#projects details[open]')].map(e => e.dataset.id));
  $('projects').innerHTML = visible.map(p => `<article class="project">
    <div class="card-head"><h3>${escape(p.name || p.id)}</h3>${badge(p.observation.status)}</div>
    <div class="card-actions"><button type="button" class="project-request" data-id="${escape(p.id)}">이 프로젝트에 요청</button><button type="button" class="delete-project danger-button" data-id="${escape(p.id)}">프로젝트 삭제</button></div>
    <p class="path">${escape(p.path)}</p>
    ${connectionView(p)}
    <div class="work"><span class="muted">${p.observation.historical || p.observation.stale ? '마지막 관측 작업' : '현재 관측 작업'}</span><strong>${escape(p.work?.id ?? (p.observation.status === 'observed' ? '작업 없음' : '확인되지 않음'))}</strong><span>${escape([p.work?.phase, p.work?.stage, p.work?.task].filter(Boolean).join(' / ') || '—')}</span></div>
    <div class="chips">${p.resume ? badge(p.resume.code) : ''}${p.observation.stale ? '<span class="badge warning">오래됨·미조회</span>' : ''}${p.observation.historical && p.work ? '<span class="badge warning">이전 관측</span>' : ''}</div>
    <p class="muted">관측 ${escape(date(p.observation.observedAt))}<br>조회 시도 ${escape(date(p.observation.checkedAt))}</p>
    ${p.observation.error ? `<p class="error">${escape(p.observation.error)}</p>` : ''}
    ${(p.requests ?? []).filter(r => r.state === 'failed' || r.issues.length).map(r => `<p class="error">${escape(r.taskNumber ?? r.id)} · ${escape(r.error || '실행 준비 필요 — 공통 요청함에서 확인하세요.')}<small>${r.issues.map(i => escape(i.message)).join('<br>')}</small></p>`).join('')}
    <div class="waiting"><span>승인 대기 <b>${p.consents.length}</b></span><span>답변 대기 <b>${p.questions.length}</b></span><span>임대 <b>${escape(p.lease || '미확인')}</b></span></div>
    <details data-id="${escape(p.id)}" ${openProjects.has(p.id) ? 'open' : ''}><summary>작업·판단 상세</summary>
      <p>프로젝트 ID: ${escape(p.id)}</p><p>제어 연결: ${p.control ? `${escape(p.control.controller)} (등록 당시 ${p.control.owner ? '소유자' : '관찰자'})` : '없음'}</p>
      ${p.connection.guidance ? `<p class="muted">${escape(p.connection.guidance)}</p>` : ''}
      ${p.connection.managedHost ? `<p>기본 개발 호스트(요청에서 host를 고르지 않을 때): ${escape(p.connection.managedHost.selected ?? '미확인')} · ${p.connection.managedHost.ready === false ? `준비 안 됨 ${escape(p.connection.managedHost.problems.map(x => x.message || x.code).join(' / '))}` : p.connection.managedHost.ready ? '준비됨' : '준비 상태 미확인'}</p>
      <p>요청별 host 선택: ${p.connection.managedHost.runSelection?.supported ? escape(p.connection.managedHost.runSelection.modes.join(' · ') || '고를 수 있는 host 없음') : '지원하지 않음 — code-agent 업데이트 필요'}</p>` : ''}
      ${renderStageDetails(p.stages)}
      ${p.resume?.reasons.map(r => `<p>${escape(r)}</p>`).join('') ?? ''}
      ${p.consents.map(c => `<p>승인: ${escape(c.action)} · ${escape(c.id)}</p>`).join('')}
      ${p.questions.map(q => `<p>${q.status === 'unverified' ? '답변 검증 대기' : '답변 대기'}: ${escape(q.id)}</p>`).join('')}
      ${p.findings ? `<p>리뷰 지적 ${escape(p.findings.open)} · 차단 ${escape(p.findings.blocking)} · 사람 판단 ${escape(p.findings.humanDecision)}</p>` : ''}
      ${p.unknown.map(u => `<p class="muted">미확인: ${escape(u)}</p>`).join('')}
      ${p.lock ? `<p>master 잠금: ${escape(p.lock.missionId)}</p>` : ''}
      ${p.tasks.map(t => `<p>${badge(t.status)} ${escape(t.taskId)} · ${t.mode === 'simulation' ? '모의' : '실제'} · ${escape(t.missionGoal)}</p>`).join('')}
    </details>
  </article>`).join('') || `<div class="empty">${projects.length ? '조건에 맞는 프로젝트가 없습니다.' : '등록된 프로젝트가 없습니다. 프로젝트 수동 등록으로 기존 폴더를 추가하세요.'}</div>`;
  const open = new Set([...document.querySelectorAll('#missions details[open]')].map(e => e.dataset.id));
  $('missions').innerHTML = missions.map(m => `<details class="mission" data-id="${escape(m.id)}" ${open.has(m.id) ? 'open' : ''}>
    <summary><span>${escape(m.goal)} <small>${m.mode === 'simulation' ? '모의 실행' : '실제 실행'}</small></span>${badge(m.status)}</summary>
    <p class="muted">${escape(m.id)} · 마지막 진행 ${escape(date(m.lastProgressAt))}</p>
    ${m.error ? `<p class="error">${escape(m.error)}</p>` : ''}
    ${['blocked', 'setup-required'].includes(m.status) ? `<p class="error">${escape(m.reason)}</p>` : ''}
    <div class="table-wrap"><table><thead><tr><th>작업 / 프로젝트</th><th>상태</th><th>단계 / 실행 호스트</th><th>사유 / 다음 행동</th><th>마지막 진행</th></tr></thead><tbody>${m.tasks.map(t => `<tr><td>${escape(t.taskId)}<small>${escape(t.projectId)}</small></td><td>${badge(t.status)}</td><td>${escape(t.phase ?? '—')}<small>${escape(t.executionHost ?? '호스트 확인 전')}</small></td><td>${escape(t.reason)}<small>${escape(t.nextAction)}</small></td><td>${escape(date(t.lastProgressAt))}</td></tr>`).join('')}</tbody></table></div>
    <h3>최근 이벤트</h3><ol class="events">${m.events.map(e => `<li><time>${escape(date(e.at))}</time> ${escape(e.type)} ${escape(e.taskId)}</li>`).join('') || '<li>기록 없음</li>'}</ol>
  </details>`).join('') || '<div class="empty">등록된 목표가 없습니다.</div>';
  renderManagement();
  renderUpdates();
  renderInteractions(latest, post, refresh, { pair: openPairing });
  renderHistory(latest);
}

async function refresh() {
  if (inFlight) return;
  inFlight = true; clearTimeout(timer); $('refresh').disabled = true;
  try {
    const response = await fetch('/api/overview', { signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    latest = await response.json(); render();
    if ($('project-dialog').open) void loadCandidates();
    $('connection').textContent = `연결됨 · ${date(latest.generatedAt)}`;
    $('notice').className = 'notice';
    $('notice').textContent = latest.live ? `설치된 code-agent 연결됨 · 조회 완료 후 ${latest.intervalMs / 1000}초 간격${latest.refreshing ? ' · 조회 중' : ''}` :
      latest.discovery === 'not-found' ? '설치된 code-agent를 찾지 못했습니다. 설치와 PATH를 확인하세요. 현재는 저장된 관측을 표시합니다.' : '저장된 관측을 표시합니다. 자동 조회는 --saved 없이 dashboard를 실행하세요.';
  } catch (error) {
    $('connection').textContent = '연결 끊김'; $('notice').className = 'notice error';
    $('notice').textContent = `대시보드 서버에 연결할 수 없습니다 (${error.message}). 아래 내용은 마지막 수신 화면입니다.`;
  } finally { inFlight = false; $('refresh').disabled = false; timer = setTimeout(refresh, latest?.intervalMs ?? 5000); }
}
$('search').addEventListener('input', render); $('filter').addEventListener('change', render);
$('refresh').addEventListener('click', refresh);
void refresh();

let editingGroup = null, deletingProject = null, deletingGroup = null, requestKey, requestGroupRevision;
let groupDrafts = [], projectInGroup = false, editingDraftId = null, projectDraftId;
let candidates = [], candidateLoading = false, candidateInfo = '';
function renderCandidates() {
  const query = $('candidate-search').value.trim().toLocaleLowerCase();
  const visible = candidates.filter(p => `${p.name} ${p.path}`.toLocaleLowerCase().includes(query));
  $('candidate-list').innerHTML = visible.map(p => {
    const staged = groupDrafts.some(d => d.path === p.path && d.id !== editingDraftId);
    return `<button type="button" class="candidate-pick" data-path="${escape(p.path)}" ${p.registeredId || staged ? 'disabled' : ''}><strong>${escape(p.name)}</strong><span>${p.registeredId ? '이미 등록됨 · 그룹의 소속 목록에서 선택' : staged ? '이 그룹에 등록 예정' : '선택'}</span><small class="path">${escape(p.path)}</small></button>`;
  }).join('') || `<p class="muted">${candidateLoading ? '설치된 프로젝트를 확인하고 있습니다.' : '표시할 프로젝트가 없습니다. 경로를 직접 입력해 등록할 수 있습니다.'}</p>`;
  $('candidate-status').textContent = candidateLoading ? '목록 조회 중…' : `${visible.length}개 표시${candidateInfo}`;
}
async function loadCandidates() {
  if (candidateLoading) return;
  candidateLoading = true; $('candidate-refresh').disabled = true; renderCandidates();
  try {
    const result = await post('/api/project-candidates', {});
    candidates = result.projects;
    candidateInfo = result.truncated ? ' · 조회 한도에 도달해 일부만 표시합니다. 없는 경로는 직접 입력하세요.' : ' · 알려진 작업 위치의 설치 표시 기준 · 자동 갱신';
  } catch (error) { candidateInfo = ` · 조회 실패: ${error.message}. 경로를 직접 입력할 수 있습니다.`; }
  finally { candidateLoading = false; $('candidate-refresh').disabled = false; renderCandidates(); }
}
async function post(path, body) {
  const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Master-Token': latest.token }, body: JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) throw Object.assign(new Error(result.message ?? result.error), { code: result.error });
  return result;
}
// Pairing happens only here: an explicit confirmation with a required checkbox and no default choice.
let pairing = null;
function openPairing(projectId) {
  if (pairing && !pairing.busy) pairing.resolve(false);
  return new Promise(resolve => {
    pairing = { projectId, preview: null, commandId: crypto.randomUUID(), resolve, done: false, busy: false };
    $('pair-project').textContent = latest.projects.find(p => p.id === projectId)?.name ?? projectId;
    $('pair-confirm').checked = false; $('pair-error').textContent = ''; $('pair-guidance').textContent = '';
    $('pair-lines').textContent = '연결 내용을 확인하고 있습니다…'; updatePairSubmit();
    if (!$('pair-dialog').open) $('pair-dialog').showModal();
    void loadPairing();
  });
}
async function loadPairing() {
  const current = pairing;
  try {
    const preview = await post('/api/projects/pair/preview', { projectId: current.projectId });
    if (pairing !== current) return;
    current.preview = preview; $('pair-lines').textContent = preview.lines.join('\n');
    $('pair-guidance').textContent = preview.canPair ? '' : `${preview.message} ${preview.guidance}${preview.command ? `\n${preview.command}` : ''}`;
  } catch (error) { if (pairing === current) $('pair-error').textContent = error.message; }
  updatePairSubmit();
}
function updatePairSubmit() { $('pair-submit').disabled = !pairing?.preview?.canPair || !$('pair-confirm').checked || pairing.busy; }
$('pair-confirm').addEventListener('change', updatePairSubmit);
$('pair-dialog').addEventListener('close', () => { if (pairing && !pairing.busy) { pairing.resolve(pairing.done); pairing = null; } });
$('pair-form').addEventListener('submit', async event => {
  event.preventDefault();
  const current = pairing; if (!current?.preview || current.busy) return;
  current.busy = true; updatePairSubmit(); $('pair-error').textContent = '연결 중…';
  try {
    const receipt = await post('/api/projects/pair', { projectId: current.projectId, projectRevision: current.preview.projectRevision, commandId: current.commandId,
      confirmed: $('pair-confirm').checked, shownHash: current.preview.shownHash });
    if (receipt.state === 'paired') {
      current.done = true; current.busy = false; $('pair-dialog').close();
      $('action-status').textContent = `제어 연결을 등록했습니다(${receipt.outcome === 'rotated' ? '토큰 갱신' : '연동 켬'}${receipt.expiresAt ? ` · 사람 응답 채널 만료 ${date(receipt.expiresAt)}` : ''}).`;
      await refresh(); return;
    }
    $('pair-error').textContent = ['unknown', 'sending'].includes(receipt.state) ? '연결 결과를 확인하지 못했습니다. 다시 누르면 같은 접수 번호로 결과를 확인합니다.'
      : receipt.state === 'bind-failed' ? `code-agent는 연결했지만 DB 등록에 실패했습니다: ${receipt.error?.message ?? ''} 다시 누르면 등록만 다시 시도합니다.` : receipt.error?.message ?? receipt.state;
  } catch (error) {
    if (error.code === 'stale-state' && pairing === current) {
      current.commandId = crypto.randomUUID(); current.preview = null; $('pair-confirm').checked = false;
      $('pair-error').textContent = `${error.message} 최신 내용을 다시 불러왔습니다.`; void loadPairing();
    } else $('pair-error').textContent = error.message;
  } finally {
    current.busy = false; updatePairSubmit();
    if (pairing === current && !$('pair-dialog').open) { current.resolve(current.done); pairing = null; }
  }
});
// PC trust happens only here: code-agent's own confirmation text, the typed word trust and no default.
let trusting = null;
function openTrust() {
  trusting = { preview: null, busy: false };
  $('trust-word').value = ''; $('trust-error').textContent = ''; $('trust-guidance').textContent = '';
  $('trust-lines').textContent = '신뢰 내용을 확인하고 있습니다…'; updateTrustSubmit();
  if (!$('trust-dialog').open) $('trust-dialog').showModal();
  void loadTrust();
}
async function loadTrust() {
  const current = trusting;
  try {
    const preview = await post('/api/trust/preview', {});
    if (trusting !== current) return;
    current.preview = preview; $('trust-lines').textContent = preview.lines.join('\n');
    $('trust-guidance').textContent = preview.canTrust ? '' : preview.reason ?? '이 PC에서는 새로 신뢰할 수 없습니다.';
  } catch (error) { if (trusting === current) $('trust-error').textContent = error.message; }
  updateTrustSubmit();
}
function updateTrustSubmit() { $('trust-submit').disabled = !trusting?.preview?.canTrust || $('trust-word').value !== 'trust' || trusting.busy; }
$('trust-word').addEventListener('input', updateTrustSubmit);
$('trust-dialog').addEventListener('close', () => { if (trusting && !trusting.busy) trusting = null; });
$('trust-form').addEventListener('submit', async event => {
  event.preventDefault();
  const current = trusting; if (!current?.preview || current.busy) return;
  current.busy = true; updateTrustSubmit(); $('trust-error').textContent = '등록 중…';
  try {
    const result = await post('/api/trust', { shownHash: current.preview.shownHash, word: $('trust-word').value });
    current.busy = false; $('trust-dialog').close();
    $('action-status').textContent = `이 PC가 대시보드 제어자를 신뢰합니다(지문 ${result.fingerprint}). 연결 상태를 다시 확인한 뒤 프로젝트 카드의 제어 연결로 연결하세요.`;
    await refresh(); return;
  } catch (error) {
    if (error.code === 'stale-state' && trusting === current) {
      current.preview = null; $('trust-word').value = '';
      $('trust-error').textContent = `${error.message} 최신 내용을 다시 불러왔습니다.`; void loadTrust();
    } else $('trust-error').textContent = error.message;
  } finally {
    current.busy = false; updateTrustSubmit();
    if (trusting === current && !$('trust-dialog').open) trusting = null;
  }
});
function renderManagement() {
  $('groups').innerHTML = latest.groups.map(g => `<article class="project group-card"><div class="card-head"><h3>${escape(g.name)}</h3><span class="badge">${g.projectIds.length}개 프로젝트</span></div>
    <p>${escape(g.description || '서비스 범위 설명 없음')}</p><p class="muted">${escape(g.projectIds.map(id => latest.projects.find(p => p.id === id)?.name ?? id).join(' · ') || '소속 프로젝트 없음')}</p>
    <div class="card-actions"><button type="button" class="edit-group" data-id="${escape(g.id)}">구성 편집</button><button type="button" class="group-request" data-id="${escape(g.id)}" ${g.projectIds.length ? '' : 'disabled'}>그룹에 요청</button><button type="button" class="delete-group danger-button" data-id="${escape(g.id)}">그룹 삭제</button></div></article>`).join('') || '<div class="empty">서비스 그룹을 만들고 유지보수할 프로젝트를 선택하세요.</div>';
  $('requests').innerHTML = [...latest.requests].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(r => `<article class="mission"><div class="card-head"><h3>${escape(r.goal)}</h3>${badge(r.state === 'waiting' ? r.progress ?? 'waiting' : r.state)}</div>
    <p>${r.targetType === 'group' ? '그룹' : '프로젝트'} ${escape(r.targetId)} · ${escape(r.projectIds.join(', '))}</p>
    ${r.taskNumber ? `<p>TASK: <strong>${escape(r.taskNumber)}</strong></p>` : ''}
    <p>host: ${escape(hostLabel(r.execution, r.provider))}</p>
    <p class="muted">${escape(r.id)} · ${escape(date(r.updatedAt))}</p>
    ${r.state === 'waiting' ? `<p>${escape(r.reason)}</p>` : ''}
    ${r.error ? `<p class="error">${escape(r.error.message)}</p>` : ''}${r.blockers.length ? `<p>${escape(r.blockers.join(' · '))}</p>` : ''}
    ${r.preparation?.state === 'waiting' ? '<p>공통 요청함에서 필요한 준비와 재점검 방법을 확인하세요.</p>' : ''}
    ${['waiting', 'failed', 'interrupted', 'queued'].includes(r.state) ? `<button type="button" class="continue-request" data-id="${escape(r.id)}">보완 후 이어 실행</button>` : ''}</article>`).join('') || '<div class="empty">그룹 또는 프로젝트에 유지보수 요청을 보내세요.</div>';
}
function openGroup(id) {
  editingGroup = latest.groups.find(g => g.id === id) ?? null;
  groupDrafts = [];
  $('group-form').reset(); $('group-error').textContent = '';
  $('group-title').textContent = editingGroup ? '서비스 그룹 편집' : '서비스 그룹 만들기';
  $('group-composition').hidden = !editingGroup;
  $('group-create-help').hidden = Boolean(editingGroup);
  $('group-id').value = editingGroup?.id ?? ''; $('group-id').disabled = Boolean(editingGroup);
  $('group-name').value = editingGroup?.name ?? ''; $('group-description').value = editingGroup?.description ?? '';
  $('group-members').innerHTML = editingGroup ? latest.projects.map(p => `<label class="member"><input type="checkbox" name="member" value="${escape(p.id)}" ${editingGroup.projectIds.includes(p.id) ? 'checked' : ''}>${escape(p.name || p.id)}</label>`).join('') || '<p>아래 버튼으로 이 그룹에 새 프로젝트를 등록하세요.</p>' : '';
  renderDrafts();
  $('group-dialog').showModal();
}
function renderDrafts() {
  $('group-drafts').innerHTML = groupDrafts.map(p => `<article class="project-draft"><strong>${escape(p.name)}</strong><span class="badge">등록 예정</span><p class="path">${escape(p.path)}</p><button type="button" class="edit-draft" data-id="${escape(p.id)}">수정</button> <button type="button" class="remove-draft" data-id="${escape(p.id)}">제외</button></article>`).join('');
}
function openProject(inGroup, id) {
  projectInGroup = inGroup; editingDraftId = id ?? null;
  const draft = groupDrafts.find(p => p.id === id);
  projectDraftId = draft?.id ?? crypto.randomUUID();
  $('project-form').reset(); $('project-error').textContent = '';
  $('project-name').value = draft?.name ?? ''; $('project-path').value = draft?.path ?? '';
  $('project-domains').value = draft?.domains.join(', ') ?? ''; $('project-id').value = draft?.id ?? '';
  $('project-constraints').value = draft?.constraints.join('\n') ?? ''; $('project-references').value = draft?.references.join('\n') ?? '';
  $('project-submit').textContent = inGroup ? '그룹에 추가 예정으로 담기' : '프로젝트 등록';
  $('project-dialog').showModal();
  $('candidate-search').value = ''; void loadCandidates();
}
function openDeleteProject(id) {
  deletingProject = latest.projects.find(p => p.id === id);
  if (!deletingProject) return;
  $('delete-project-name').textContent = `${deletingProject.name} (${deletingProject.id})`;
  $('delete-project-path').textContent = deletingProject.path;
  const groups = latest.groups.filter(g => g.projectIds.includes(id));
  $('delete-project-groups').textContent = `함께 제외할 그룹: ${groups.map(g => g.name).join(' · ') || '없음'}`;
  $('delete-project-error').textContent = '';
  $('delete-project-dialog').showModal();
}
function openDeleteGroup(id) {
  deletingGroup = latest.groups.find(g => g.id === id);
  if (!deletingGroup) return;
  $('delete-group-name').textContent = `${deletingGroup.name} (${deletingGroup.id})`;
  $('delete-group-members').textContent = `등록을 유지할 프로젝트: ${deletingGroup.projectIds.map(pid => latest.projects.find(p => p.id === pid)?.name ?? pid).join(' · ') || '없음'}`;
  $('delete-group-error').textContent = '';
  $('delete-group-dialog').showModal();
}
function requestProjectIds() {
  const type = $('request-type').value, id = $('request-target').value;
  return type === 'group' ? latest.groups.find(g => g.id === id)?.projectIds ?? [] : id ? [id] : [];
}
function requestHost() {
  const mode = $('request-host').value;
  return mode === 'both' ? { mode, main: $('request-main').value } : { mode };
}
/** 프로젝트가 고르지 않은 실행에 쓰는 실행 방식 — 대상이 모두 같으면 그 값을, 아니면 Claude 단독을 처음 값으로 둔다 */
function defaultHost(ids) {
  const own = id => {
    const host = latest.projects.find(p => p.id === id)?.connection?.managedHost;
    if (host?.execution?.mode === 'both') return { mode: 'both', main: host.execution.main ?? host.selected ?? 'claude' };
    if (['claude', 'codex'].includes(host?.execution?.mode)) return { mode: host.execution.mode };
    return ['claude', 'codex'].includes(host?.selected) ? { mode: host.selected } : null;
  };
  const choices = ids.map(own), first = choices[0];
  return first && choices.every(c => c && c.mode === first.mode && c.main === first.main) ? first : { mode: 'claude' };
}
function hostChanged() {
  const host = requestHost(), main = host.mode === 'both' ? host.main : host.mode;
  $('request-main-field').hidden = host.mode !== 'both';
  $('request-host-help').textContent = host.mode === 'both'
    ? `${hostNames[main]}가 개발과 master 계획·판단을 맡고 ${hostNames[otherHost(main)]}가 계획·코드 리뷰와 판단을 교차 검증합니다. 검토에서 반려된 계획·판단은 실행하지 않고 다시 만들거나 사람에게 넘깁니다.`
    : `이번 요청의 개발과 master 계획·판단을 ${hostNames[main]}가 혼자 맡습니다. 교차 검증은 하지 않습니다.`;
  $('request-host-projects').innerHTML = requestProjectIds().map(id => {
    const p = latest.projects.find(p => p.id === id), managed = p?.connection?.managedHost, state = managed?.hosts?.[main];
    const status = !managed ? '제어 연결 상태 미확인 — 접수 후 준비 점검에서 확인합니다'
      : !managed.runSelection?.supported ? '요청별 host 선택 미지원 — 프로젝트에서 code-agent 업데이트가 필요합니다'
      : !managed.runSelection.modes.includes(host.mode) ? '이 host가 설치되어 있지 않습니다 — code-agent init으로 두 host를 준비하세요'
      : state?.ready === false ? `${hostNames[main]} 준비 안 됨: ${state.problems.map(x => x.message || x.code).join(' / ')}` : '선택 가능';
    const ok = status === '선택 가능';
    return `<p class="${ok ? 'muted' : 'error'}">${escape(p?.name ?? id)} · ${escape(status)}</p>`;
  }).join('');
}
function scopeChanged() {
  const type = $('request-type').value, id = $('request-target').value;
  const group = latest.groups.find(g => g.id === id);
  requestGroupRevision = type === 'group' ? group?.revision : undefined;
  const ids = requestProjectIds();
  $('request-scope').textContent = `대상 프로젝트: ${ids.map(id => latest.projects.find(p => p.id === id)?.name ?? id).join(' · ') || '없음'}`;
  const host = defaultHost(ids);
  $('request-host').value = host.mode; if (host.main) $('request-main').value = host.main;
  hostChanged();
}
function requestTargets(id) {
  const entries = $('request-type').value === 'group' ? latest.groups.filter(g => g.projectIds.length) : latest.projects;
  $('request-target').innerHTML = entries.map(e => `<option value="${escape(e.id)}">${escape(e.name || e.id)}</option>`).join('');
  if (id) $('request-target').value = id;
  scopeChanged();
}
function openRequest(type = 'group', id) {
  $('request-form').reset(); $('request-error').textContent = ''; requestKey = crypto.randomUUID();
  $('request-type').value = type; requestTargets(id); $('request-dialog').showModal();
}
$('new-group').addEventListener('click', () => latest && openGroup());
$('new-project').addEventListener('click', () => latest && openProject(false));
$('group-new-project').addEventListener('click', () => openProject(true));
$('candidate-refresh').addEventListener('click', loadCandidates);
$('candidate-search').addEventListener('input', renderCandidates);
$('new-request').addEventListener('click', () => latest && openRequest());
$('request-type').addEventListener('change', () => requestTargets());
$('request-target').addEventListener('change', scopeChanged);
$('request-host').addEventListener('change', hostChanged);
$('request-main').addEventListener('change', hostChanged);
document.addEventListener('click', async event => {
  const button = event.target.closest('button'); if (!button) return;
  if (button.dataset.close) $(button.dataset.close).close();
  if (button.classList.contains('edit-group')) openGroup(button.dataset.id);
  if (button.classList.contains('group-request')) openRequest('group', button.dataset.id);
  if (button.classList.contains('project-request')) openRequest('project', button.dataset.id);
  if (button.classList.contains('delete-project')) openDeleteProject(button.dataset.id);
  if (button.classList.contains('delete-group')) openDeleteGroup(button.dataset.id);
  if (button.classList.contains('edit-draft')) openProject(true, button.dataset.id);
  if (button.classList.contains('candidate-pick') && !button.disabled) {
    const project = candidates.find(p => p.path === button.dataset.path);
    if (project) {
      $('project-name').value = project.name; $('project-path').value = project.path;
      $('project-error').textContent = ''; $('project-domains').focus();
    }
  }
  if (button.classList.contains('remove-draft')) { groupDrafts = groupDrafts.filter(p => p.id !== button.dataset.id); renderDrafts(); }
  if (button.classList.contains('pair-project')) void openPairing(button.dataset.id);
  if (button.classList.contains('trust-pc')) openTrust();
  if (button.classList.contains('retry-pairing')) {
    button.disabled = true;
    try { const receipt = await post('/api/projects/pair/retry', { commandId: button.dataset.id }); $('action-status').textContent = receipt.state === 'paired' ? '제어 연결을 등록했습니다.' : `연결 결과: ${receipt.state} ${receipt.error?.message ?? ''}`; await refresh(); }
    catch (error) { $('action-status').textContent = error.message; } finally { button.disabled = false; }
  }
  if (button.classList.contains('continue-request')) {
    button.disabled = true;
    try { const r = latest.requests.find(r => r.id === button.dataset.id); await post('/api/requests/continue', { id: r.id, revision: r.revision }); $('action-status').textContent = '기존 대상과 목표에서 이어 실행합니다.'; await refresh(); }
    catch (error) { $('action-status').textContent = error.message; } finally { button.disabled = false; }
  }
});
$('delete-project-form').addEventListener('submit', async event => {
  event.preventDefault(); const button = event.submitter; button.disabled = true;
  try {
    await post('/api/projects/delete', { id: deletingProject.id, revision: deletingProject.revision });
    $('delete-project-dialog').close();
    $('action-status').textContent = '프로젝트 등록을 해제하고 그룹에서 제외했습니다. 프로젝트 폴더와 이전 요청 이력은 보존됩니다.';
    await refresh();
  } catch (error) { $('delete-project-error').textContent = error.message; } finally { button.disabled = false; }
});
$('delete-group-form').addEventListener('submit', async event => {
  event.preventDefault(); const button = event.submitter; button.disabled = true;
  try {
    await post('/api/groups/delete', { id: deletingGroup.id, revision: deletingGroup.revision });
    $('delete-group-dialog').close();
    $('action-status').textContent = '그룹을 삭제했습니다. 프로젝트 등록과 기존 요청·실행은 유지됩니다.';
    await refresh();
  } catch (error) { $('delete-group-error').textContent = error.message; } finally { button.disabled = false; }
});
$('group-form').addEventListener('submit', async event => {
  event.preventDefault(); const button = event.submitter; button.disabled = true;
  try {
    const group = { id: $('group-id').value.trim(), name: $('group-name').value.trim(), description: $('group-description').value,
      projectIds: editingGroup ? [...document.querySelectorAll('#group-members input:checked')].map(e => e.value).concat(groupDrafts.map(p => p.id)) : [] };
    await post('/api/groups', { group, revision: editingGroup?.revision ?? 0, newProjects: groupDrafts });
    $('group-dialog').close(); $('action-status').textContent = '그룹 구성을 저장했습니다.'; await refresh();
  } catch (error) { $('group-error').textContent = error.message; } finally { button.disabled = false; }
});
$('project-form').addEventListener('submit', async event => {
  event.preventDefault(); const button = event.submitter; button.disabled = true;
  const lines = value => [...new Set(value.split('\n').map(s => s.trim()).filter(Boolean))];
  try {
    const project = { id: $('project-id').value.trim() || projectDraftId, name: $('project-name').value.trim(), path: $('project-path').value.trim(),
      domains: [...new Set($('project-domains').value.split(',').map(s => s.trim()).filter(Boolean))],
      constraints: lines($('project-constraints').value), references: lines($('project-references').value) };
    if (!project.name || !project.path || !project.domains.length) throw new Error('이름·폴더 경로·담당 업무를 입력하세요.');
    if (projectInGroup) {
      if (latest.projects.some(p => p.id === project.id) || groupDrafts.some(p => p.id === project.id && p.id !== editingDraftId)) throw new Error('이미 사용 중인 프로젝트 ID입니다. 기존 프로젝트는 소속 목록에서 선택하세요.');
      groupDrafts = groupDrafts.filter(p => p.id !== editingDraftId).concat(project);
      renderDrafts(); $('project-dialog').close();
    } else {
      await post('/api/projects', { project });
      $('project-dialog').close(); $('action-status').textContent = '프로젝트를 등록했습니다. 그룹 구성 편집에서 포함할 수 있습니다.'; await refresh();
    }
  } catch (error) { $('project-error').textContent = error.message; } finally { button.disabled = false; }
});
$('request-form').addEventListener('submit', async event => {
  event.preventDefault(); const button = event.submitter; button.disabled = true;
  try {
    const config = $('request-config').value.trim() ? JSON.parse($('request-config').value) : {};
    const request = await post('/api/requests', { targetType: $('request-type').value, targetId: $('request-target').value,
      ...($('request-task-number').value.trim() ? { taskNumber: $('request-task-number').value.trim() } : {}),
      groupRevision: requestGroupRevision, requestKey, goal: $('request-goal').value.trim(), host: requestHost(),
      criteria: config.criteria ?? $('request-criteria').value.split('\n').map(s => s.trim()).filter(Boolean).map((description, i) => ({ id: `criterion-${i + 1}`, description })), templates: config.templates ?? [] });
    $('request-dialog').close(); $('action-status').textContent = `요청을 접수했습니다: ${request.id}`; await refresh();
  } catch (error) { $('request-error').textContent = error.message; } finally { button.disabled = false; }
});

let updatePlan;
const preparationLabels = { clone: '소스 사본 준비', pull: '원격 변경 받기', install: '의존성 설치', build: '빌드', reuse: '같은 커밋 빌드 재사용', verify: '실행 검사', test: '테스트', validate: '실행 버전 검증' };
function preparationView(batch, open) {
  if (!batch.source) return '';
  return `<p>원격 ${escape(batch.source.remote)} · ${escape(batch.source.ref)}${batch.source.commit ? ` · 커밋 ${escape(batch.source.commit)}` : ''}</p>` +
    (batch.preparation ? `<p>${escape(preparationLabels[batch.preparation.phase])} · ${badge(batch.state === 'interrupted' ? 'interrupted' : batch.preparation.state)}</p>` : '') +
    (batch.preparation?.steps ?? []).map(step => `<div><small>${escape(preparationLabels[step.phase])} · ${escape(labels[step.state] ?? step.state)}</small>${step.output ? `<details data-output="${escape(`${batch.id}/prepare/${step.phase}`)}" ${open.has(`${batch.id}/prepare/${step.phase}`) ? 'open' : ''}><summary>단계 출력</summary><pre>${escape(step.output)}</pre></details>` : ''}</div>`).join('');
}
const updateTable = (projects, batchId = '', open = new Set()) => `<table><thead><tr><th>프로젝트</th><th>현재 버전</th><th>상태·결과</th></tr></thead><tbody>${projects.map(p => `<tr><td>${escape(p.name)}<small class="path">${escape(p.path)}</small></td><td>${escape(p.current ?? '미확인')}</td><td>${badge(p.state)}<small>${escape(p.detail)}</small>${p.output ? `<details data-output="${escape(`${batchId}/${p.id}`)}" ${open.has(`${batchId}/${p.id}`) ? 'open' : ''}><summary>명령 출력</summary><pre>${escape(p.output)}</pre></details>` : ''}</td></tr>`).join('')}</tbody></table>`;
function renderUpdates() {
  const updates = latest.updates ?? { batches: [], maintenance: [] };
  const open = new Set([...document.querySelectorAll('#updates details[open][data-id]')].map(e => e.dataset.id));
  const outputs = new Set([...document.querySelectorAll('#updates details[open][data-output]')].map(e => e.dataset.output));
  $('updates').innerHTML = updates.maintenance.filter(r => r.recoverable).map(r => `<p class="error">${escape(r.id)}: 업데이트 중단 점검 필요 <button type="button" class="recover-update" data-id="${escape(r.id)}">종료·유휴 상태 확인 후 잠금 해제</button></p>`).join('') +
    updates.batches.map(b => `<details class="mission" data-id="${escape(b.id)}" ${open.has(b.id) || b.state === 'running' ? 'open' : ''}><summary><span>${escape(date(b.createdAt))} · 설치본 ${escape(b.target.version)}</span>${badge(b.state)}</summary>${preparationView(b, outputs)}${b.error ? `<p class="error">${escape(b.error)}</p>` : ''}<div class="table-wrap">${updateTable(b.projects, b.id, outputs)}</div></details>`).join('');
}
$('preview-updates').addEventListener('click', async () => {
  if (!latest) return;
  const button = $('preview-updates'); button.disabled = true; updatePlan = null;
  $('update-error').textContent = ''; $('update-preview').textContent = '버전과 작업 상태를 확인하고 있습니다…';
  $('update-target').textContent = ''; $('apply-updates').disabled = true; $('update-dialog').showModal();
  try {
    updatePlan = await post('/api/updates/preview', { mode: $('update-mode').value });
    $('update-target').textContent = updatePlan.source
      ? `현재 설치본 ${updatePlan.target.version} → ${updatePlan.source.remote}/${updatePlan.source.ref.replace('refs/heads/', '')}의 원격 버전을 받아 검증 후 적용합니다.${updatePlan.source.dirty ? ' 원본에 미커밋 변경이 있으며 그대로 보존합니다.' : ''}`
      : `적용할 설치본: ${updatePlan.target.version} (${updatePlan.target.fingerprint.slice(0, 12)})${updatePlan.target.resetsPin ? ' · 기존 릴리스 고정을 해제하고 현재 번들을 적용합니다.' : ' · 현재 설치 패키지 릴리스를 적용합니다.'}`;
    $('apply-updates').textContent = updatePlan.source ? '원격 받기·빌드·검증 후 일괄 적용' : '현재 설치본 일괄 적용';
    $('update-preview').innerHTML = updateTable(updatePlan.projects);
    $('apply-updates').disabled = !updatePlan.projects.some(p => p.state === 'ready');
  } catch (error) { $('update-preview').textContent = ''; $('update-error').textContent = error.message; }
  finally { button.disabled = false; }
});
$('apply-updates').addEventListener('click', async () => {
  if (!updatePlan) return;
  $('apply-updates').disabled = true;
  try {
    await post('/api/updates/apply', { id: updatePlan.id });
    $('update-dialog').close(); $('action-status').textContent = '일괄 업데이트를 시작했습니다. 아래에서 프로젝트별 결과를 확인하세요.';
    await refresh();
  } catch (error) { $('update-error').textContent = error.message; $('apply-updates').disabled = false; }
});
$('updates').addEventListener('click', async event => {
  const button = event.target.closest('.recover-update'); if (!button) return;
  button.disabled = true;
  try { const result = await post('/api/updates/recover', { id: button.dataset.id }); $('action-status').textContent = result.detail; await refresh(); }
  catch (error) { $('action-status').textContent = error.message; button.disabled = false; }
});
