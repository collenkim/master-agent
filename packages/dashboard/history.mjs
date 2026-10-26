import { hash, now, requireThat } from '../domain/contracts.mjs';
import { ControlClient } from '../code-agent-adapter/control.mjs';

const text = value => typeof value === 'string' ? value.slice(0, 2000) : null;
const list = value => Array.isArray(value) ? value : [];
const number = value => Number.isFinite(value) ? value : null;
const bool = value => typeof value === 'boolean' ? value : null;
const fields = (value, names) => Object.fromEntries(names.map(name => [name, text(value?.[name])]));
const phases = value => Object.entries(value ?? {}).slice(0, 30).map(([phase, v]) => ({ phase: text(phase), round: number(v?.round), runs: number(v?.runs), passed: bool(v?.passed) }));

/** Explicit public projection: never copy model prompts, credentials or arbitrary event payloads. */
export function stageDetails(state) {
  return {
    work: state?.work ? fields(state.work, ['id', 'phase', 'stage', 'task', 'branch']) : null,
    branch: text(state?.repo?.branch), attempt: state?.attempt ? fields(state.attempt, ['id', 'kind']) : null,
    planning: state?.planning ? { attempts: list(state.planning.attempts).map(a => ({ ...fields(a, ['task', 'role', 'phase', 'dispatchId', 'status', 'at']),
      run: a?.run ? { state: text(a.run.state), observedStart: bool(a.run.observedStart) } : null })) } : null,
    verification: state?.verification ? { rounds: number(state.verification.rounds),
      bound: { valid: bool(state.verification.bound?.valid), problems: list(state.verification.bound?.problems).map(text) }, phases: phases(state.verification.phases) } : null,
    review: state?.review ? { rounds: number(state.review.rounds) } : null,
    resume: state?.resume ? { code: text(state.resume.code), reasons: list(state.resume.reasons).map(r => text(typeof r === 'string' ? r : r?.detail ?? r?.code)) } : null,
    questions: state?.questions ? { unanswered: list(state.questions.unanswered).map(q => text(typeof q === 'string' ? q : q?.id)), unverified: list(state.questions.unverified).map(text) } : null,
    consents: list(state?.consents?.open).map(c => fields(c, ['id', 'action', 'status'])),
  };
}

function append(store, projectId, entry) {
  const run = entry.runId ? store.get('control-run', entry.runId) : null;
  const mission = run?.projectId === projectId ? store.get('mission', run.missionId) : null;
  const groupIds = mission ? mission.scope.groups.map(g => g.id) : store.list('group').filter(g => !g.deletedAt && g.projectIds.includes(projectId)).map(g => g.id);
  store.event(projectId, 'stage-history', { projectId, groupIds, ...entry });
}

/** Called inside the observation transaction, so superseded polls cannot create history. */
export function recordObservation(store, projectId, observation) {
  const previous = store.get('stage-observation', projectId);
  const detail = observation.state ? stageDetails(observation.state) : null;
  const fingerprint = hash({ status: observation.status, detail });
  if (previous?.fingerprint === fingerprint) return;
  const before = previous?.detail ?? null;
  append(store, projectId, { source: 'observation', type: detail ? before ? 'state.changed' : 'state.observed' : 'observation.unavailable',
    occurredAt: observation.state?.observedAt ?? observation.recordedAt, workId: detail?.work?.id ?? before?.work?.id ?? null,
    branch: detail?.branch ?? before?.branch ?? null, runId: text(observation.state?.correlation?.runId),
    attemptId: detail?.attempt?.id ?? null, status: observation.status, error: text(observation.error),
    before, detail });
  store.put('stage-observation', { id: projectId, fingerprint, detail: detail ?? before }, previous?.revision ?? 0);
}

export function recordInteraction(store, item) {
  const detail = { title: text(item.title), kind: item.kind, stage: text(item.stage), status: item.producerState,
    application: text(item.remote?.application?.state), continuation: text(item.remote?.continuation?.state) };
  const fingerprint = hash(detail), previous = store.get('stage-interaction', item.id);
  if (previous?.fingerprint === fingerprint) return;
  for (const projectId of item.projectIds) append(store, projectId, { source: 'interaction', type: `interaction.${item.producerState}`,
    occurredAt: now(), interactionId: item.id, workId: item.workId ?? null, runId: text(item.remote?.context?.runId),
    missionId: item.missionId ?? null, taskId: item.taskId ?? null, taskNumber: item.taskNumber ?? null,
    groupIds: item.groupIds, detail });
  store.put('stage-interaction', { id: item.id, fingerprint }, previous?.revision ?? 0);
}

function eventDetails(event) {
  const d = event.data;
  return { ...fields(d, ['workId', 'previousWork', 'from', 'to', 'code', 'action', 'status', 'state', 'outcome', 'q', 'id']),
    reasons: list(d?.reasons).map(r => text(typeof r === 'string' ? r : r?.detail ?? r?.code)),
    phases: phases(d?.phases), boundValid: bool(d?.bound?.valid) };
}

/** A separate cursor from the execution host: reading the dashboard never consumes its events. */
export function createHistory(store, { cliPath, clientFor = project => new ControlClient({ cliPath, projectPath: project.path,
  ...store.need('control-binding', project.id), timeoutMs: 5000, retries: 0 }) } = {}) {
  async function refreshProject(project) {
    if (!store.get('control-binding', project.id)) return;
    try {
      const client = clientFor(project);
      for (let page = 0; page < 5; page++) {
        const cursor = store.get('stage-source', project.id);
        const read = await client.result('events', { payload: { after: cursor?.seq ?? 0, limit: 200, ...(cursor?.logId ? { logId: cursor.logId } : {}) } });
        requireThat(Array.isArray(read.events) && typeof read.logId === 'string' && Number.isInteger(read.latestSeq) && read.latestSeq >= 0,
          'invalid-history', '이벤트 응답 형식이 다릅니다.');
        // code-agent doc/master-control.md와 src/agent/master/store.ts: gap의 events는 빈 배열이다.
        requireThat(!read.gap || read.events.length === 0, 'invalid-history', 'gap 응답에는 이벤트를 함께 보낼 수 없습니다.');
        let last = cursor?.seq ?? 0;
        for (const event of read.events) {
          requireThat(Number.isInteger(event.seq) && event.seq > last && event.seq <= read.latestSeq && typeof event.type === 'string', 'invalid-history', '이벤트 순번이 올바르지 않습니다.');
          last = event.seq;
        }
        const saved = store.transaction(() => {
          if (store.get('project', project.id)?.deletedAt || (store.get('stage-source', project.id)?.revision ?? 0) !== (cursor?.revision ?? 0)) return false;
          if (read.gap) {
            // Resume at the oldest retained event, instead of discarding the whole available ledger.
            requireThat(Number.isInteger(read.firstSeq) && read.firstSeq > 0 && read.firstSeq <= read.latestSeq + 1, 'invalid-history', '이벤트 시작 순번이 올바르지 않습니다.');
            append(store, project.id, { source: 'code-agent', type: 'history.gap', occurredAt: now(), logId: read.logId,
              reason: text(read.reason), previousLogId: cursor?.logId ?? null, fromSeq: cursor?.seq ?? 0, firstSeq: read.firstSeq });
            last = read.firstSeq - 1;
          } else {
            requireThat(!cursor?.logId || cursor.logId === read.logId, 'invalid-history', '누락 표시 없이 이벤트 원장이 바뀌었습니다.');
            for (const event of read.events) {
              const sourceKey = hash([project.id, read.logId, event.seq]);
              if (store.get('stage-event-seen', sourceKey)) continue;
              const detail = eventDetails(event);
              append(store, project.id, { source: 'code-agent', type: text(event.type), occurredAt: text(event.at), logId: read.logId, seq: event.seq,
                workId: detail.workId ?? detail.previousWork, branch: null, runId: text(event.runId), attemptId: null, detail });
              store.put('stage-event-seen', { id: sourceKey });
            }
          }
          store.put('stage-source', { id: project.id, logId: read.logId, seq: last, latestSeq: read.latestSeq, checkedAt: now(), error: null }, cursor?.revision ?? 0);
          return true;
        });
        if (!saved || !read.gap && last >= read.latestSeq) return;
      }
    } catch (error) {
      store.transaction(() => {
        if (store.get('project', project.id)?.deletedAt) return;
        const old = store.get('stage-source', project.id);
        store.put('stage-source', { ...old, id: project.id, checkedAt: now(), error: text(error.code ?? 'history-unavailable') }, old?.revision ?? 0);
      });
    }
  }
  return { refreshProject };
}

/** Stable reverse ingestion order, paginated independently from the overview payload. */
export function historyPage(store, { projectId = '', groupId = '', task = '', before = '', limit = 50 } = {}) {
  const cursor = before === '' ? Number.MAX_SAFE_INTEGER : Number(before);
  requireThat(Number.isSafeInteger(cursor) && cursor > 0 && Number.isInteger(limit) && limit > 0 && limit <= 100, 'invalid-input', '이력 커서와 조회 개수를 확인하세요.');
  const projects = store.list('project').filter(p => !p.deletedAt);
  const projectIds = projects.map(p => p.id);
  if (projectId) requireThat(projectIds.includes(projectId), 'not-found', '등록된 프로젝트가 아닙니다.');
  if (groupId) requireThat(store.get('group', groupId) && !store.get('group', groupId).deletedAt, 'not-found', '등록된 그룹이 아닙니다.');
  const rows = store.db.prepare(`SELECT sequence, at, body FROM events WHERE type='stage-history' AND sequence < ?
    AND mission_id IN (SELECT id FROM records WHERE kind='project' AND json_extract(body,'$.deletedAt') IS NULL)
    ${projectId ? 'AND mission_id = ?' : ''} ORDER BY sequence DESC`).iterate(cursor, ...(projectId ? [projectId] : []));
  const runs = new Map(store.list('control-run').map(r => [r.id, r]));
  const missions = new Map(store.list('mission').map(m => [m.id, m]));
  const items = [];
  for (const row of rows) {
    const item = { ...JSON.parse(row.body), sequence: row.sequence, recordedAt: row.at };
    // Only an exact run binding may link an event to a master TASK; never match by current branch/work alone.
    const run = runs.get(item.runId), mission = run?.projectId === item.projectId ? missions.get(run.missionId) : item.source === 'interaction' ? missions.get(item.missionId) : null;
    const attempt = mission?.attempts.find(a => a.id === run?.attemptId);
    item.missionId = mission?.id ?? null; item.taskId ??= attempt?.taskId ?? null; item.taskNumber ??= mission?.taskNumber ?? null;
    item.workId ??= attempt?.codeAgentWorkId ?? null;
    if (groupId && !item.groupIds.includes(groupId) && !mission?.scope.groups.some(g => g.id === groupId)) continue;
    if (task && ![item.workId, item.taskId, item.taskNumber, item.runId, item.attemptId, item.detail?.work?.task].some(v => typeof v === 'string' && v.toLowerCase().includes(task.toLowerCase()))) continue;
    items.push(item);
    if (items.length > limit) break;
  }
  return { items: items.slice(0, limit), nextBefore: items.length > limit ? items[limit - 1].sequence : null,
    sources: projects.filter(p => !projectId || p.id === projectId).map(p => {
      const source = store.get('stage-source', p.id);
      return { projectId: p.id, mode: store.get('control-binding', p.id) ? 'events' : 'observations', checkedAt: source?.checkedAt ?? null,
        error: source?.error ?? null, pending: Boolean(source && source.seq < source.latestSeq) };
    }) };
}
