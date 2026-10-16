import { Planner } from '../reasoning/planner.mjs';
import { Annotation, StateGraph, START, END, interrupt } from '@langchain/langgraph';
import { Engine } from './engine.mjs';
import { LiveExecution, revisingTurn } from './live.mjs';
import { LiveVerification } from '../verification/live-verification.mjs';
import { requireThat, now } from '../domain/contracts.mjs';
import { Recovery } from './recovery.mjs';
import { Replanning } from './replan.mjs';
import { activeHolds, taskHeld } from './scope.mjs';
import { VerificationTemplates } from '../verification/templates.mjs';
import { DecisionDelegation } from './decisions.mjs';
import { checkpointer, invokeGraph } from './graph-runtime.mjs';

const State = Annotation.Root({
  missionId: Annotation(), cursor: Annotation(), order: Annotation(), pending: Annotation(), blockers: Annotation(), route: Annotation(),
  taskId: Annotation(), attemptId: Annotation(), revision: Annotation(), remote: Annotation(), result: Annotation(),
});
const expectedBlocks = ['remote-not-ready', 'remote-needs-human', 'remote-busy', 'remote-unapproved', 'missing-remote-evidence', 'handoff-pending', 'out-of-scope-change', 'stale-context', 'stale-contract', 'handoff-context-limit', 'continuation-limit'];
const faults = new Set(['external-work', 'missing-verification-recipe', 'remote-busy', 'remote-unapproved', 'missing-remote-evidence',
  'out-of-scope-change', 'stale-context', 'stale-contract', 'handoff-context-limit', 'continuation-limit', 'ownership-conflict', 'unobservable']);

/** LangGraph owns scheduling and all automatic branches. Domain services own effects. */
export class LiveWorkflow {
  constructor(store) { this.store = store; this.engine = new Engine(store); this.live = new LiveExecution(store); this.verifier = new LiveVerification(store); }
  graph(host, provider, all) {
    const store = this.store, engine = this.engine;
    const observation = (s, code) => {
      if (!s.taskId) return;
      const id = `${s.missionId}:${s.taskId}`, previous = store.get('workflow-observation', id);
      if (!code && !previous?.code) return;
      const m = store.need('mission', s.missionId), task = m.tasks.find(t => t.id === s.taskId);
      const attempt = m.attempts.find(a => a.id === task?.attemptIds.at(-1));
      const value = { id, missionId: m.id, taskId: s.taskId, planVersion: m.plans.at(-1)?.version,
        invocationId: attempt?.invocationId ?? null, taskState: task?.state, recipeHash: m.verificationRecipes?.[s.taskId]?.hash ?? null, code };
      if (previous && Object.entries(value).every(([key, val]) => previous[key] === val)) return;
      store.transaction(() => store.put('workflow-observation', { ...value, at: now() }, previous?.revision ?? 0));
    };
    const blocked = (s, code) => {
      observation(s, faults.has(code) ? code : null);
      return { blockers: [...s.blockers, `${s.taskId}:${code}`], cursor: s.cursor + 1, route: 'select' };
    };
    const finished = (s, mission, extra = {}) => {
      observation(s, null);
      return { result: { progressed: true, mission, blockers: s.blockers, ...extra }, route: 'after' };
    };
    const effect = fn => async s => {
      try { return await fn(s); }
      catch (error) { if (!expectedBlocks.includes(error.code)) throw error; return blocked(s, error.code); }
    };
    const nonblocking = host?.transport === 'code-agent-master' && typeof host.poll === 'function';
    const options = s => ({ expectedRevision: s.revision, expectedState: s.remote.stateVersion, wait: !nonblocking });
    const builder = new StateGraph(State)
      .addNode('refresh', s => {
        const m = store.need('mission', s.missionId);
        // Submit independent queued work before waiting on hosts or model judgments.
        const order = (m.plans.at(-1)?.proposal.tasks ?? []).map(t => t.id).sort((a, b) =>
          all && nonblocking ? Number(m.tasks.find(t => t.id === b).state === 'queued') - Number(m.tasks.find(t => t.id === a).state === 'queued') : 0);
        return { order, pending: false, cursor: 0, blockers: [], taskId: null, attemptId: null, remote: null, result: null, route: 'select' };
      })
      .addNode('select', s => {
        const m = store.need('mission', s.missionId);
        requireThat(m.mode === 'live', 'wrong-mode', 'Only live missions can use the live graph.');
        const halt = blockers => ({ result: { progressed: false, mission: engine.describe(m.id), blockers }, route: ['succeeded', 'cancelled'].includes(m.state) ? END : 'wait' });
        if (m.state === 'received' && provider) return { revision: m.revision, route: 'analyze' };
        if (['paused', 'analyzing', 'succeeded', 'cancelled'].includes(m.state) || m.planningHold) return halt([m.state]);
        const hold = activeHolds(store, m).find(r => r.proposal?.action === 'replan' || r.proposal?.category === 'critical');
        if (hold) return provider && hold.proposal?.action === 'replan'
          ? { attemptId: hold.attemptId, revision: m.revision, route: 'replan' } : halt([`recovery-held:${hold.id}`]);
        if (m.tasks.length && m.tasks.every(t => t.state === 'succeeded')) return { revision: m.revision, route: 'complete' };
        const task = m.plans.at(-1)?.proposal.tasks.find(t => t.id === s.order[s.cursor]);
        if (!task) return all && nonblocking && s.pending
          ? { route: 'poll-wait' } : halt(s.blockers);
        const status = m.tasks.find(t => t.id === task.id), attempt = m.attempts.find(a => a.id === status.attemptIds.at(-1));
        const next = { taskId: task.id, attemptId: attempt?.id ?? null, revision: m.revision };
        const skip = code => ({ ...next, cursor: s.cursor + 1, blockers: code ? [...s.blockers, `${task.id}:${code}`] : s.blockers, route: 'select' });
        if (status.state === 'succeeded') return skip();
        if (taskHeld(store, m, task.id)) return skip('recovery-held');
        if (attempt?.recoveryBusy) return skip('recovery-analyzing');
        if (status.state === 'verification-failed' && provider && !new Recovery(store).history(m.id, attempt.id).some(r => r.sourceVerificationRunId === attempt.verificationRunId)) return { ...next, route: 'recover' };
        if (host?.transport === 'code-agent-master' && status.state === 'running' && attempt?.mode === 'live' && attempt.invocationId && store.lock(task.projectId)?.attempt_id === attempt.id) return { ...next, route: 'reattach' };
        if (['running', 'unknown', 'verifying', 'verification-failed'].includes(status.state)) return skip(status.state);
        if (host?.transport === 'code-agent-master' && provider && attempt && ['waiting-decision', 'verified'].includes(attempt.state)) return { ...next, route: 'delegate' };
        return { ...next, route: 'ready' };
      })
      .addNode('analyze', async s => {
        const result = await new Planner(store).analyze(s.missionId, provider, { expectedRevision: s.revision });
        return finished(s, result.mission);
      })
      .addNode('delegate', async s => {
        const result = await new DecisionDelegation(store).resolve(s.missionId, s.attemptId, host, provider);
        return result.progressed ? finished(s, engine.describe(s.missionId), { blockers: [...s.blockers, ...result.blockers] }) : { blockers: [...s.blockers, ...result.blockers], route: 'ready' };
      })
      .addNode('ready', s => {
        const m = store.need('mission', s.missionId), task = m.plans.at(-1).proposal.tasks.find(t => t.id === s.taskId), status = m.tasks.find(t => t.id === s.taskId);
        if (status.state === 'queued' && (store.lock(task.projectId) || !task.dependsOn.every(id => m.tasks.find(t => t.id === id).state === 'succeeded'))) return { cursor: s.cursor + 1, route: 'select' };
        if (status.state === 'queued' && !m.verificationRecipes?.[task.id]) {
          if (new VerificationTemplates(store).candidates(m, task).length === 1) return { route: 'template' };
          return blocked(s, 'missing-verification-recipe');
        }
        return { route: 'observe' };
      })
      .addNode('observe', effect(async s => {
        const m = engine.checked(s.missionId, s.revision), task = m.plans.at(-1).proposal.tasks.find(t => t.id === s.taskId), attempt = m.attempts.find(a => a.id === s.attemptId);
        const remote = await host.inspect(store.need('project', task.projectId), undefined, attempt?.turns.at(-1)?.result?.sessionId);
        const control = host?.transport === 'code-agent-master';
        const status = m.tasks.find(t => t.id === s.taskId);
        if (status.state === 'queued') return remote.work || remote.resume.code !== 'no-work' ? blocked(s, 'external-work') : { remote, route: 'dispatch' };
        if (status.state === 'verified') return { remote, route: control && remote.work?.id === attempt.codeAgentWorkId && (remote.work.phase !== 'deliver' && remote.resume?.code === 'ready' || revisingTurn(store, attempt, remote)) ? 'continue' : 'handoff' };
        if (attempt?.recipe && (!control || remote.work?.phase === 'deliver') && remote.work?.id === attempt.codeAgentWorkId && remote.verification?.bound?.valid && remote.verification.phases?.check?.passed && remote.verification.phases?.test?.passed) return { remote, route: 'verify' };
        if (attempt && ['blocked', 'waiting-decision', 'awaiting-verification'].includes(attempt.state) && (remote.resume?.code === 'ready' || control && revisingTurn(store, attempt, remote)) && !attempt.reconciliationPending) return { remote, route: 'continue' };
        return blocked(s, remote.resume.code);
      }))
      .addNode('template', s => finished(s, new VerificationTemplates(store).apply(s.missionId, s.taskId, s.revision)))
      .addNode('dispatch', effect(async s => finished(s, await this.live.dispatch(s.missionId, s.taskId, host, options(s)))))
      .addNode('continue', effect(async s => finished(s, await this.live.continue(s.missionId, s.attemptId, host, { ...options(s), automatic: true }))))
      .addNode('verify', effect(async s => finished(s, await this.verifier.verify(s.missionId, s.attemptId, host, options(s)))))
      .addNode('handoff', effect(async s => finished(s, await this.verifier.handoff(s.missionId, s.attemptId, host, options(s)))))
      .addNode('reattach', async s => {
        const mission = await this.live.reattach(s.missionId, s.attemptId, host, { wait: !nonblocking });
        return mission.attempts.find(a => a.id === s.attemptId)?.state === 'running'
          ? { pending: true, cursor: s.cursor + 1, route: 'select' } : finished(s, mission);
      })
      .addNode('poll-wait', async () => { await host.sleep(Math.min(60000, Math.max(10, host.pollMs))); return { route: 'refresh' }; })
      .addNode('recover', async s => {
        const m = engine.checked(s.missionId, s.revision), a = m.attempts.find(a => a.id === s.attemptId);
        const remote = await host.inspect(store.need('project', a.projectId), undefined, a.turns.at(-1)?.result?.sessionId);
        const result = await new Recovery(store).recover(m.id, a.id, host, provider, { expectedRevision: m.revision, expectedState: remote.stateVersion });
        return finished(s, result.mission, { ...result, progressed: true, blockers: result.progressed ? s.blockers : [...s.blockers, `${s.taskId}:${result.recovery.verdict.code}`] });
      })
      .addNode('replan', async s => {
        const m = engine.checked(s.missionId, s.revision), a = m.attempts.find(a => a.id === s.attemptId);
        const remote = await host.inspect(store.need('project', a.projectId));
        try {
          const result = await new Replanning(store).transition(m.id, a.id, host, provider, { expectedRevision: m.revision, expectedState: remote.stateVersion });
          return finished(s, result.mission);
        } catch (error) {
          if (!['handoff-pending', 'project-busy', 'unsettled-attempt', 'stale-replan'].includes(error.code)) throw error;
          return { result: { progressed: false, mission: engine.describe(m.id), blockers: [error.code] }, route: 'wait' };
        }
      })
      .addNode('complete', s => finished(s, this.verifier.complete(s.missionId, s.revision)))
      .addNode('after', s => ({ route: all && s.result.progressed && s.result.mission.state !== 'succeeded' ? 'refresh' : END }))
      .addNode('wait', s => { interrupt({ kind: 'mission-wait', missionId: s.missionId, progress: s.result.mission.progress, blockers: s.result.blockers }); return {}; });
    builder.addEdge(START, 'refresh');
    const edges = {
      refresh: ['select'],
      select: ['analyze', 'wait', 'poll-wait', END, 'replan', 'complete', 'select', 'recover', 'reattach', 'delegate', 'ready'],
      analyze: ['after'], delegate: ['after', 'ready'], ready: ['select', 'template', 'observe'],
      observe: ['select', 'dispatch', 'continue', 'handoff', 'verify'], template: ['after'],
      dispatch: ['select', 'after'], continue: ['select', 'after'], verify: ['select', 'after'], handoff: ['select', 'after'],
      reattach: ['after', 'select'], 'poll-wait': ['refresh'], recover: ['after'], replan: ['after', 'wait'], complete: ['after'], after: ['refresh', END],
    };
    for (const [node, targets] of Object.entries(edges)) builder.addConditionalEdges(node, s => s.route, targets);
    builder.addEdge('wait', 'refresh');
    return builder.compile({ checkpointer: checkpointer(store) });
  }
  async execute(id, host, provider, all) {
    const result = await invokeGraph(this.store, this.graph(host, provider, all), 'mission', id, { missionId: id }, { resumeWait: true });
    return result.result;
  }
  advance(id, host, provider) { return this.execute(id, host, provider, false); }
  run(id, host, provider) { return this.execute(id, host, provider, true); }
}
