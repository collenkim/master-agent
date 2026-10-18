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
  queued: '접수·시작 대기', failed: '실행 오류', interrupted: '실행기 중단',
};
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const date = value => value ? new Date(value).toLocaleString('ko-KR') : '기록 없음';
const attention = p => p.attention;
const unavailable = p => p.observation.status !== 'observed' || p.observation.stale;
const badge = status => `<span class="badge ${['blocked', 'human-input', 'process-error', 'timeout'].includes(status) ? 'danger' : ['completed', 'observed'].includes(status) ? 'success' : ''}">${escape(labels[status] ?? status)}</span>`;
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
    <button type="button" class="project-request" data-id="${escape(p.id)}">이 프로젝트에 요청</button>
    <p class="path">${escape(p.path)}</p>
    <div class="work"><span class="muted">${p.observation.historical || p.observation.stale ? '마지막 관측 작업' : '현재 관측 작업'}</span><strong>${escape(p.work?.id ?? (p.observation.status === 'observed' ? '작업 없음' : '확인되지 않음'))}</strong><span>${escape(p.work?.phase ?? '—')}</span></div>
    <div class="chips">${p.resume ? badge(p.resume.code) : ''}${p.observation.stale ? '<span class="badge warning">오래됨·미조회</span>' : ''}${p.observation.historical && p.work ? '<span class="badge warning">이전 관측</span>' : ''}</div>
    <p class="muted">관측 ${escape(date(p.observation.observedAt))}<br>조회 시도 ${escape(date(p.observation.checkedAt))}</p>
    ${p.observation.error ? `<p class="error">${escape(p.observation.error)}</p>` : ''}
    <div class="waiting"><span>승인 대기 <b>${p.consents.length}</b></span><span>답변 대기 <b>${p.questions.length}</b></span><span>임대 <b>${escape(p.lease || '미확인')}</b></span></div>
    <details data-id="${escape(p.id)}" ${openProjects.has(p.id) ? 'open' : ''}><summary>작업·판단 상세</summary>
      <p>프로젝트 ID: ${escape(p.id)}</p><p>제어 연결: ${p.control ? `${escape(p.control.controller)} (등록 당시 ${p.control.owner ? '소유자' : '관찰자'})` : '없음'}</p>
      ${p.resume?.reasons.map(r => `<p>${escape(r)}</p>`).join('') ?? ''}
      ${p.consents.map(c => `<p>승인: ${escape(c.action)} · ${escape(c.id)}</p>`).join('')}
      ${p.questions.map(q => `<p>${q.status === 'unverified' ? '답변 검증 대기' : '답변 대기'}: ${escape(q.id)}</p>`).join('')}
      ${p.findings ? `<p>리뷰 지적 ${escape(p.findings.open)} · 차단 ${escape(p.findings.blocking)} · 사람 판단 ${escape(p.findings.humanDecision)}</p>` : ''}
      ${p.unknown.map(u => `<p class="muted">미확인: ${escape(u)}</p>`).join('')}
      ${p.lock ? `<p>master 잠금: ${escape(p.lock.missionId)}</p>` : ''}
      ${p.tasks.map(t => `<p>${badge(t.status)} ${escape(t.taskId)} · ${t.mode === 'simulation' ? '모의' : '실제'} · ${escape(t.missionGoal)}</p>`).join('')}
    </details>
  </article>`).join('') || `<div class="empty">${projects.length ? '조건에 맞는 프로젝트가 없습니다.' : '등록된 프로젝트가 없습니다. master-agent project add &lt;JSON&gt;으로 등록하거나 --db 경로를 확인하세요.'}</div>`;
  const open = new Set([...document.querySelectorAll('#missions details[open]')].map(e => e.dataset.id));
  $('missions').innerHTML = missions.map(m => `<details class="mission" data-id="${escape(m.id)}" ${open.has(m.id) ? 'open' : ''}>
    <summary><span>${escape(m.goal)} <small>${m.mode === 'simulation' ? '모의 실행' : '실제 실행'}</small></span>${badge(m.status)}</summary>
    <p class="muted">${escape(m.id)} · 마지막 진행 ${escape(date(m.lastProgressAt))}</p>
    ${m.error ? `<p class="error">${escape(m.error)}</p>` : ''}
    <div class="table-wrap"><table><thead><tr><th>작업 / 프로젝트</th><th>상태</th><th>단계</th><th>사유 / 다음 행동</th><th>마지막 진행</th></tr></thead><tbody>${m.tasks.map(t => `<tr><td>${escape(t.taskId)}<small>${escape(t.projectId)}</small></td><td>${badge(t.status)}</td><td>${escape(t.phase ?? '—')}</td><td>${escape(t.reason)}<small>${escape(t.nextAction)}</small></td><td>${escape(date(t.lastProgressAt))}</td></tr>`).join('')}</tbody></table></div>
    <h3>최근 이벤트</h3><ol class="events">${m.events.map(e => `<li><time>${escape(date(e.at))}</time> ${escape(e.type)} ${escape(e.taskId)}</li>`).join('') || '<li>기록 없음</li>'}</ol>
  </details>`).join('') || '<div class="empty">등록된 목표가 없습니다.</div>';
  renderManagement();
}

async function refresh() {
  if (inFlight) return;
  inFlight = true; clearTimeout(timer); $('refresh').disabled = true;
  try {
    const response = await fetch('/api/overview', { signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    latest = await response.json(); render();
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

let editingGroup = null, requestKey, requestGroupRevision;
async function post(path, body) {
  const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Master-Token': latest.token }, body: JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.message ?? result.error);
  return result;
}
function renderManagement() {
  $('groups').innerHTML = latest.groups.map(g => `<article class="project"><div class="card-head"><h3>${escape(g.name)}</h3><span class="badge">${g.projectIds.length}개 프로젝트</span></div>
    <p>${escape(g.description || '서비스 범위 설명 없음')}</p><p class="muted">${escape(g.projectIds.map(id => latest.projects.find(p => p.id === id)?.name ?? id).join(' · ') || '소속 프로젝트 없음')}</p>
    <div class="filters"><button type="button" class="edit-group" data-id="${escape(g.id)}">구성 편집</button><button type="button" class="group-request" data-id="${escape(g.id)}" ${g.projectIds.length ? '' : 'disabled'}>그룹에 요청</button></div></article>`).join('') || '<div class="empty">서비스 그룹을 만들고 유지보수할 프로젝트를 선택하세요.</div>';
  $('requests').innerHTML = [...latest.requests].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(r => `<article class="mission"><div class="card-head"><h3>${escape(r.goal)}</h3>${badge(r.state === 'waiting' ? r.progress ?? 'waiting' : r.state)}</div>
    <p>${r.targetType === 'group' ? '그룹' : '프로젝트'} ${escape(r.targetId)} · ${escape(r.projectIds.join(', '))}</p>
    <p class="muted">${escape(r.id)} · ${escape(date(r.updatedAt))}</p>
    ${r.state === 'waiting' ? `<p>${escape(r.reason)}</p>` : ''}
    ${r.error ? `<p class="error">${escape(r.error.message)}</p>` : ''}${r.blockers.length ? `<p>${escape(r.blockers.join(' · '))}</p>` : ''}
    ${['waiting', 'failed', 'interrupted', 'queued'].includes(r.state) ? `<button type="button" class="continue-request" data-id="${escape(r.id)}">보완 후 이어 실행</button>` : ''}</article>`).join('') || '<div class="empty">그룹 또는 프로젝트에 유지보수 요청을 보내세요.</div>';
}
function openGroup(id) {
  editingGroup = latest.groups.find(g => g.id === id) ?? null;
  $('group-form').reset(); $('group-error').textContent = '';
  $('group-title').textContent = editingGroup ? '서비스 그룹 편집' : '서비스 그룹 만들기';
  $('group-id').value = editingGroup?.id ?? ''; $('group-id').disabled = Boolean(editingGroup);
  $('group-name').value = editingGroup?.name ?? ''; $('group-description').value = editingGroup?.description ?? '';
  $('group-members').innerHTML = latest.projects.map(p => `<label class="member"><input type="checkbox" name="member" value="${escape(p.id)}" ${editingGroup?.projectIds.includes(p.id) ? 'checked' : ''}>${escape(p.name || p.id)}</label>`).join('') || '<p>등록된 프로젝트가 없습니다. project add 명령으로 먼저 등록하세요.</p>';
  $('group-dialog').showModal();
}
function scopeChanged() {
  const type = $('request-type').value, id = $('request-target').value;
  const group = latest.groups.find(g => g.id === id);
  requestGroupRevision = type === 'group' ? group?.revision : undefined;
  const ids = type === 'group' ? group?.projectIds ?? [] : id ? [id] : [];
  $('request-scope').textContent = `대상 프로젝트: ${ids.map(id => latest.projects.find(p => p.id === id)?.name ?? id).join(' · ') || '없음'}`;
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
$('new-request').addEventListener('click', () => latest && openRequest());
$('request-type').addEventListener('change', () => requestTargets());
$('request-target').addEventListener('change', scopeChanged);
document.addEventListener('click', async event => {
  const button = event.target.closest('button'); if (!button) return;
  if (button.dataset.close) $(button.dataset.close).close();
  if (button.classList.contains('edit-group')) openGroup(button.dataset.id);
  if (button.classList.contains('group-request')) openRequest('group', button.dataset.id);
  if (button.classList.contains('project-request')) openRequest('project', button.dataset.id);
  if (button.classList.contains('continue-request')) {
    button.disabled = true;
    try { const r = latest.requests.find(r => r.id === button.dataset.id); await post('/api/requests/continue', { id: r.id, revision: r.revision }); $('action-status').textContent = '기존 대상과 목표에서 이어 실행합니다.'; await refresh(); }
    catch (error) { $('action-status').textContent = error.message; } finally { button.disabled = false; }
  }
});
$('group-form').addEventListener('submit', async event => {
  event.preventDefault(); const button = event.submitter; button.disabled = true;
  try {
    const group = { id: $('group-id').value.trim(), name: $('group-name').value.trim(), description: $('group-description').value,
      projectIds: [...document.querySelectorAll('#group-members input:checked')].map(e => e.value) };
    await post('/api/groups', { group, revision: editingGroup?.revision ?? 0 });
    $('group-dialog').close(); $('action-status').textContent = '그룹 구성을 저장했습니다.'; await refresh();
  } catch (error) { $('group-error').textContent = error.message; } finally { button.disabled = false; }
});
$('request-form').addEventListener('submit', async event => {
  event.preventDefault(); const button = event.submitter; button.disabled = true;
  try {
    const config = $('request-config').value.trim() ? JSON.parse($('request-config').value) : {};
    const request = await post('/api/requests', { targetType: $('request-type').value, targetId: $('request-target').value,
      groupRevision: requestGroupRevision, requestKey, goal: $('request-goal').value.trim(), provider: $('request-provider').value,
      criteria: config.criteria ?? $('request-criteria').value.split('\n').map(s => s.trim()).filter(Boolean).map((description, i) => ({ id: `criterion-${i + 1}`, description })), templates: config.templates ?? [] });
    $('request-dialog').close(); $('action-status').textContent = `요청을 접수했습니다: ${request.id}`; await refresh();
  } catch (error) { $('request-error').textContent = error.message; } finally { button.disabled = false; }
});
