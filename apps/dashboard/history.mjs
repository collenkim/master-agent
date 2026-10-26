const $ = id => document.getElementById(id);
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const date = value => value ? new Date(value).toLocaleString('ko-KR') : '시각 미확인';
const phase = work => [work?.phase, work?.stage, work?.task].filter(Boolean).join(' / ') || '작업 없음';
const result = passed => passed === true ? '통과' : passed === false ? '미통과' : '미확인';

export function renderStageDetails(detail) {
  if (!detail) return '';
  return `${detail.branch ? `<p>현재 브랜치: ${escape(detail.branch)}</p>` : ''}
    ${detail.work?.branch && detail.work.branch !== detail.branch ? `<p>작업 브랜치: ${escape(detail.work.branch)}</p>` : ''}
    ${detail.attempt ? `<p>실행 시도: ${escape(detail.attempt.id)} · ${escape(detail.attempt.kind)}</p>` : ''}
    ${detail.verification ? `<p>검증 ${escape(detail.verification.rounds)}회 · 근거 연결 ${detail.verification.bound.valid === true ? '유효' : detail.verification.bound.valid === false ? '점검 필요' : '미확인'}</p>
      ${detail.verification.bound.problems.map(p => `<p class="error">${escape(p)}</p>`).join('')}
      <ul>${detail.verification.phases.map(p => `<li>${escape(p.phase)}: ${result(p.passed)} · ${escape(p.round)}차 · 실행 ${escape(p.runs)}회</li>`).join('')}</ul>` : ''}
    ${detail.review ? `<p>리뷰 ${escape(detail.review.rounds)}회</p>` : ''}
    ${detail.planning?.attempts.length ? `<h3>계획 실행 내역</h3><ul>${detail.planning.attempts.map(a => `<li>${escape(a.task)} · ${escape(a.role)} · ${escape(a.phase)} · ${escape(a.status)}${a.run ? ` · ${escape(a.run.state)}` : ''}<small>${escape(a.dispatchId)} · ${escape(date(a.at))}</small></li>`).join('')}</ul>` : ''}`;
}

let latest, controller, generation = 0, nextBefore = null, currentBefore = '', initialized = false;
const names = { 'state.observed': '최초 상태 관측', 'state.changed': '상태 변화 관측', 'observation.unavailable': '상태 조회 실패',
  'history.gap': '이벤트 누락·원장 변경', 'phase.changed': '단계 변경', 'attempt.changed': '시도 변경',
  'verification.recorded': '검증 결과', 'resume.changed': '진행·대기 상태 변경', 'run.finished': '실행 종료',
  'interaction.open': '질문·승인 접수', 'interaction.answered': '답변 적용', 'interaction.received': '답변 접수', 'interaction.deferred': '보류' };

function renderEntry(item) {
  const d = item.detail, project = latest.projects.find(p => p.id === item.projectId);
  const identity = [item.workId, item.taskNumber && item.taskNumber !== item.workId ? item.taskNumber : null, item.taskId, item.branch, item.runId, item.attemptId].filter(Boolean);
  let body = '';
  if (item.source === 'observation') {
    body = `<p>${item.before ? `${escape(item.before.work?.id ?? '작업 없음')} · ${escape(phase(item.before.work))} → ` : ''}${escape(d?.work?.id ?? '작업 없음')} · ${escape(phase(d?.work))}</p>
      ${item.before?.branch !== d?.branch ? `<p>브랜치: ${escape(item.before?.branch ?? '미확인')} → ${escape(d?.branch ?? '미확인')}</p>` : ''}
      ${d?.resume ? `<p>진행 판단: ${escape(d.resume.code)} ${d.resume.reasons.map(escape).join(' · ')}</p>` : ''}
      ${d?.questions ? `<p>답변 대기: ${d.questions.unanswered.map(escape).join(', ') || '없음'} · 답변 검증 대기: ${d.questions.unverified.map(escape).join(', ') || '없음'}</p>` : ''}
      ${d?.consents?.length ? `<p>승인: ${d.consents.map(c => `${escape(c.id)} (${escape(c.action)} · ${escape(c.status)})`).join(', ')}</p>` : ''}
      ${item.error ? `<p class="error">${escape(item.error)}</p>` : ''}${renderStageDetails(d)}`;
    if (!d) body = `<p class="error">${escape(item.status)} · ${escape(item.error)}</p><p>작업 종료로 판정하지 않습니다. 마지막 관측 이력은 보존됩니다.</p>`;
  } else if (item.source === 'interaction') {
    body = `<p>${escape(d.title)}</p><p>${escape(d.stage)} · ${escape(d.status)}${d.application ? ` · 적용 ${escape(d.application)}` : ''}${d.continuation ? ` · 재개 ${escape(d.continuation)}` : ''}</p><p class="muted">질문 전문과 답변·승인 처리는 공통 요청함에서 확인하세요.</p>`;
  } else if (item.type === 'history.gap') {
    body = `<p class="error">${escape(item.reason)}</p><p>이전 순번 ${escape(item.fromSeq)} · 보존된 시작 순번 ${escape(item.firstSeq)}. 남아 있는 이벤트부터 이어 읽으며 누락 구간을 추정하지 않습니다.</p>`;
  } else {
    body = `${d.from || d.to ? `<p>${escape(d.from ?? '없음')} → ${escape(d.to ?? '없음')}</p>` : ''}
      <p>${[d.code, d.action, d.status, d.state, d.outcome, d.q, d.id].filter(Boolean).map(escape).join(' · ')}</p>
      ${d.reasons.map(r => `<p>${escape(r)}</p>`).join('')}
      ${d.phases.map(p => `<p>${escape(p.phase)}: ${result(p.passed)} · ${escape(p.round)}차 · 실행 ${escape(p.runs)}회</p>`).join('')}
      ${!item.workId && !item.runId ? '<p class="muted">작업 식별자가 없는 프로젝트 이벤트입니다.</p>' : ''}`;
  }
  const summary = item.source === 'observation' && d ? `${item.workId ?? '작업 없음'} · ${phase(d.work)}` : item.source === 'interaction' ? d.title : item.workId;
  return `<details class="mission history-entry" data-sequence="${item.sequence}"><summary><span>${escape(names[item.type] ?? item.type)}${summary ? ` · ${escape(summary)}` : ''}<small>${escape(project?.name ?? item.projectId)} · ${escape(date(item.occurredAt))} · ${{ observation: '상태 관측', 'code-agent': 'code-agent 이벤트', interaction: '요청함' }[item.source]}</small></span></summary>
    <p class="path">${identity.map(escape).join(' · ') || '프로젝트 범위'}${item.seq ? ` · 이벤트 #${item.seq}` : ''}</p>${body}<small>수집 ${escape(date(item.recordedAt))}</small></details>`;
}

async function load(before = '') {
  controller?.abort(); controller = new AbortController();
  const request = ++generation;
  const query = new URLSearchParams({ projectId: $('history-project').value, groupId: $('history-group').value, task: $('history-task').value.trim(), before: String(before) });
  $('history-status').textContent = '이력을 조회하고 있습니다.';
  try {
    const response = await fetch(`/api/history?${query}`, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    if (request !== generation) return;
    currentBefore = before; nextBefore = data.nextBefore;
    const open = new Set([...document.querySelectorAll('#history-list details[open]')].map(e => e.dataset.sequence));
    $('history-list').innerHTML = data.items.map(renderEntry).join('') || '<p class="empty">조건에 맞는 수집 이력이 없습니다.</p>';
    for (const element of document.querySelectorAll('#history-list details')) element.open = open.has(element.dataset.sequence);
    const errors = data.sources.filter(s => s.error).map(s => `${latest.projects.find(p => p.id === s.projectId)?.name ?? s.projectId}: ${s.error}`);
    $('history-status').textContent = `${data.items.length}건 · 최신 수집 순${data.sources.some(s => s.pending) ? ' · 남은 이벤트 수집 중' : ''}${errors.length ? ` · 이벤트 조회 실패 (${errors.join(', ')})` : ''}`;
    $('history-older').disabled = !nextBefore;
  } catch (error) {
    if (request === generation && error.name !== 'AbortError') $('history-status').textContent = `이력을 가져오지 못했습니다 (${error.message}). 이전 화면을 유지합니다.`;
  }
}

export function renderHistory(snapshot) {
  latest = snapshot;
  for (const [id, records] of [['history-project', snapshot.projects], ['history-group', snapshot.groups]]) {
    const select = $(id), selected = select.value;
    select.innerHTML = '<option value="">전체</option>' + records.map(r => `<option value="${escape(r.id)}">${escape(r.name || r.id)}</option>`).join('');
    select.value = records.some(r => r.id === selected) ? selected : '';
  }
  if (!initialized) {
    initialized = true;
    $('history-archive').addEventListener('toggle', () => {
      if ($('history-archive').open) void load(currentBefore);
      else { controller?.abort(); generation++; }
    });
    $('history-filter').addEventListener('submit', event => { event.preventDefault(); void load(); });
    for (const id of ['history-project', 'history-group']) $(id).addEventListener('change', () => { void load(); });
    $('history-older').addEventListener('click', () => { if (nextBefore) void load(nextBefore); });
    $('history-latest').addEventListener('click', () => { void load(); });
  }
  if (!currentBefore && $('history-archive').open) void load();
}
