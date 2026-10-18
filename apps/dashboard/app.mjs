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
    $('notice').textContent = latest.live ? `code-agent 상태 자동 조회 · 조회 완료 후 ${latest.intervalMs / 1000}초 간격${latest.refreshing ? ' · 조회 중' : ''}` :
      '저장된 관측을 표시합니다. code-agent 자동 조회는 dashboard --cli <code-agent의 절대 JS 또는 exe 경로>로 실행하세요.';
  } catch (error) {
    $('connection').textContent = '연결 끊김'; $('notice').className = 'notice error';
    $('notice').textContent = `대시보드 서버에 연결할 수 없습니다 (${error.message}). 아래 내용은 마지막 수신 화면입니다.`;
  } finally { inFlight = false; $('refresh').disabled = false; timer = setTimeout(refresh, latest?.intervalMs ?? 5000); }
}
$('search').addEventListener('input', render); $('filter').addEventListener('change', render);
$('refresh').addEventListener('click', refresh);
void refresh();
