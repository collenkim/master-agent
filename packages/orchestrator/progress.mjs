import { hostname } from 'node:os';

const actions = {
  completed: 'none', cancelled: 'none', paused: 'resume', running: 'wait-for-host',
  'approval-processing': 'wait-for-delegation', 'approval-pending': 'resolve-delegation',
  'human-input': 'answer-human-request', blocked: 'review-blockers',
  'verification-pending': 'verify-live', verifying: 'wait-for-verification',
  'handoff-pending': 'handoff-live', ready: 'advance', waiting: 'wait-for-dependencies',
  analyzing: 'wait-for-analysis', planning: 'provide-plan',
  'setup-required': 'prepare-project',
};
function processing(activity) {
  if (activity?.state !== 'processing' || activity.host !== hostname()) return false;
  try { process.kill(activity.pid, 0); return true; } catch { return false; }
}

/** Presentation only: never replaces the persisted states used by safety gates. */
export function missionProgress(store, mission, tasks, events) {
  const escalations = store.list('escalation', { missionId: mission.id }).filter(e => e.state === 'open');
  const delegations = store.list('delegation', { missionId: mission.id });
  const runs = store.list('control-run', { missionId: mission.id });
  const details = tasks.map(task => {
    const attempt = mission.attempts.find(a => a.id === task.attemptIds.at(-1));
    const turn = attempt?.turns?.at(-1), remote = turn?.state;
    const openConsents = remote?.openConsents ?? remote?.consents?.open?.length ?? 0;
    const deliveryConsentsOnly = remote?.deliveryConsentsOnly ?? Boolean(openConsents && remote.consents.open.every(c => c.action === 'deliver'));
    const unansweredQuestions = remote?.unansweredQuestions ?? remote?.questions?.unanswered?.length ?? 0;
    const run = runs.find(r => r.invocationId === attempt?.invocationId);
    const activity = attempt && store.get('delegation-activity', attempt.id);
    const observed = store.get('workflow-observation', `${mission.id}:${task.id}`);
    const fault = observed?.code && observed.planVersion === mission.plans.at(-1)?.version && observed.taskState === task.state &&
      observed.invocationId === (attempt?.invocationId ?? null) && observed.recipeHash === (mission.verificationRecipes?.[task.id]?.hash ?? null) ? observed : null;
    const human = escalations.filter(e => e.attemptId === attempt?.id);
    const decisions = delegations.filter(d => d.attemptId === attempt?.id && Date.parse(d.recordedAt) >= Date.parse(turn?.at));
    let status = task.state, reason = task.state;
    if (task.state === 'succeeded') status = 'completed';
    else if (mission.state === 'paused') status = 'paused';
    else if (task.state === 'running') {
      const owns = mission.mode !== 'live' || store.lock(task.projectId)?.attempt_id === attempt?.id;
      status = owns ? 'running' : 'blocked'; reason = owns ? run?.state ?? 'submitting' : 'project-lock-missing';
    }
    else if (human.length) { status = 'human-input'; reason = human.map(e => e.reason).join('; '); }
    else if (fault) { status = 'blocked'; reason = fault.code; }
    else if (['unknown', 'verification-failed', 'failed'].includes(task.state) || task.waitingFor.some(r => ['recovery-held', 'project-knowledge-changed'].includes(r))) {
      status = 'blocked'; reason = turn?.error?.code ?? (task.waitingFor.join(',') || task.state);
    } else if (activity?.turnId === turn?.id && processing(activity)) { status = 'approval-processing'; reason = 'delegation-running'; }
    else if (decisions.some(d => d.state === 'rejected') || activity?.turnId === turn?.id && activity?.state === 'failed') {
      status = 'blocked'; reason = 'delegation-failed';
    } else if (attempt?.delegatedTurnId && attempt.delegatedTurnId === turn?.id) {
      status = task.state === 'verified' ? 'handoff-pending' : 'ready'; reason = 'delegation-applied';
    } else if (task.state === 'waiting-decision' || task.state === 'verified' && openConsents) {
      status = !run && !turn?.result?.control ? 'human-input' : task.state !== 'verified' && remote?.work?.phase === 'deliver' &&
        deliveryConsentsOnly && !unansweredQuestions ? 'verification-pending' : 'approval-pending';
      reason = status === 'human-input' ? 'host-decision-required' : status === 'approval-pending' ? 'delegation-not-yet-resolved' : 'verify-before-delivery-approval';
    } else if (task.state === 'verified') status = 'handoff-pending';
    else if (task.state === 'awaiting-verification') status = run && remote?.work?.phase !== 'deliver' ? 'ready' : 'verification-pending';
    else if (task.state === 'queued') {
      status = task.waitingFor.length ? 'waiting' : 'ready'; reason = task.waitingFor.join(',') || 'dispatch-ready';
      if (mission.mode === 'live' && status === 'ready' && !mission.verificationRecipes?.[task.id]) { status = 'blocked'; reason = 'verification-recipe-required'; }
    }
    const attemptRunIds = new Set(runs.filter(r => attempt && r.attemptId === attempt.id).map(r => r.id));
    // A delegated approval may change phase between two host runs of the same attempt.
    const control = events.filter(e => e.type === 'control-event' && e.projectId === task.projectId && run &&
      e.at >= (attempt.startedAt ?? run.acceptedAt) && (e.runId ? attemptRunIds.has(e.runId) :
        e.data?.workId === attempt.codeAgentWorkId || e.data?.workId == null && e.data?.previousWork === attempt.codeAgentWorkId));
    const phaseChange = control.filter(e => e.eventType === 'phase.changed').at(-1);
    const phase = ['succeeded', 'cancelled'].includes(task.state) ? null :
      phaseChange ? (phaseChange.data?.to ?? phaseChange.data?.phase ?? null) : remote?.work?.phase ?? null;
    const related = events.filter(e => (attempt && e.attemptId === attempt.id) || e.taskId === task.id || (run && e.runId === run.id));
    const lastProgressAt = [attempt?.startedAt, turn?.at, run?.updatedAt, activity?.at, fault?.at, ...related.map(e => e.at), ...control.map(e => e.at)].filter(Boolean).sort().at(-1) ?? mission.createdAt;
    return { taskId: task.id, projectId: task.projectId, attemptId: attempt?.id ?? null, state: task.state, status, reason,
      phase, executionHost: run?.hostKind ?? attempt?.executionHost ?? null, runId: run?.id ?? null, lastProgressAt,
      nextAction: actions[status] ?? 'review-blockers', escalations: human.map(e => e.id) };
  });
  const request = store.get('target-request', mission.id);
  const status = ['succeeded', 'simulation-complete'].includes(mission.state) ? 'completed' : mission.state === 'cancelled' ? 'cancelled' :
    mission.state === 'paused' ? 'paused' : request?.state === 'failed' ? 'blocked' : request?.state === 'waiting' && request.preparation?.state === 'waiting' ? 'setup-required' : mission.planningHold ? mission.state === 'waiting-decision' ? 'human-input' : 'blocked' :
      mission.state === 'analyzing' ? 'analyzing' : !tasks.length ? 'planning' :
        ['human-input', 'blocked', 'approval-processing', 'running', 'approval-pending', 'verifying', 'verification-pending', 'handoff-pending', 'ready', 'waiting'].find(s => details.some(t => t.status === s)) ?? 'ready';
  return { status, nextAction: status === 'ready' && tasks.length && tasks.every(t => t.state === 'succeeded') ? 'verify-completion' : actions[status],
    lastProgressAt: [mission.createdAt, ...details.map(t => t.lastProgressAt)].sort().at(-1),
    counts: Object.fromEntries([...new Set(details.map(t => t.status))].map(s => [s, details.filter(t => t.status === s).length])), tasks: details };
}
