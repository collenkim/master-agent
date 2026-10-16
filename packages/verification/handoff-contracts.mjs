import { hash, requireThat, string, strings } from '../domain/contracts.mjs';
import { safeRelative } from './tree.mjs';
import { assertSealed } from './seal.mjs';

/** Operator-declared API contracts, tied to independent checks rather than model summaries. */
export function validateExports(recipe) {
  if (recipe.exports === undefined) return;
  const contracts = recipe.exports;
  requireThat(Array.isArray(contracts) && contracts.length <= 16 && JSON.stringify(contracts).length <= 6000,
    'invalid-contract', 'exports는 최대 16개, 총 6000자 이내의 구조화 계약입니다.');
  strings(contracts.map(c => c?.id), 'exports.id');
  for (const c of contracts) {
    string(c.symbol, 'exports.symbol'); safeRelative(c.path);
    requireThat(Array.isArray(c.inputs) && Array.isArray(c.errors), 'invalid-contract', 'inputs와 errors 배열이 필요합니다.');
    for (const input of c.inputs) for (const field of ['name', 'type', 'range']) string(input?.[field], `inputs.${field}`);
    for (const field of ['type', 'description']) string(c.returns?.[field], `returns.${field}`);
    for (const error of c.errors) for (const field of ['type', 'when']) string(error?.[field], `errors.${field}`);
    strings(c.checkIds, 'exports.checkIds', true);
    requireThat(c.checkIds.every(id => recipe.checks.some(check => check.id === id)), 'invalid-contract', '계약을 확인하는 검증 명령이 없습니다.');
  }
}

export function bindExports(recipe, tree, checks) {
  return (recipe.exports ?? []).map(contract => {
    const file = tree.files.find(f => f.path === contract.path);
    requireThat(file && contract.checkIds.every(id => checks.some(c => c.id === id && c.passed)),
      'invalid-contract', '계약의 소스 파일과 성공한 독립 검증이 필요합니다.');
    return { ...structuredClone(contract), sourceDigest: file.digest, contractHash: hash(contract) };
  });
}

/** Carry transitive dependencies too, without reading unrelated repositories or their raw sources. */
export function predecessorContracts(store, mission, task) {
  const visited = new Set(), result = [];
  const visit = id => {
    if (visited.has(id)) return;
    visited.add(id);
    const predecessor = mission.plans.at(-1).proposal.tasks.find(t => t.id === id);
    predecessor.dependsOn.forEach(visit);
    const state = mission.tasks.find(t => t.id === id);
    requireThat(state.state === 'succeeded', 'dependency-pending', '선행 계약은 인계가 완료된 작업에서만 받습니다.');
    for (const evidenceId of state.evidenceIds) {
      const evidence = store.need('evidence', evidenceId);
      if (!evidence.contracts?.length) continue;
      assertSealed(evidence);
      requireThat(evidence.missionId === mission.id && evidence.planVersion === mission.plans.at(-1).version && evidence.taskId === id,
        'invalid-evidence', '선행 계약의 목표·계획·작업이 다릅니다.');
      requireThat(evidence.contracts.every(c => mission.liveCheckpoints?.[evidence.projectId]?.files.some(f => f.path === c.path && f.digest === c.sourceDigest)),
        'stale-contract', '선행 계약의 소스가 이후 인계에서 변경됐습니다. 계약을 다시 검토하세요.');
      result.push({ taskId: id, projectId: evidence.projectId, evidenceId, verificationRunId: evidence.verificationRunId,
        treeDigest: evidence.tree.digest, commit: evidence.delivery?.commit ?? null, contracts: evidence.contracts });
    }
  };
  task.dependsOn.forEach(visit);
  return result;
}
