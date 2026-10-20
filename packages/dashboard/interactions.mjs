import { hash, now, requireThat, string } from '../domain/contracts.mjs';
import { Planner } from '../reasoning/planner.mjs';
import { Engine } from '../orchestrator/engine.mjs';
import { continueRequest, requestStatus } from '../orchestrator/requests.mjs';
import { callOnce, ControlClient, PROTOCOL, PROTOCOL_VERSION } from '../code-agent-adapter/control.mjs';
import { findHumanKey, interactionApiSupported, interactionClient, signInteraction } from '../code-agent-adapter/interactions.mjs';
import { controlProbe } from '../code-agent-adapter/pairing.mjs';
import { recordInteraction } from './history.mjs';
import { preparationIssues } from '../orchestrator/preparation.mjs';

const remoteUnavailable = '현재 code-agent 연동에는 전체 단계 요청 및 인증된 사람 응답 계약이 없습니다. 원래 code-agent 콘솔에서 처리하세요.';
const values = v => Array.isArray(v) ? v : [];
const key = (source, instance, requestId) => hash([source, instance, requestId]);
const options = items => items.map((label, i) => ({ id: String(i + 1), label }));
const recommendation = (items, label) => items.find(o => o.label === label)?.id ?? null;

/** Read the interaction feed when supported; older APIs remain observation-only. */
async function readRemoteInteractions(store, project, cliPath, resolveKey = findHumanKey) {
  const hello = await callOnce(cliPath, project.path, { protocol: PROTOCOL, version: PROTOCOL_VERSION, type: 'hello' }, { timeoutMs: 5000 });
  requireThat(hello.ok, 'interaction-unavailable', 'code-agent 기능 조회에 실패했습니다.');
  const binding = store.get('control-binding', project.id), result = hello.result;
  // The unauthenticated hello also tells the project card why a connection is missing; it never pairs.
  const capability = { version: result.codeAgent?.version ?? null, commands: result.commands ?? {},
    responseSupported: false, reason: remoteUnavailable, checkedAt: now(), control: controlProbe(result) };
  if (!binding) return { capability, questions: null, consents: null };
  const client = new ControlClient({ cliPath, projectPath: project.path, ...binding, timeoutMs: 5000, retries: 0 });
  if (interactionApiSupported(result)) {
    const previous = store.get('interaction-source', project.id);
    let cursor = previous?.cursor ?? 0, sourceInstanceId = previous?.sourceInstanceId ?? null, records = [];
    for (let page = 0; page < 5; page++) {
      const view = await client.result('interactions', { payload: { after: cursor, limit: 200 } });
      requireThat(view?.schemaVersion === 1 && Array.isArray(view.requests) && Number.isInteger(view.cursor), 'interaction-unavailable', '지원하지 않는 interaction 응답입니다.');
      if (sourceInstanceId && view.sourceInstanceId !== sourceInstanceId) { cursor = 0; records = []; sourceInstanceId = view.sourceInstanceId; continue; }
      sourceInstanceId = view.sourceInstanceId; records.push(...view.requests); cursor = view.cursor;
      if (cursor >= view.latestCursor) break;
    }
    // Channel enable/expiry can change without incrementing a request's ledger revision.
    const waiting = store.list('interaction').filter(i => i.handler === 'code-agent' && i.projectIds.includes(project.id) && i.sourceInstanceId === sourceInstanceId &&
      (['open', 'deferred', 'received'].includes(i.producerState) || i.remote?.context.runId && ['queued', 'waiting-host'].includes(i.remote?.continuation?.state)) && !records.some(r => r.requestId === i.requestId));
    const offset = waiting.length ? (previous?.pollOffset ?? 0) % waiting.length : 0;
    const selected = [...waiting.slice(offset), ...waiting.slice(0, offset)].slice(0, 8);
    for (const item of selected) {
      records.push(await client.result('interaction.result', { payload: { requestId: item.requestId } }));
    }
    for (const record of records) record.localKeyAvailable = Boolean(resolveKey(record.humanChannel?.channelId));
    return { capability: { ...capability, responseSupported: true, reason: null, cursor, sourceInstanceId, pollOffset: offset + selected.length }, records };
  }
  const reads = values(result.commands?.read);
  const [questions, consents] = await Promise.all([
    reads.includes('questions') ? client.result('questions') : null,
    reads.includes('consents') ? client.result('consents') : null,
  ]);
  return { capability, questions, consents: consents?.consents ?? null };
}

/** Own requests are applied atomically with their command receipt. External requests stay at their owner. */
export function createInteractions(store, { cliPath, readRemote, resolveHumanKey = findHumanKey, launch, launchOptions = {} } = {}) {
  readRemote ??= (store, project, cli) => readRemoteInteractions(store, project, cli, resolveHumanKey);
  const sending = new Map();
  const resuming = new Set();
  const active = new Set();
  function save(item) {
    const previous = store.get('interaction', item.id);
    const contentHash = hash(item);
    if (previous?.contentHash === contentHash) return previous;
    const saved = store.put('interaction', { ...item, contentHash, firstSeenAt: previous?.firstSeenAt ?? now(), updatedAt: now() }, previous?.revision ?? 0);
    recordInteraction(store, saved);
    return saved;
  }
  function saveRemote(project, record) {
    requireThat(record.schemaVersion === 1 && record.source === 'code-agent' && typeof record.sourceInstanceId === 'string' &&
      Array.isArray(record.questions) && record.context && Number.isInteger(record.revision), 'interaction-unavailable', '요청 스키마가 다릅니다.');
    requireThat(record.questions.every(q => q && typeof q.questionId === 'string' && ['single', 'multiple', 'text'].includes(q.mode) &&
      [q.options, q.recommendedOptionIds, q.defaultOptionIds, q.evidence].every(Array.isArray)), 'interaction-unavailable', '질문 선택 계약이 다릅니다.');
    const owner = store.list('mission').find(m => !['succeeded', 'cancelled'].includes(m.state) && m.attempts.some(a => a.projectId === project.id && a.codeAgentWorkId === record.context.workId && !['succeeded', 'abandoned'].includes(a.state)));
    const attempt = owner?.attempts.find(a => a.projectId === project.id && a.codeAgentWorkId === record.context.workId);
    const ready = record.canRespond && record.localKeyAvailable;
    const item = save({ id: key('code-agent', `${project.id}:${record.sourceInstanceId}`, record.requestId), source: 'code-agent', sourceInstanceId: record.sourceInstanceId,
      requestId: record.requestId, handler: 'code-agent', kind: record.kind === 'consent' ? 'approval' : 'question',
      projectIds: [project.id], groupIds: owner ? owner.scope.groups.map(g => g.id) : store.list('group').filter(g => !g.deletedAt && g.projectIds.includes(project.id)).map(g => g.id),
      missionId: owner?.id ?? null, taskId: attempt?.taskId ?? null, taskNumber: owner?.taskNumber ?? record.context.workId,
      workId: record.context.workId, stage: record.stage, context: record.context, title: record.title,
      body: record.consent?.summary ?? record.title, questions: record.questions, consent: record.consent ?? null,
      options: [], recommendedOptionIds: [], recommendation: '', reason: '', references: [], allowCustom: false, multiple: false,
      changes: record.consent?.choices.map(c => c.shown) ?? [], respondSupported: Boolean(ready),
      unavailableReason: ready ? null : record.unavailableReason || (!['pending', 'deferred'].includes(record.status) ? '이미 응답했거나 종료된 요청입니다.' : '대시보드 서버 계정에서 사람 채널 키를 찾지 못했습니다. code-agent master human enable --controller <제어자>를 확인하세요.'),
      producerState: ({ pending: 'open', responded: 'received', applied: 'answered', superseded: 'expired' })[record.status] ?? record.status,
      originAt: record.createdAt, remote: record });
    const command = record.response?.commandId ? store.get('interaction-command', record.response.commandId) : null;
    if (command?.interactionId === item.id) {
      const patch = { state: record.application?.state === 'failed' || record.status === 'failed' ? 'failed' : record.application?.state === 'applied' || record.status === 'applied' ? 'applied' : 'received',
        receiptId: record.response.receiptId, appliedAt: record.application?.at ?? null, error: record.application?.error ?? null,
        resume: record.continuation ?? { state: 'not-requested' } };
      if (Object.entries(patch).some(([k, v]) => hash(command[k] ?? null) !== hash(v))) store.put('interaction-command', { ...command, ...patch }, command.revision);
    }
    if (owner && record.status === 'applied') {
      const targets = new Set(record.kind === 'consent' ? [record.origin.id] : record.questions.map(q => q.questionId));
      for (const escalation of store.list('escalation').filter(e => e.missionId === owner.id && e.attemptId === attempt.id && e.state === 'open' && targets.has(e.target))) {
        store.put('escalation', { ...escalation, state: 'resolved', resolvedBy: 'observed-code-agent-interaction', resolvedAt: now() }, escalation.revision);
      }
    }
    return item;
  }
  function syncMaster() {
    const active = new Set();
    for (const m of store.list('mission')) {
      if (['succeeded', 'cancelled'].includes(m.state)) continue;
      const common = { source: 'master', sourceInstanceId: m.id, missionId: m.id, projectIds: m.scope.projectIds,
        groupIds: m.scope.groups.map(g => g.id), taskNumber: m.taskNumber ?? null, workId: null,
        context: { missionRevision: m.revision, scope: m.scope }, kind: 'question', allowCustom: true, multiple: false,
        respondSupported: true, unavailableReason: null };
      const request = store.get('target-request', m.id), issues = request ? preparationIssues(request) : [];
      if (issues.length && ['waiting', 'failed'].includes(request.state)) {
        const id = key('master', m.id, `preparation:${request.revision}`);
        // Pairing is an explicit choice only: nothing is preselected and the confirmation dialog performs it.
        const pairable = [...new Set(issues.filter(i => i.canPair).map(i => i.projectId))];
        active.add(id);
        save({ ...common, id, requestId: `preparation:${request.revision}`, handler: 'preparation', taskId: null, stage: 'setup',
          context: { ...common.context, requestRevision: request.revision }, title: `${m.taskNumber ?? '요청'} · 프로젝트 실행 준비 필요`,
          body: issues.map(i => `${store.get('project', i.projectId)?.name ?? i.projectId}: ${i.message}\n${i.guidance}${i.command ? `\n${i.command}` : ''}`).join('\n\n') +
            (launchOptions.dbPath ? `\n\n현재 대시보드 DB: ${launchOptions.dbPath}` : ''),
          reason: '실행에 필요한 준비가 부족해 요청이 대기 중입니다. 다시 확인하면 근거·설치·연결을 재점검하고 같은 요청·TASK에서 이어갑니다.',
          references: issues.map(i => `${i.projectId}:${i.code}`),
          options: [...(pairable.length ? [{ id: 'pair-recheck', label: '제어 연결 후 기존 요청 이어 실행' }] : []), { id: 'recheck', label: '준비 상태 다시 확인하고 기존 요청 이어 실행' }],
          pairing: pairable.length ? { projectIds: pairable } : null,
          recommendedOptionIds: pairable.length ? [] : ['recheck'], recommendation: pairable.length ? '' : '준비 상태 다시 확인하고 기존 요청 이어 실행', allowCustom: false,
          respondSupported: m.state !== 'paused', unavailableReason: m.state === 'paused' ? '일시 정지된 목표입니다. 먼저 재개하세요.' : null,
          producerState: 'open', originAt: request.updatedAt });
      }
      const run = m.analysisRunId ? store.get('analysis-run', m.analysisRunId) : null;
      if (run && m.planningHold && ['blocked', 'waiting-decision'].includes(m.state) && ['needs-context', 'needs-human'].includes(run.status)) {
        for (const issue of run.result.issues) {
          const id = key('master', m.id, `${run.id}:${issue.id}`);
          if (values(m.clarifications).some(a => a.analysisId === run.id && a.issueId === issue.id)) continue;
          const choices = options(issue.options);
          active.add(id);
          save({ ...common, id, requestId: issue.id, runId: run.id, handler: 'analysis', taskId: null, stage: m.replanPending ? 'replanning' : 'planning',
            title: issue.question, body: issue.question, reason: issue.reason, references: issue.references,
            options: choices, recommendedOptionIds: [recommendation(choices, issue.recommendation)].filter(Boolean),
            recommendation: issue.recommendation, producerState: 'open', originAt: run.finishedAt ?? run.startedAt });
        }
      }
      for (const a of m.attempts) {
        if (!['blocked', 'waiting-decision'].includes(m.state)) continue;
        const recovery = a.recoveryRunId ? store.get('recovery-run', a.recoveryRunId) : null;
        if (recovery?.state !== 'held' || !recovery.proposal ||
            a.state !== 'verification-failed' || values(m.recoveryAnswers).some(r => r.runId === recovery.id)) continue;
        const id = key('master', m.id, recovery.id), proposal = recovery.proposal, choices = options(proposal.alternatives);
        active.add(id);
        save({ ...common, id, requestId: recovery.id, runId: recovery.id, handler: 'recovery', taskId: a.taskId,
          projectIds: [a.projectId], workId: a.codeAgentWorkId, stage: 'recovery',
          context: { ...common.context, attemptId: a.id, verificationRunId: a.verificationRunId, sessionId: a.turns.at(-1)?.result?.sessionId ?? null },
          title: proposal.question || proposal.summary, body: proposal.question || proposal.summary,
          reason: proposal.cause, references: proposal.references, options: choices,
          respondSupported: ['needs-context', 'needs-human'].includes(proposal.action),
          unavailableReason: ['needs-context', 'needs-human'].includes(proposal.action) ? null : '재계획·범위·권한 또는 복구 한도 검토입니다. 기존 recovery/replan CLI에서 처리하세요.',
          recommendedOptionIds: [recommendation(choices, proposal.recommendation)].filter(Boolean), recommendation: proposal.recommendation,
          producerState: 'open', originAt: recovery.decidedAt ?? recovery.startedAt });
      }
      for (const escalation of store.list('escalation').filter(e => e.missionId === m.id && e.state === 'open')) {
        const a = m.attempts.find(a => a.id === escalation.attemptId);
        const id = key('master', m.id, escalation.id); active.add(id);
        save({ ...common, id, requestId: escalation.id, handler: 'escalation', taskId: escalation.taskId,
          projectIds: [escalation.projectId], workId: a?.codeAgentWorkId ?? null, stage: 'decision',
          kind: escalation.kind === 'consent' ? 'approval' : 'question', title: `사람 판단 필요: ${escalation.target}`,
          body: escalation.reason, reason: escalation.judgment?.reason ?? escalation.reason, references: escalation.judgment?.evidence ?? [],
          options: [], recommendedOptionIds: [], recommendation: '', allowCustom: false,
          respondSupported: false, unavailableReason: 'code-agent에서 발생한 질문·동의입니다. 원래 요청의 전문과 사람 채널로 처리해야 합니다.',
          producerState: 'open', originAt: escalation.createdAt });
      }
    }
    for (const item of store.list('interaction').filter(i => i.source === 'master' && i.producerState === 'open' && !active.has(i.id))) {
      const { revision, contentHash, firstSeenAt, updatedAt, ...old } = item;
      save({ ...old, producerState: store.list('interaction-command').some(c => c.interactionId === item.id && c.action === 'answer') ? 'answered' : 'expired' });
    }
  }
  async function refreshProject(project) {
    let remote, error;
    try { remote = await readRemote(store, project, cliPath); } catch (e) { error = e.code ?? 'interaction-unavailable'; }
    store.transaction(() => {
      if (store.get('project', project.id)?.deletedAt) return;
      const previous = store.get('interaction-source', project.id);
      store.put('interaction-source', { id: project.id, ...(remote?.capability ?? previous ?? {}), error: error ?? null, checkedAt: now() }, previous?.revision ?? 0);
      if (error) return; // Failure never closes outstanding requests.
      if (remote.records) {
        for (const item of store.list('interaction').filter(i => i.source === 'code-agent' && i.projectIds.includes(project.id) &&
          (i.handler === 'legacy' || i.sourceInstanceId !== remote.capability.sourceInstanceId) && ['open', 'received', 'deferred'].includes(i.producerState))) {
          const { revision, contentHash, firstSeenAt, updatedAt, ...old } = item;
          save({ ...old, producerState: 'expired', respondSupported: false, unavailableReason: '요청 원장 또는 연동 계약이 변경되었습니다. 새 요청을 확인하세요.' });
        }
        for (const record of remote.records) saveRemote(project, record);
        return;
      }
      const observation = store.get('observation', project.id), state = observation?.state;
      if (observation?.status !== 'observed' || !state) return;
      const workId = remote.questions?.workId ?? state.work?.id ?? null;
      const instance = hash([project.id, project.path, state.repo, workId]);
      const owner = store.list('mission').find(m => !['succeeded', 'cancelled'].includes(m.state) && m.attempts.some(a =>
        a.projectId === project.id && a.codeAgentWorkId === workId && !['succeeded', 'abandoned'].includes(a.state)));
      const attempt = owner?.attempts.find(a => a.projectId === project.id && a.codeAgentWorkId === workId);
      const groups = owner ? owner.scope.groups.map(g => g.id) : store.list('group').filter(g => !g.deletedAt && g.projectIds?.includes(project.id)).map(g => g.id);
      const common = { source: 'code-agent', sourceInstanceId: instance, projectIds: [project.id], groupIds: groups,
        missionId: owner?.id ?? null, taskId: attempt?.taskId ?? null, taskNumber: owner?.taskNumber ?? workId, workId, stage: state.work?.phase ?? 'setup',
        context: { projectPath: project.path, repo: state.repo, stateVersion: state.stateVersion, workId },
        handler: 'legacy', respondSupported: false, unavailableReason: remoteUnavailable,
        allowCustom: false, multiple: false, recommendedOptionIds: [], recommendation: '', references: [], reason: '', producerState: 'open' };
      const seen = new Set();
      const questions = remote.questions?.questions ?? values(state.questions?.unanswered).map(q => ({ id: typeof q === 'string' ? q : q.id }));
      for (const q of questions.filter(q => !q.answered)) {
        const id = key('code-agent', instance, `question:${q.id}`); seen.add(id);
        save({ ...common, id, requestId: q.id, kind: 'question', title: q.title || `code-agent 질문 ${q.id}`,
          body: q.body || '질문 전문을 읽으려면 기존 master 제어 연결이 필요합니다.', options: Object.entries(q.options ?? {}).map(([id, label]) => ({ id, label })),
          context: { ...common.context, questionsHash: remote.questions?.questionsHash ?? null }, originAt: null });
      }
      for (const c of remote.consents ?? values(state.consents?.open)) {
        if (['applied', 'cancelled', 'expired', 'rejected', 'verified'].includes(c.status)) continue;
        const id = key('code-agent', instance, `consent:${c.id}`); seen.add(id);
        save({ ...common, id, requestId: c.id, kind: 'approval', title: `code-agent 승인: ${c.action}`,
          body: c.summary || '승인 전문을 조회할 수 없습니다. code-agent 콘솔에서 확인하세요.', options: [],
          changes: values(c.choices).map(choice => choice.shown), context: { ...common.context, shownHash: c.shownHash ?? null }, originAt: c.createdAt ?? null });
      }
      for (const item of store.list('interaction').filter(i => i.source === 'code-agent' && i.projectIds.includes(project.id) && i.producerState === 'open' && !seen.has(i.id))) {
        const { revision, contentHash, firstSeenAt, updatedAt, ...old } = item;
        save({ ...old, producerState: 'closed', unavailableReason: '최신 관측의 대기 목록에서 사라졌습니다. 적용·재개 성공을 의미하지 않습니다.' });
      }
    });
  }
  function snapshot() {
    store.transaction(syncMaster);
    const projects = new Set(store.list('project').filter(p => !p.deletedAt).map(p => p.id));
    const commands = store.list('interaction-command');
    return { sources: store.list('interaction-source').filter(s => projects.has(s.id)),
      items: store.list('interaction').filter(i => i.projectIds.some(id => projects.has(id))).map(item => {
        const history = commands.filter(c => c.interactionId === item.id).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        const last = history.at(-1);
        return { ...item, state: item.producerState === 'open' && last?.action === 'defer' && last.contentHash === item.contentHash ? 'deferred' : item.producerState,
          history: history.map(({ id, action, state, answer, createdAt, appliedAt, resume, error }) => {
            const request = resume?.requestId ? store.get('target-request', resume.requestId) : null;
            const m = item.missionId ? store.get('mission', item.missionId) : null;
            const recoveryAnswer = m?.recoveryAnswers?.find(a => a.commandId === id);
            const observedResume = resume?.state === 'requested' && request ? { ...resume,
              state: request.state === 'failed' ? 'failed' : recoveryAnswer?.state === 'reviewed' || item.handler === 'analysis' && m?.analysisRunId !== item.runId ? 'resumed' : 'requested',
              workerState: requestStatus(request).state, error: request.error?.code ?? null } : resume;
            return { id, action, state, answer, createdAt, appliedAt, resume: observedResume, error };
          }) };
      }) };
  }
  async function respond(input) {
    string(input.commandId, 'commandId');
    string(input.id, 'id'); string(input.contentHash, 'contentHash');
    requireThat(Number.isInteger(input.revision) && input.revision > 0 && input.context && typeof input.context === 'object' && !Array.isArray(input.context), 'invalid-input', '질문 버전과 대상 문맥이 필요합니다.');
    requireThat(input.commandId.length <= 128, 'invalid-input', 'commandId가 너무 깁니다.');
    const inputHash = hash(input);
    const existing = store.get('interaction-command', input.commandId);
    if (existing?.remoteWire) {
      requireThat(existing.inputHash === inputHash, 'request-conflict', '같은 commandId에 다른 답변을 보낼 수 없습니다.');
      return existing.state === 'unknown' ? transmit(existing.id) : existing;
    }
    const remoteItem = store.get('interaction', input.id);
    if (!existing && remoteItem?.handler === 'code-agent') return respondRemote(remoteItem, input, inputHash);
    let shouldLaunch = false;
    const receipt = store.transaction(() => {
      const previous = store.get('interaction-command', input.commandId);
      if (previous) {
        requireThat(previous.inputHash === inputHash, 'request-conflict', '같은 commandId에 다른 답변을 보낼 수 없습니다.');
        return previous;
      }
      syncMaster();
      const item = store.need('interaction', input.id);
      requireThat(item.revision === input.revision && item.contentHash === input.contentHash && hash(item.context) === hash(input.context), 'stale-question', '질문 또는 대상 문맥이 변경됐습니다. 최신 질문을 다시 열어 확인하세요.');
      requireThat(item.producerState === 'open', 'stale-question', '이미 처리되거나 만료된 질문입니다.');
      for (const id of item.projectIds) {
        requireThat(!store.need('project', id).deletedAt, 'stale-question', '등록 해제된 프로젝트입니다.');
        requireThat(!store.get('project-maintenance', id)?.active, 'project-busy', '프로젝트 업데이트가 진행 중입니다.');
      }
      requireThat(['answer', 'defer'].includes(input.action), 'invalid-input', '답변 또는 보류를 선택하세요.');
      let answer = null;
      if (input.action === 'answer') {
        requireThat(item.respondSupported && item.source === 'master' && item.kind === 'question', 'interaction-unsupported', item.unavailableReason || remoteUnavailable);
        requireThat(!store.list('interaction-command').some(c => c.interactionId === item.id && c.action === 'answer'), 'stale-question', '이미 답변을 제출했습니다.');
        const selected = input.optionIds ?? [];
        requireThat(Array.isArray(selected) && selected.length <= (item.multiple ? item.options.length : 1) && new Set(selected).size === selected.length && selected.every(id => item.options.some(o => o.id === id)), 'invalid-input', '유효한 선택지를 선택하세요.');
        requireThat(typeof (input.custom ?? '') === 'string' && !(selected.length && input.custom?.trim()), 'invalid-input', '선택지 또는 직접 입력 중 하나로 답변하세요.');
        answer = selected.length ? selected.map(id => item.options.find(o => o.id === id).label).join('\n') : input.custom?.trim();
        requireThat(typeof answer === 'string' && answer.length > 0 && answer.length <= 16000 && (selected.length || item.allowCustom), 'invalid-input', '답변은 1~16000자입니다.');
        const request = store.get('target-request', item.missionId);
        requireThat(!request || !['running', 'queued'].includes(requestStatus(request).state), 'request-busy', '기존 요청 실행기가 종료될 때까지 기다려 주세요.');
      }
      let command = store.put('interaction-command', { id: input.commandId, interactionId: item.id, missionId: item.missionId,
        inputHash, contentHash: item.contentHash, action: input.action, answer, state: 'received', createdAt: now(), resume: { state: 'not-requested' } });
      if (input.action === 'answer') {
        if (item.handler === 'preparation') {
          const m = new Engine(store).checked(item.missionId, item.context.missionRevision), request = store.need('target-request', m.id);
          requireThat(!['paused', 'succeeded', 'cancelled'].includes(m.state) && request.revision === item.context.requestRevision, 'stale-question', '요청 상태가 변경되었습니다. 다시 확인하세요.');
          requireThat(input.resume === true, 'invalid-input', '준비 재점검은 기존 요청 재개로 제출하세요.');
          if ((input.optionIds ?? []).includes('pair-recheck')) requireThat(item.pairing?.projectIds.every(id => store.get('control-binding', id)), 'stale-question',
            '제어 연결이 아직 등록되지 않았습니다. 확인 화면에서 연결한 뒤 다시 제출하세요.');
        }
        else if (item.handler === 'analysis') new Planner(store).clarify(item.missionId, { analysisId: item.runId, answers: [{ issueId: item.requestId, answer }] }, item.context.missionRevision, { inTransaction: true });
        else {
          const engine = new Engine(store), m = engine.checked(item.missionId, item.context.missionRevision);
          const a = m.attempts.find(a => a.id === item.context.attemptId), run = store.need('recovery-run', item.runId);
          requireThat(a?.recoveryRunId === run.id && !a.recoveryBusy && a.verificationRunId === item.context.verificationRunId && run.state === 'held', 'stale-question', '복구 대상이 변경되었습니다.');
          const decision = engine.decision(m, 'clarify-recovery', { actor: 'human', reason: '사용자가 복구 질문에 답변했습니다.', evidence: [run.id], alternatives: run.proposal.alternatives, nextAction: 'reanalyze-recovery', verification: '기존 복구 검증을 다시 수행', answer });
          m.recoveryAnswers = [...values(m.recoveryAnswers), { commandId: command.id, runId: run.id, attemptId: a.id, verificationRunId: a.verificationRunId, answer, decisionId: decision.id, state: 'queued' }];
          engine.save(m, 'recovery-clarified', { runId: run.id, decisionId: decision.id });
        }
        command = { ...command, state: 'applied', appliedAt: now() };
        const m = store.need('mission', item.missionId), request = store.get('target-request', m.id);
        const unanswered = item.handler === 'analysis' && store.need('analysis-run', item.runId).result.issues.some(i => !values(m.clarifications).some(a => a.analysisId === item.runId && a.issueId === i.id));
        if (input.resume === true && request && !unanswered) {
          requireThat(typeof launch === 'function', 'interaction-unsupported', '요청 실행기가 연결되지 않았습니다.');
          continueRequest(store, request.id, request.revision, { inTransaction: true });
          command.resume = { state: 'launching', requestId: request.id, at: now() }; shouldLaunch = true;
        } else if (input.resume === true) command.resume = { state: unanswered ? 'waiting-answers' : 'manual', reason: unanswered ? '나머지 분석 질문에 답변해야 합니다.' : 'CLI에서 생성한 목표입니다. 기존 분석/복구 명령으로 이어가세요.' };
      } else command.state = 'deferred';
      store.event(item.missionId ?? item.projectIds[0], 'interaction-response', { commandId: command.id, interactionId: item.id, action: input.action });
      return store.put('interaction-command', command, command.revision);
    });
    if (shouldLaunch) {
      resuming.add(receipt.id);
      let resume;
      try {
        const request = await launch(store, receipt.missionId, launchOptions);
        resume = { state: 'requested', requestId: request.id, at: now() };
      } catch (e) { resume = { state: 'failed', requestId: receipt.missionId, error: e.code ?? 'worker-start-failed', at: now() }; }
      store.transaction(() => {
        const command = store.need('interaction-command', receipt.id);
        store.put('interaction-command', { ...command, resume }, command.revision);
      });
      resuming.delete(receipt.id);
    }
    return store.need('interaction-command', receipt.id);
  }
  async function respondRemote(item, input, inputHash) {
    const project = store.need('project', item.projectIds[0]);
    const binding = store.need('control-binding', project.id);
    const client = interactionClient(store, project, cliPath);
    const fresh = await client.result('interaction', { payload: { requestId: item.requestId } });
    const replay = store.get('interaction-command', input.commandId);
    if (replay) { requireThat(replay.inputHash === inputHash, 'request-conflict', '같은 commandId의 내용이 다릅니다.'); return replay; }
    requireThat(fresh.sourceInstanceId === item.sourceInstanceId && fresh.revision === item.remote.revision && fresh.contentHash === item.remote.contentHash && hash(fresh.context) === hash(item.context), 'stale-question', '원래 요청의 버전·내용·브랜치·세션이 바뀌었습니다. 다시 조회하세요.');
    requireThat(fresh.canRespond, 'interaction-unavailable', fresh.unavailableReason || '응답 가능한 요청이 아닙니다.');
    requireThat(['answer', 'approve', 'request-changes', 'defer', 'reopen'].includes(input.action), 'invalid-input', '지원하지 않는 응답입니다.');
    const submission = { explicit: true, intent: ({ defer: 'defer', reopen: 'reopen' })[input.action] ?? 'submit' };
    if (submission.intent === 'submit') {
      if (item.kind === 'approval') {
        requireThat(input.reviewed === true && ['approve', 'request-changes'].includes(input.action), 'invalid-input', '승인 전문 확인과 명시적 선택이 필요합니다.');
        Object.assign(submission, { verdict: input.action, shownHash: fresh.consent.shownHash });
        if (input.action === 'approve') {
          requireThat(input.choices && typeof input.choices === 'object' && !Array.isArray(input.choices) && Object.keys(input.choices).length === fresh.consent.choices.length &&
            fresh.consent.choices.every(c => ['적용', '유지'].includes(input.choices[String(c.index)])), 'invalid-input', '모든 변경 대상을 적용/유지 중 명시적으로 선택하세요.');
          submission.choices = input.choices;
        }
      } else {
        requireThat(input.action === 'answer' && Array.isArray(input.answers) && input.answers.length <= 16 && input.answers.every(a =>
          a && typeof a.questionId === 'string' && (!a.optionIds || Array.isArray(a.optionIds) && a.optionIds.length <= 16 && a.optionIds.every(v => typeof v === 'string')) &&
          (a.text === undefined || typeof a.text === 'string' && a.text.length <= 8000) && Object.keys(a).every(k => ['questionId', 'optionIds', 'text', 'optionInputs'].includes(k))), 'invalid-input', '질문별 선택과 직접 입력이 필요합니다.');
        submission.answers = input.answers;
      }
    }
    const wire = signInteraction(binding, fresh, submission, input.commandId, resolveHumanKey(fresh.humanChannel?.channelId));
    store.transaction(() => {
      const current = store.need('interaction', item.id);
      requireThat(current.revision === input.revision && current.contentHash === input.contentHash && hash(current.context) === hash(input.context), 'stale-question', '화면을 연 뒤 요청이 변경됐습니다.');
      requireThat(!store.need('project', project.id).deletedAt, 'stale-question', '프로젝트 등록이 해제되었습니다.');
      requireThat(!store.get('project-maintenance', project.id)?.active, 'project-busy', '프로젝트 업데이트가 진행 중입니다.');
      const prior = store.get('interaction-command', input.commandId);
      if (prior) { requireThat(prior.inputHash === inputHash, 'request-conflict', '같은 commandId의 내용이 다릅니다.'); return; }
      requireThat(!store.list('interaction-command').some(c => c.interactionId === item.id && ['sending', 'unknown', 'received'].includes(c.state)), 'request-busy', '이 요청의 응답을 전송·적용 중입니다. 기존 응답 결과를 확인하세요.');
      store.put('interaction-command', { id: input.commandId, interactionId: item.id, projectId: project.id, missionId: item.missionId,
        inputHash, contentHash: item.contentHash, action: input.action, answer: input.answers ? JSON.stringify(input.answers) : input.action,
        state: 'sending', createdAt: now(), resume: { state: 'not-requested' }, remoteWire: wire,
        controller: binding.controller, generation: binding.generation, sourceInstanceId: item.sourceInstanceId });
      store.event(item.missionId ?? project.id, 'interaction-response-sending', { commandId: input.commandId, interactionId: item.id });
    });
    return transmit(input.commandId);
  }
  function transmit(id) {
    if (sending.has(id)) return sending.get(id);
    const run = (async () => {
      const command = store.need('interaction-command', id);
      if (!['sending', 'unknown'].includes(command.state)) return command;
      const project = store.need('project', command.projectId), binding = store.need('control-binding', project.id);
      requireThat(!project.deletedAt && binding.controller === command.controller && binding.generation === command.generation, 'stale-question', '응답 대상 또는 소유권이 바뀌었습니다.');
      requireThat(!store.get('project-maintenance', project.id)?.active, 'project-busy', '프로젝트 업데이트 중입니다.');
      let patch;
      try {
        const result = await interactionClient(store, project, cliPath).result('interaction.respond', command.remoteWire);
        patch = { state: result.status === 'deferred' ? 'deferred' : result.status === 'pending' ? 'reopened' : 'received', receivedAt: now(), receiptId: result.receiptId ?? null, error: null };
      } catch (error) { patch = { state: error.code === 'control-unavailable' ? 'unknown' : 'failed', error: error.code ?? 'interaction-failed' }; }
      store.transaction(() => {
        const current = store.need('interaction-command', id);
        if (['sending', 'unknown'].includes(current.state)) store.put('interaction-command', { ...current, ...patch }, current.revision);
      });
      await refreshProject(project);
      return store.need('interaction-command', id);
    })().finally(() => sending.delete(id));
    sending.set(id, run); return run;
  }
  async function retry(commandId) {
    const command = store.need('interaction-command', commandId);
    if (!command.remoteWire && command.resume?.state === 'launching') {
      if (resuming.has(commandId)) return command;
      resuming.add(commandId);
      try {
        const request = store.need('target-request', command.missionId);
        // Do not reset a running/finished worker to queued. Competing workers can claim queued only once.
        if (request.state === 'queued') {
          try { await launch(store, request.id, launchOptions); }
          catch (error) { if (error.code !== 'request-busy') throw error; }
        }
        return store.transaction(() => {
          const current = store.need('interaction-command', commandId);
          return store.put('interaction-command', { ...current, resume: { state: 'requested', requestId: request.id, at: now() } }, current.revision);
        });
      } finally { resuming.delete(commandId); }
    }
    requireThat(command.remoteWire && ['unknown', 'sending'].includes(command.state), 'invalid-input', '결과 미확인 응답만 같은 접수 번호로 재전송합니다.');
    return transmit(commandId);
  }
  const tracked = action => (...args) => {
    const task = action(...args).finally(() => active.delete(task)); active.add(task); return task;
  };
  return { snapshot, respond: tracked(respond), refreshProject, retry: tracked(retry), async stop() { await Promise.allSettled([...active, ...sending.values()]); } };
}
