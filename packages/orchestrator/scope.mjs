function inputProjects(mission, taskId) {
  const tasks = mission.plans.at(-1)?.proposal.tasks ?? [], visited = new Set(), projects = new Set();
  const visit = id => { if (visited.has(id)) return; visited.add(id); const t = tasks.find(t => t.id === id); if (!t) return; projects.add(t.projectId); t.dependsOn.forEach(visit); };
  visit(taskId);
  // 명시적으로 다른 프로젝트 근거를 참조하는 작업도 의존 입력으로 본다.
  return { projects, references: tasks.filter(t => visited.has(t.id)).flatMap(t => t.references) };
}
export function activeHolds(store, mission) {
  return mission.attempts.filter(a => a.planVersion === mission.plans.at(-1)?.version && !['succeeded', 'abandoned'].includes(a.state))
    .map(a => a.recoveryRunId ? store.get('recovery-run', a.recoveryRunId) : null).filter(r => r?.state === 'held');
}
export function taskHeld(store, mission, taskId) {
  const scope = inputProjects(mission, taskId);
  return activeHolds(store, mission).some(r => {
    const a = mission.attempts.find(a => a.id === r.attemptId);
    const referenced = (mission.plans.at(-1)?.sourceSnapshotIds ?? []).map(id => store.need('knowledge-snapshot', id))
      .some(s => s.projectId === a.projectId && s.sources.some(source => scope.references.includes(source.id)));
    return r.proposal?.category === 'critical' || r.proposal?.action === 'replan' || scope.projects.has(a.projectId) || referenced;
  });
}
export function relevantSource(store, mission, taskId, snapshot) {
  if (!taskId) return true;
  const scope = inputProjects(mission, taskId);
  return scope.projects.has(snapshot.projectId) || snapshot.sources.some(s => scope.references.includes(s.id));
}
