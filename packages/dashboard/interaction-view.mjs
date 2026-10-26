import { requireThat } from '../domain/contracts.mjs';
import { requestStatus } from '../orchestrator/requests.mjs';

const waiting = new Set(['open', 'deferred', 'received']);
const archived = new Set(['answered', 'closed', 'expired', 'failed', 'cancelled']);
const pick = (value, keys) => Object.fromEntries(keys.filter(k => value?.[k] !== undefined).map(k => [k, value[k]]));
const fields = ['id', 'source', 'sourceInstanceId', 'requestId', 'handler', 'kind', 'projectIds', 'groupIds', 'missionId', 'taskId',
  'taskNumber', 'workId', 'stage', 'context', 'title', 'body', 'options', 'recommendedOptionIds', 'recommendation', 'reason', 'references',
  'allowCustom', 'multiple', 'changes', 'respondSupported', 'unavailableReason', 'originAt', 'firstSeenAt', 'updatedAt', 'contentHash',
  'revision', 'producerState', 'runId', 'relatedInteractionId', 'connectionRequired', 'pairing', 'verificationSetup'];
const inputView = input => input ? pick(input, ['description', 'required', 'minLength', 'maxLength']) : null;

function projectItem(store, { item, state, history }) {
  const result = { ...pick(item, fields), state,
    history: history.map(({ id, action, state, answer, createdAt, appliedAt, resume, error, errorMessage }) => {
      const requestId = resume?.requestId ?? item.missionId;
      const request = requestId ? store.get('target-request', requestId) : null;
      const m = item.missionId ? store.get('mission', item.missionId) : null;
      const recoveryAnswer = m?.recoveryAnswers?.find(a => a.commandId === id);
      const pendingAnswers = item.handler === 'analysis' && m?.analysisRunId === item.runId &&
        store.get('analysis-run', item.runId)?.result?.issues.some(i => !(m.clarifications ?? []).some(a => a.analysisId === item.runId && a.issueId === i.id));
      const observedResume = ['requested', 'waiting-answers'].includes(resume?.state) && request ? { ...resume,
        state: ['failed', 'completed', 'cancelled'].includes(request.state) ? request.state :
          resume.state === 'waiting-answers' && pendingAnswers ? 'waiting-answers' :
          request.state === 'waiting' ? 'blocked' : recoveryAnswer?.state === 'reviewed' || item.handler === 'analysis' && m?.analysisRunId !== item.runId ? 'resumed' : 'requested',
        reason: request.state === 'waiting' && !pendingAnswers ? request.preparation?.issues?.map(i => i.message).join('\n') || m?.reason : pendingAnswers ? resume.reason : null,
        workerState: requestStatus(request).state, error: request.error?.code ?? null } : resume;
      return { id, action, state, answer, createdAt, appliedAt, resume: observedResume ? pick(observedResume, ['state', 'requestId', 'at', 'reason', 'workerState', 'error', 'detail']) : observedResume, error, errorMessage };
    }) };
  if (item.questions) result.questions = item.questions.map(q => ({ ...pick(q, ['questionId', 'mode', 'title', 'required', 'background',
    'recommendationReason', 'recommendedOptionIds', 'defaultOptionIds', 'minSelections', 'maxSelections']),
    input: inputView(q.input), options: q.options.map(o => ({ ...pick(o, ['optionId', 'label', 'description', 'consequence']), input: inputView(o.input) })),
    evidence: q.evidence.map(e => pick(e, ['path', 'summary'])) }));
  if (item.consent) result.consent = { choices: item.consent.choices.map(c => pick(c, ['index', 'shown'])) };
  if (item.remote) result.remote = { status: item.remote.status, application: pick(item.remote.application, ['state', 'at', 'error']),
    continuation: pick(item.remote.continuation, ['state', 'detail']) };
  return result;
}

/** 목록 조회는 저장된 관측을 투영한다. 동기화와 쓰기 트랜잭션은 호출하지 않는다. */
export function interactionPage(store, query) {
  const paginated = query !== undefined;
  const { box = 'all', page = 1, pageSize = 25, source = '', state = '', groupId = '', projectId = '', stage = '', search = '', itemId = '' } = query ?? {};
  requireThat(['waiting', 'archive', 'all'].includes(box) && Number.isSafeInteger(page) && page > 0 &&
    Number.isSafeInteger(pageSize) && pageSize > 0 && pageSize <= 100, 'invalid-input', 'box와 page·pageSize(1~100)를 확인하세요.');
  requireThat([source, state, groupId, projectId, stage, search, itemId].every(s => typeof s === 'string' && s.length <= 2000),
    'invalid-input', '요청함 필터는 2000자 이하의 문자열이다.');
  requireThat(['', 'master', 'code-agent'].includes(source) && ['', 'pending', 'archive', ...waiting, ...archived].includes(state),
    'invalid-input', '지원하지 않는 발행 주체 또는 요청 상태다.');
  const projects = new Set(store.list('project').filter(p => !p.deletedAt).map(p => p.id)), commands = new Map();
  for (const command of store.list('interaction-command')) {
    if (!commands.has(command.interactionId)) commands.set(command.interactionId, []);
    commands.get(command.interactionId).push(command);
  }
  const all = store.list('interaction').filter(i => i.projectIds.some(id => projects.has(id))).map(item => {
    const history = (commands.get(item.id) ?? []).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const last = history.at(-1);
    return { item, history, state: item.producerState === 'open' && last?.action === 'defer' && last.contentHash === item.contentHash ? 'deferred' : item.producerState };
  });
  const base = paginated ? all.filter(e => !e.item.relatedInteractionId || source === 'master') : all;
  const counts = { waiting: base.filter(e => waiting.has(e.state)).length, archive: base.filter(e => archived.has(e.state)).length };
  let filtered = base.filter(e => (box === 'all' || (box === 'waiting' ? waiting : archived).has(e.state)) &&
    (!source || e.item.source === source) && (!state || (state === 'pending' ? waiting.has(e.state) : state === 'archive' ? archived.has(e.state) : e.state === state)) &&
    (!groupId || e.item.groupIds.includes(groupId)) && (!projectId || e.item.projectIds.includes(projectId)) && (!stage || e.item.stage === stage) &&
    [e.item.title, e.item.taskNumber, e.item.workId, e.item.taskId, e.item.missionId].filter(Boolean).join(' ').toLowerCase().includes(search.toLowerCase()));
  const oldest = (a, b) => a.item.firstSeenAt.localeCompare(b.item.firstSeenAt) || a.item.id.localeCompare(b.item.id);
  if (paginated) filtered.sort(box === 'waiting' ? oldest :
    (a, b) => (b.item.updatedAt ?? b.item.firstSeenAt).localeCompare(a.item.updatedAt ?? a.item.firstSeenAt) || a.item.id.localeCompare(b.item.id));
  const total = filtered.length, actualPage = Math.min(page, Math.max(1, Math.ceil(total / pageSize)));
  if (paginated) filtered = filtered.slice((actualPage - 1) * pageSize, actualPage * pageSize);
  const opened = itemId ? all.find(e => e.item.id === itemId) : null;
  const remaining = opened?.item.handler === 'analysis' ? all.filter(e => e.item.id !== itemId && e.item.handler === 'analysis' &&
    e.item.missionId === opened.item.missionId && e.item.runId === opened.item.runId && ['open', 'deferred'].includes(e.state) && e.item.respondSupported).sort(oldest) : [];
  return { items: filtered.map(e => projectItem(store, e)), total, page: actualPage, pageSize, box, counts,
    stages: [...new Set(all.map(e => e.item.stage))].sort(),
    openedItem: opened ? projectItem(store, opened) : null, nextItem: remaining.length ? projectItem(store, remaining[0]) : null, remainingCount: remaining.length,
    sources: store.list('interaction-source').filter(s => projects.has(s.id)).map(s => pick(s, ['id', 'version', 'responseSupported', 'reason', 'checkedAt', 'error', 'sourceInstanceId'])) };
}
