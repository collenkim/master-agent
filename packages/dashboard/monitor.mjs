import { Engine } from '../orchestrator/engine.mjs';
import { observeProject } from '../code-agent-adapter/observe.mjs';
import { requestStatus } from '../orchestrator/requests.mjs';
import { Catalog } from '../catalog/catalog.mjs';
import { stageDetails } from './history.mjs';
import { preparationIssues } from '../orchestrator/preparation.mjs';
import { DASHBOARD_CONTROLLER, connectionState, findTrustKey } from '../code-agent-adapter/pairing.mjs';
import { pairingReceipt } from '../runner/control-pairing.mjs';

const text = value => typeof value === 'string' ? value.slice(0, 2000) : '';
const list = value => Array.isArray(value) ? value : [];

/** A projection only: never expose raw records, controller credentials or model inputs. */
export function dashboardSnapshot(store, { live = false, refreshing = false, intervalMs = 5000, errors = new Map(), now = Date.now(), trustKey = findTrustKey } = {}) {
  const engine = new Engine(store);
  const keyAvailable = Boolean(trustKey(DASHBOARD_CONTROLLER)), pairings = store.list('control-pairing');
  const missions = store.list('mission').map(mission => {
    try {
      const detail = engine.describe(mission.id);
      return { id: mission.id, goal: text(mission.goal), mode: mission.mode, state: mission.state, ...detail.progress,
        reason: text(store.get('target-request', mission.id)?.error?.message ?? mission.reason),
        tasks: detail.progress.tasks.map(task => ({ ...task, goal: text(detail.taskDetails.find(t => t.id === task.taskId)?.goal) })),
        events: detail.events.slice(-12).reverse().map(e => ({ sequence: e.sequence, at: e.at, type: e.eventType ?? e.type, taskId: e.taskId ?? null })) };
    } catch (error) {
      return { id: mission.id, goal: text(mission.goal), mode: mission.mode, state: mission.state, status: 'blocked',
        error: text(error.message), tasks: [], events: [] };
    }
  });
  const projects = new Catalog(store).projects().map(project => {
    const observation = store.get('observation', project.id);
    const state = observation?.state ?? observation?.lastSuccessfulState;
    const observedAt = state?.observedAt ?? null;
    const age = now - Date.parse(observedAt);
    const stale = !Number.isFinite(age) || age > Math.max(30000, intervalMs * 3) || age < -5000;
    const failure = errors.get(project.id);
    const observationStatus = failure ? 'process-error' : observation?.status ?? 'unobserved';
    const binding = store.get('control-binding', project.id), source = store.get('interaction-source', project.id);
    // A hello read before the current binding was saved cannot judge it — wait for the next sweep.
    const probe = source?.control && !(binding && source.checkedAt < binding.boundAt) ? source.control : null;
    const connection = connectionState({ projectId: project.id, probe, binding, keyAvailable, now,
      installed: observation?.status !== 'not-installed' });
    const pairing = pairings.filter(p => p.projectId === project.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    const tasks = missions.flatMap(m => m.tasks.filter(t => t.projectId === project.id).map(t => ({ ...t, missionId: m.id, missionGoal: m.goal, mode: m.mode })));
    const pendingRequests = store.list('target-request').filter(r => r.projectIds.includes(project.id) && !['completed', 'cancelled'].includes(r.state))
      .map(r => ({ id: r.id, taskNumber: r.taskNumber ?? null, state: r.state, progress: missions.find(m => m.id === r.id)?.status,
        error: text(r.error?.message), issues: preparationIssues(r).filter(i => i.projectId === project.id) }));
    return { id: project.id, revision: project.revision, name: text(project.name), path: project.path, domains: project.domains,
      observation: { status: observationStatus, stale, observedAt, checkedAt: failure?.at ?? observation?.recordedAt ?? null,
        historical: observationStatus !== 'observed', error: text(failure?.message ?? observation?.error) },
      work: stageDetails(state).work,
      stages: stageDetails(state),
      resume: state?.resume ? { code: text(state.resume.code), reasons: list(state.resume.reasons).map(r => typeof r === 'string' ? text(r) : text(r.detail ?? r.code)) } : null,
      lease: text(state?.ownership?.lease?.state), process: text(state?.ownership?.process),
      unknown: list(state?.unknown).map(text),
      consents: list(state?.consents?.open).map(c => ({ id: text(c?.id), action: text(c?.action), status: text(c?.status) })),
      questions: [...list(state?.questions?.unanswered).map(q => ({ id: text(typeof q === 'string' ? q : q?.id), status: 'unanswered' })),
        ...list(state?.questions?.unverified).map(q => ({ id: text(q), status: 'unverified' }))],
      findings: state?.findings ? { open: state.findings.open, blocking: state.findings.blocking, humanDecision: state.findings.humanDecision } : null,
      control: binding ? { controller: text(binding.controller), owner: binding.owner, boundAt: binding.boundAt, expiresAt: binding.pairing?.humanChannel?.expiresAt ?? null } : null,
      connection: { state: connection.state, code: connection.code ?? null, canPair: connection.canPair, outcome: connection.outcome ?? null, renewal: connection.renewal ?? false,
        expired: connection.expired ?? false, owner: text(connection.owner), message: text(connection.message), guidance: text(connection.guidance), command: text(connection.command),
        checkedAt: probe ? source.checkedAt ?? null : null, error: text(source?.error), managedHost: probe?.managedHost ?? null },
      pairing: pairing ? pairingReceipt(pairing) : null,
      lock: store.lock(project.id) ? { missionId: store.lock(project.id).mission_id, attemptId: store.lock(project.id).attempt_id } : null,
      tasks, requests: pendingRequests,
      attention: Boolean(list(state?.consents?.open).length || list(state?.questions?.unanswered).length || list(state?.questions?.unverified).length ||
        state?.findings?.blocking || state?.findings?.humanDecision ||
        ['needs-human', 'ownership-conflict', 'replan-required', 'reapproval-required', 'limit-reached'].includes(state?.resume?.code) ||
        tasks.some(t => ['human-input', 'approval-pending', 'approval-processing', 'blocked'].includes(t.status)) ||
        pendingRequests.some(r => r.state === 'failed' || r.issues.length)) };
  });
  const groups = new Catalog(store).groups();
  const requests = store.list('target-request').map(requestStatus).map(r => ({ id: r.id, revision: r.revision, targetType: r.targetType, targetId: r.targetId,
    goal: text(r.goal), taskNumber: r.taskNumber ?? null, projectIds: r.projectIds, groupRevision: r.groupRevision, state: r.state, provider: r.provider, execution: r.execution ?? null,
    progress: missions.find(m => m.id === r.id)?.status ?? null, reason: text(r.error?.message ?? store.get('mission', r.id)?.reason),
    createdAt: r.createdAt, updatedAt: r.updatedAt, blockers: r.blockers, error: r.error, preparation: r.preparation ?? null }));
  return { generatedAt: new Date(now).toISOString(), live, refreshing, intervalMs, projects, missions, groups, requests,
    counts: { projects: projects.length, activeMissions: missions.filter(m => !['completed', 'cancelled'].includes(m.status)).length,
      attention: projects.filter(p => p.attention).length,
      unavailable: projects.filter(p => p.observation.status !== 'observed' || p.observation.stale).length } };
}

/** One bounded sweep, shared by every browser; failures are isolated per project. */
export function createMonitor(store, { cliPath, intervalMs = 5000, timeoutMs = 5000, observe = observeProject, onObserved, trustKey } = {}) {
  const errors = new Map();
  let pending = null, timer = null, stopped = false;
  function refresh() {
    if (pending) return pending;
    if (stopped || !cliPath) return Promise.resolve();
    const queue = new Catalog(store).projects();
    pending = (async () => {
      await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => {
        while (queue.length && !stopped) {
          const project = queue.shift();
          if (store.need('project', project.id).deletedAt) { errors.delete(project.id); continue; }
          try { await observe(store, project.id, { cliPath, timeoutMs }); errors.delete(project.id); }
          catch (error) { errors.set(project.id, { message: error.message, at: new Date().toISOString() }); }
          if (onObserved && !store.need('project', project.id).deletedAt) {
            try { await onObserved(project); }
            catch (error) { errors.set(project.id, { message: `질문 조회 실패: ${error.code ?? 'invalid-response'}`, at: new Date().toISOString() }); }
          }
        }
      }));
    })().finally(() => { pending = null; });
    return pending;
  }
  async function sweep() {
    try { await refresh(); }
    finally { if (!stopped) timer = setTimeout(sweep, intervalMs); }
  }
  return {
    refresh,
    start() { if (cliPath && !timer && !pending && !stopped) void sweep(); },
    snapshot() { return dashboardSnapshot(store, { live: Boolean(cliPath), refreshing: Boolean(pending), intervalMs, errors, ...(trustKey ? { trustKey } : {}) }); },
    async stop() { stopped = true; clearTimeout(timer); await pending; },
  };
}
