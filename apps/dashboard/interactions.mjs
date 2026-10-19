const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const $ = id => document.getElementById(id);
const date = value => value ? new Date(value).toLocaleString('ko-KR') : '기록 없음';
const labels = { open: '응답 대기', deferred: '보류', answered: '답변 적용', expired: '만료', closed: '대기 종료·결과 미확인',
  received: '접수', applied: '적용', 'not-requested': '재개 요청 없음', launching: '재개 접수·실행 확인 필요',
  requested: '재개 실행기 요청됨', resumed: '기존 처리기 재개 확인', 'waiting-answers': '다른 답변 대기', manual: 'CLI 재개 필요', failed: '실패',
  sending: '전송 중', unknown: '수신 여부 미확인', reopened: '다시 열림', 'waiting-host': '원래 세션 소비 대기', queued: '재개 대기', started: '원래 세션 재개됨', blocked: '재개 차단', cancelled: '취소' };
let data, post, refresh, opened, pending = false, lastSubmission;
const seen = new Set();
function stored(id) { try { return JSON.parse(sessionStorage.getItem(`interaction-draft:${id}`) ?? 'null'); } catch { return null; } }
function saveDraft() {
  if (!opened || pending) return;
  const draft = { contentHash: opened.contentHash, custom: $('interaction-custom')?.value ?? '',
    optionIds: [...document.querySelectorAll('#interaction-options input:checked')].map(i => i.value), answers: remoteAnswers() };
  try { sessionStorage.setItem(`interaction-draft:${opened.id}`, JSON.stringify(draft)); } catch { /* Draft still lives in the form. */ }
  lastSubmission = null;
}
function init() {
  $('interaction-inbox').innerHTML = `<div class="toolbar"><div><h2>공통 요청함 <span id="interaction-count" class="muted"></span></h2>
    <p class="muted">추천안은 실제 제출 전까지 답변되지 않습니다. 질문의 발행 주체가 답을 적용하며 수신·적용·재개는 구분해 표시합니다.</p></div></div>
    <div class="filters inbox-filters">
    <label>발행 주체<select id="interaction-source"><option value="">전체</option><option value="master">master</option><option value="code-agent">code-agent</option></select></label>
    <label>상태<select id="interaction-state"><option value="pending">대기·보류</option><option value="">전체·이력</option><option value="open">응답 대기</option><option value="deferred">보류</option><option value="answered">답변 적용</option><option value="closed">대기 종료</option><option value="expired">만료</option></select></label>
    <label>그룹<select id="interaction-group"><option value="">전체</option></select></label>
    <label>프로젝트<select id="interaction-project"><option value="">전체</option></select></label>
    <label>단계<select id="interaction-stage"><option value="">전체</option></select></label>
    <label>작업·TASK·질문<input id="interaction-search" type="search" placeholder="TASK 번호 또는 질문"></label></div>
    <p id="interaction-capabilities" class="muted"></p><div id="interaction-items" class="projects"></div>`;
  const dialog = document.createElement('dialog'); dialog.id = 'interaction-dialog';
  dialog.setAttribute('aria-labelledby', 'interaction-title');
  dialog.innerHTML = `<form id="interaction-form"><h2 id="interaction-title"></h2><p id="interaction-context" class="muted"></p>
    <p id="interaction-stale" class="error" role="alert"></p><pre id="interaction-body" class="interaction-body"></pre>
    <div id="interaction-remote-questions"></div>
    <div id="interaction-recommendation"></div><div id="interaction-evidence"></div>
    <fieldset id="interaction-options"><legend>답변 선택</legend></fieldset>
    <label id="interaction-custom-label">직접 입력<textarea id="interaction-custom" rows="4" maxlength="16000"></textarea></label>
    <p id="interaction-limit" class="muted"></p><div id="interaction-history"></div>
    <p id="interaction-error" class="error" role="alert"></p>
    <div class="dialog-actions"><button type="button" id="interaction-close">닫기</button><button type="button" id="interaction-defer">보류</button><button type="submit" id="interaction-submit">답변 제출 · 기존 요청 재개</button></div></form>`;
  document.body.append(dialog);
  const approval = document.createElement('dialog'); approval.id = 'interaction-approval';
  approval.setAttribute('aria-labelledby', 'approval-title');
  approval.innerHTML = `<h2 id="approval-title">별도 승인 검토</h2><p id="approval-context" class="muted"></p>
    <pre id="approval-body" class="interaction-body"></pre><div id="approval-changes"></div>
    <label class="interaction-option"><input id="approval-reviewed" type="checkbox">승인 전문과 변경 대상을 확인했습니다.</label>
    <label>판단<select id="approval-verdict"><option value="">명시적으로 선택하세요</option><option value="approve">승인</option><option value="request-changes">수정 요청</option></select></label>
    <p id="approval-limit" class="error"></p><div id="approval-history"></div>
    <div class="dialog-actions"><button type="button" id="approval-close">닫기</button><button type="button" id="approval-defer">보류</button><button id="approval-submit" type="button" disabled>선택한 판단 제출</button></div>`;
  document.body.append(approval);
  for (const id of ['source', 'state', 'group', 'project', 'stage', 'search']) $(`interaction-${id}`).addEventListener('input', renderList);
  $('interaction-items').addEventListener('click', event => {
    const button = event.target.closest('[data-interaction]'); if (button) open(button.dataset.interaction);
  });
  $('interaction-close').onclick = () => dialog.close(); $('approval-close').onclick = () => approval.close();
  const closed = () => { if (!dialog.open && !approval.open) opened = null; };
  dialog.addEventListener('close', closed); approval.addEventListener('close', closed);
  $('interaction-options').addEventListener('change', () => { $('interaction-custom').value = ''; saveDraft(); });
  $('interaction-custom').addEventListener('input', () => {
    if ($('interaction-custom').value) document.querySelectorAll('#interaction-options input').forEach(i => { i.checked = false; });
    saveDraft();
  });
  $('interaction-remote-questions').addEventListener('input', event => {
    const block = event.target.closest('[data-question-index]');
    if (event.target.matches('[data-question-text]') && event.target.value) block.querySelectorAll('[data-option]').forEach(i => { i.checked = false; });
    if (event.target.matches('[data-option]')) { const text = block.querySelector('[data-question-text]'); if (text) text.value = ''; }
    enableOptionInputs(); saveDraft();
  });
  $('approval-reviewed').onchange = checkOpen; $('approval-verdict').onchange = checkOpen;
  $('approval-changes').onchange = checkOpen;
  $('approval-submit').onclick = () => void submit($('approval-verdict').value);
  $('interaction-form').addEventListener('submit', event => { event.preventDefault(); void submit('answer'); });
  const defer = () => void submit(opened?.handler === 'code-agent' && opened.state === 'deferred' ? 'reopen' : 'defer');
  $('interaction-defer').onclick = defer; $('approval-defer').onclick = defer;
  document.addEventListener('click', async event => {
    const button = event.target.closest('[data-retry-interaction]'); if (!button || pending) return;
    pending = true; button.disabled = true;
    try { await post('/api/interactions/retry', { commandId: button.dataset.retryInteraction }); await refresh(); }
    catch (error) { button.textContent = error.message; }
    finally { pending = false; button.disabled = false; }
  });
}
function remoteAnswers() {
  return [...document.querySelectorAll('#interaction-remote-questions [data-question-index]')].map(block => {
    const q = opened.questions[Number(block.dataset.questionIndex)];
    const optionIds = [...block.querySelectorAll('[data-option]:checked')].map(input => input.value);
    const text = block.querySelector('[data-question-text]')?.value;
    const optionInputs = Object.fromEntries([...block.querySelectorAll('[data-option-input]')].filter(input => optionIds.includes(input.dataset.optionInput)).map(input => [input.dataset.optionInput, input.value]));
    return { questionId: q.questionId, optionIds, ...(text === undefined ? {} : { text }), optionInputs };
  });
}
function enableOptionInputs() {
  document.querySelectorAll('#interaction-remote-questions [data-question-index]').forEach(block => {
    const selected = new Set([...block.querySelectorAll('[data-option]:checked')].map(input => input.value));
    block.querySelectorAll('[data-option-input]').forEach(input => { input.disabled = !selected.has(input.dataset.optionInput); });
  });
}
function remoteQuestions(item, draft) {
  $('interaction-remote-questions').innerHTML = item.questions.map((q, index) => {
    const answer = draft?.answers?.find(a => a.questionId === q.questionId);
    const selected = answer?.optionIds ?? (q.mode === 'multiple' || q.defaultOptionIds.length ? q.defaultOptionIds : q.recommendedOptionIds);
    return `<fieldset data-question-index="${index}"><legend>${esc(q.title)}${q.required ? ' (필수)' : ''}</legend><p>${esc(q.background)}</p>
      <p>추천 이유: ${esc(q.recommendationReason)}</p>${q.evidence.map(e => `<p class="muted">${esc(e.path)} ${esc(e.summary)}</p>`).join('')}
      ${[...q.options].sort((a, b) => Number(q.recommendedOptionIds.includes(b.optionId)) - Number(q.recommendedOptionIds.includes(a.optionId))).map(o => `<label class="interaction-option"><input data-option type="${q.mode === 'multiple' ? 'checkbox' : 'radio'}" name="remote-question-${index}" value="${esc(o.optionId)}" ${selected.includes(o.optionId) ? 'checked' : ''}>${esc(o.label)}${q.recommendedOptionIds.includes(o.optionId) ? ' (추천)' : ''}</label>
        <p class="muted">${esc(o.description)} ${esc(o.consequence)}</p>${o.input ? `<label>${esc(o.input.description)}<input data-option-input="${esc(o.optionId)}" value="${esc(answer?.optionInputs?.[o.optionId] ?? '')}" ${o.input.required ? 'required' : ''} minlength="${o.input.minLength}" maxlength="${o.input.maxLength}"></label>` : ''}`).join('')}
      ${q.input ? `<label>${esc(q.input.description)}<textarea data-question-text rows="3" minlength="${q.input.minLength}" maxlength="${q.input.maxLength}" ${q.mode === 'text' && q.required ? 'required' : ''}>${esc(answer?.text ?? '')}</textarea></label>` : ''}
      ${q.mode === 'multiple' ? `<p class="muted">${q.minSelections}~${q.maxSelections}개 선택</p>` : ''}</fieldset>`;
  }).join(''); enableOptionInputs();
}
function selectItems(id, items) {
  const select = $(id), selected = select.value;
  const markup = '<option value="">전체</option>' + items.map(item => `<option value="${esc(item.id)}">${esc(item.name ?? item.id)}</option>`).join('');
  if (select.innerHTML !== markup) { select.innerHTML = markup; select.value = selected; }
}
function history(item) {
  return `<h3>응답 이력</h3>${item.history.map(h => `<p>${esc(date(h.createdAt))} · ${esc(labels[h.state] ?? h.state)}${h.answer ? ` · ${esc(h.answer)}` : ''}
    <small>${esc(labels[h.resume?.state] ?? '')} ${esc(h.resume?.reason ?? h.resume?.detail ?? h.resume?.error ?? h.error ?? '')}</small>
    ${['unknown', 'sending'].includes(h.state) || h.resume?.state === 'launching' ? `<button type="button" data-retry-interaction="${esc(h.id)}">같은 접수 번호로 결과 확인·재시도</button>` : ''}</p>`).join('') || '<p class="muted">아직 제출한 답변이 없습니다.</p>'}
    ${item.remote ? `<p>원래 요청 상태: ${esc(labels[item.remote.status] ?? item.remote.status)} · ${esc(labels[item.remote.continuation?.state] ?? '')}</p><p class="error">${esc(item.remote.application?.error ?? item.remote.continuation?.detail ?? '')}</p>` : ''}`;
}
function context(item) {
  return `${item.source} · ${item.projectIds.join(', ')} · ${item.taskNumber ?? item.workId ?? item.missionId ?? '작업 ID 없음'} · ${item.stage}${item.context.branch ? ` · ${item.context.branch}` : ''}${item.context.sessionId ? ` · 세션 ${item.context.sessionId}` : ''}`;
}
function renderList() {
  const items = data.interactions?.items ?? [];
  const waiting = items.filter(i => ['open', 'deferred', 'received'].includes(i.state));
  $('interaction-count').textContent = `${waiting.length}건 대기 · 새 요청 ${waiting.filter(i => !seen.has(i.id)).length}건`;
  const source = $('interaction-source').value, state = $('interaction-state').value, group = $('interaction-group').value,
    project = $('interaction-project').value, stage = $('interaction-stage').value, query = $('interaction-search').value.toLowerCase();
  const visible = items.filter(i => (!source || i.source === source) && (!state || (state === 'pending' ? ['open', 'deferred', 'received'].includes(i.state) : i.state === state)) &&
    (!group || i.groupIds.includes(group)) && (!project || i.projectIds.includes(project)) && (!stage || i.stage === stage) &&
    `${i.title} ${i.taskNumber ?? ''} ${i.workId ?? ''} ${i.taskId ?? ''} ${i.missionId ?? ''}`.toLowerCase().includes(query));
  $('interaction-items').innerHTML = visible.sort((a, b) => a.firstSeenAt.localeCompare(b.firstSeenAt)).map(i => `<article class="project">
    <div class="card-head"><h3>${esc(i.title)}</h3><span class="badge">${esc(labels[i.state])}</span></div>
    <p class="muted">${esc(context(i))}</p><p>${i.kind === 'approval' ? '별도 승인 확인 필요' : '질문'} · ${!seen.has(i.id) ? '새 요청 · ' : ''}${['open', 'deferred'].includes(i.state) ? `${Math.max(0, Math.floor((Date.now() - Date.parse(i.originAt ?? i.firstSeenAt)) / 60000))}분 대기` : esc(date(i.updatedAt))}</p>
    <p class="muted">차단 대상: ${esc(i.taskId ?? i.missionId ?? i.workId ?? '독립 설정·운영 세션')}</p>
    ${!i.respondSupported ? `<p class="muted">${esc(i.unavailableReason)}</p>` : ''}
    <button type="button" data-interaction="${esc(i.id)}">${i.kind === 'approval' ? '승인 전문 검토' : '질문·응답 열기'}</button></article>`).join('') || '<p class="empty">조건에 맞는 요청이 없습니다.</p>';
}
function open(id) {
  opened = (data.interactions?.items ?? []).find(i => i.id === id); if (!opened) return;
  seen.add(id); lastSubmission = null; renderList();
  if (opened.kind === 'approval') {
    $('approval-title').textContent = opened.title; $('approval-context').textContent = context(opened);
    $('approval-body').textContent = opened.body;
    $('approval-changes').innerHTML = `<h3>변경 대상</h3>${opened.consent ? opened.consent.choices.map(c => `<label>${esc(c.shown)}<select data-approval-choice="${c.index}"><option value="">명시적으로 선택하세요</option><option value="유지">유지</option><option value="적용">적용</option></select></label>`).join('') : (opened.changes ?? []).map(c => `<p>${esc(c)}</p>`).join('') || '<p>제공된 변경 목록 없음</p>'}`;
    $('approval-reviewed').checked = false; $('approval-limit').textContent = opened.unavailableReason;
    $('approval-verdict').value = ''; $('approval-submit').disabled = true;
    $('approval-submit').textContent = opened.respondSupported ? '선택한 판단 제출' : '명시적 승인 제출 (연동 미지원)';
    $('approval-defer').textContent = opened.handler === 'code-agent' && opened.state === 'deferred' ? '다시 열기' : '보류';
    $('approval-history').innerHTML = history(opened); $('approval-defer').disabled = !['open', 'deferred'].includes(opened.state);
    $('interaction-approval').showModal(); return;
  }
  $('interaction-title').textContent = opened.title; $('interaction-context').textContent = context(opened);
  $('interaction-body').textContent = opened.body;
  $('interaction-recommendation').innerHTML = `<h3>추천안과 이유</h3><p>${esc(opened.recommendation || '제공된 추천안 없음')}</p><p>${esc(opened.reason)}</p>`;
  $('interaction-evidence').innerHTML = `<h3>근거</h3>${opened.references.map(r => `<p class="path">${esc(r)}</p>`).join('') || '<p class="muted">제공된 근거 없음</p>'}`;
  const draft = stored(id), compatible = draft?.contentHash === opened.contentHash;
  const structured = opened.handler === 'code-agent';
  $('interaction-remote-questions').innerHTML = '';
  for (const id of ['interaction-recommendation', 'interaction-evidence', 'interaction-options']) $(id).hidden = structured;
  if (structured) remoteQuestions(opened, compatible ? draft : null);
  const selected = compatible ? draft.optionIds : opened.recommendedOptionIds;
  $('interaction-options').innerHTML = '<legend>대안 선택</legend>' + opened.options.map(o => `<label class="interaction-option"><input type="${opened.multiple ? 'checkbox' : 'radio'}" name="interaction-option" value="${esc(o.id)}" ${selected.includes(o.id) ? 'checked' : ''}>${esc(o.label)}${opened.recommendedOptionIds.includes(o.id) ? ' (추천)' : ''}</label>`).join('');
  $('interaction-custom-label').hidden = !opened.allowCustom;
  $('interaction-custom').value = compatible ? draft.custom : '';
  $('interaction-limit').textContent = opened.unavailableReason ?? '답변 제출 후 기존 목표와 TASK 번호로 재분석합니다. 다른 질문이 남아 있으면 답변을 기다립니다.';
  $('interaction-history').innerHTML = history(opened); $('interaction-error').textContent = '';
  $('interaction-stale').textContent = draft && !compatible ? `질문이 변경되어 이전 초안을 자동 제출하지 않습니다. 이전 직접 입력: ${draft.custom || '(선택 답변)'}` : '';
  $('interaction-submit').textContent = opened.handler === 'preparation' ? '준비 다시 확인 · 기존 요청 재개' : structured ? '선택 내용 명시적 제출' : '답변 제출 · 기존 요청 재개';
  $('interaction-submit').disabled = !opened.respondSupported || !['open', 'deferred'].includes(opened.state) || structured && opened.state === 'deferred';
  $('interaction-defer').textContent = structured && opened.state === 'deferred' ? '다시 열기' : '보류';
  $('interaction-defer').disabled = !['open', 'deferred'].includes(opened.state);
  $('interaction-dialog').showModal();
}
async function submit(action) {
  if (!opened || pending) return;
  const item = opened;
  const payload = { id: item.id, revision: item.revision, contentHash: item.contentHash, context: item.context, action,
    ...(action === 'answer' ? item.handler === 'code-agent' ? { answers: remoteAnswers() } : { optionIds: [...document.querySelectorAll('#interaction-options input:checked')].map(i => i.value), custom: $('interaction-custom').value, resume: true } : {}),
    ...(['approve', 'request-changes'].includes(action) ? { reviewed: $('approval-reviewed').checked, choices: Object.fromEntries([...document.querySelectorAll('[data-approval-choice]')].map(e => [e.dataset.approvalChoice, e.value])) } : {}) };
  const serialized = JSON.stringify(payload);
  const commandId = lastSubmission?.serialized === serialized ? lastSubmission.commandId : crypto.randomUUID();
  lastSubmission = { serialized, commandId }; pending = true;
  const errorEl = item.kind === 'approval' ? $('approval-limit') : $('interaction-error'); errorEl.textContent = '전송 중…';
  document.querySelectorAll('#interaction-form button, #interaction-form input, #interaction-form textarea, #interaction-approval button, #interaction-approval input, #interaction-approval select').forEach(e => { e.disabled = true; });
  try {
    const result = await post('/api/interactions/respond', { ...payload, commandId });
    errorEl.textContent = `${labels[result.state] ?? result.state} · ${labels[result.resume?.state] ?? ''} ${result.error ?? ''}`;
    if (action === 'answer' && ['received', 'applied'].includes(result.state)) try { sessionStorage.removeItem(`interaction-draft:${item.id}`); } catch { /* optional browser storage */ }
    await refresh();
  } catch (error) { errorEl.textContent = `${error.message} 입력은 유지됩니다. 같은 내용으로 재시도하면 같은 접수 번호를 사용합니다.`; }
  finally {
    pending = false;
    document.querySelectorAll('#interaction-form button, #interaction-form input, #interaction-form textarea, #interaction-approval button, #interaction-approval input, #interaction-approval select').forEach(e => { e.disabled = false; });
    enableOptionInputs(); checkOpen();
  }
}
function checkOpen() {
  if (!opened || pending) return;
  const current = data.interactions?.items.find(i => i.id === opened.id);
  const stale = !current || current.contentHash !== opened.contentHash || !['open', 'deferred'].includes(current.state);
  if (opened.kind === 'approval') {
    $('approval-defer').disabled = stale;
    $('approval-submit').disabled = stale || !opened.respondSupported || opened.state === 'deferred' || !$('approval-reviewed').checked || !$('approval-verdict').value ||
      $('approval-verdict').value === 'approve' && [...document.querySelectorAll('[data-approval-choice]')].some(e => !e.value);
    if (stale) $('approval-limit').textContent = '요청이 변경되었습니다. 최신 승인 전문을 다시 열어 확인하세요.';
  } else {
    if (stale) $('interaction-stale').textContent = '요청이 변경되었거나 처리되었습니다. 입력은 유지되며 최신 질문을 다시 열어 확인해야 제출할 수 있습니다.';
    $('interaction-submit').disabled = stale || !opened.respondSupported || opened.handler === 'code-agent' && opened.state === 'deferred';
    $('interaction-defer').disabled = stale;
  }
}
export function renderInteractions(latest, send, reload) {
  data = latest; post = send; refresh = reload;
  if (!$('interaction-items')) init();
  selectItems('interaction-project', data.projects);
  selectItems('interaction-group', data.groups);
  selectItems('interaction-stage', [...new Set((data.interactions?.items ?? []).map(i => i.stage))].sort().map(id => ({ id })));
  const sources = data.interactions?.sources ?? [];
  $('interaction-capabilities').textContent = sources.length ? sources.map(s => `${s.id}: ${s.error ? `요청 조회 실패 (${s.error}) · 마지막 관측 유지` : `code-agent ${s.version ?? '?'} · ${s.responseSupported ? '요청 API 연결됨 (사람 채널 권한은 요청별 확인)' : '사람 응답 연동 미지원·제어 연결 확인'}`}`).join(' / ') : 'code-agent 전체 단계 요청 API와 사람 응답 연동을 확인하기 전에는 외부 질문을 제출할 수 없습니다.';
  renderList(); checkOpen();
}
