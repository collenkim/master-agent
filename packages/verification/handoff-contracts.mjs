import { hash, requireThat, string, strings } from '../domain/contracts.mjs';
import { safeRelative } from './tree.mjs';
import { assertSealed } from './seal.mjs';
import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

/** Exact document lines; no model inference is promoted to an authenticated claim. */
export function contractLines(contract) {
  return ['symbol', 'inputs', 'returns', 'errors'].map(key => `${key}: ${JSON.stringify(contract[key])}`);
}

export function dependencyBundle(inputs = []) {
  const contracts = inputs.flatMap(input => input.contracts.filter(c => c.document).map(c => {
    requireThat(/^[a-f0-9]{40}$/.test(input.commit ?? ''), 'invalid-contract', '문서 계약 인계에는 확인된 반영 커밋이 필요합니다.');
    const id = `export-${hash({ projectId: input.projectId, id: c.id }).slice(0, 20)}`;
    return { id, repository: input.repository, path: c.document.path, commit: input.commit, sha256: c.document.sha256,
      claims: contractLines(c).map((text, index) => ({ key: `${id}.${['symbol', 'inputs', 'returns', 'errors'][index]}`, text })) };
  }));
  requireThat(contracts.length <= 20, 'invalid-contract', 'code-agent에 등록할 문서 계약은 최대 20개입니다.');
  return contracts.length ? { version: 1, contracts } : null;
}

export function verifyContractDocuments(contracts, tree, commit) {
  for (const contract of contracts.filter(c => c.document)) {
    requireThat(/^[a-f0-9]{40}$/.test(commit ?? ''), 'invalid-contract', '계약 문서의 반영 커밋이 필요합니다.');
    const file = tree.files.find(f => f.path === contract.document.path);
    const entry = execFileSync('git', ['-C', tree.root, 'ls-tree', commit, '--', contract.document.path], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
    requireThat(/^100(?:644|755) blob /.test(entry) && entry.trim().split('\n').length === 1, 'invalid-contract', '커밋된 일반 계약 문서가 필요합니다.');
    const blob = execFileSync('git', ['-C', tree.root, 'show', `${commit}:${contract.document.path}`], { windowsHide: true, maxBuffer: 131072, timeout: 30000 });
    requireThat(file?.digest === contract.document.sha256 && createHash('sha256').update(blob).digest('hex') === contract.document.sha256,
      'invalid-contract', '계약 문서의 검증된 파일과 반영 커밋 내용이 다릅니다.');
  }
}

/** Operator-declared API contracts, tied to independent checks rather than model summaries. */
export function validateExports(recipe) {
  if (recipe.exports === undefined) return;
  const contracts = recipe.exports;
  requireThat(Array.isArray(contracts) && contracts.length <= 16 && JSON.stringify(contracts).length <= 6000,
    'invalid-contract', 'exports는 최대 16개, 총 6000자 이내의 구조화 계약입니다.');
  strings(contracts.map(c => c?.id), 'exports.id');
  for (const c of contracts) {
    string(c.symbol, 'exports.symbol'); safeRelative(c.path);
    if (c.documentPath !== undefined) {
      safeRelative(c.documentPath);
      requireThat(recipe.delivery?.mode === 'code-agent-commit', 'invalid-contract', 'documentPath 인계에는 code-agent-commit 반영 계약이 필요합니다.');
      requireThat(contractLines(c).every(line => !/[\r\n\u2028\u2029]/.test(line)), 'invalid-contract', '계약 항목은 단일 줄이어야 합니다.');
    }
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
    let document;
    if (contract.documentPath) {
      const source = tree.files.find(f => f.path === contract.documentPath);
      requireThat(source && source.size <= 131072, 'invalid-contract', '크기 한도 내의 실제 계약 문서가 필요합니다.');
      const text = readFileSync(join(tree.root, contract.documentPath), 'utf8');
      requireThat(createHash('sha256').update(text).digest('hex') === source.digest && !text.includes('\0') &&
        contractLines(contract).every(line => text.split(/\r?\n/).some(actual => actual.trim() === line)),
      'invalid-contract', '계약 문서의 UTF8 원문과 구조화 선언이 일치해야 합니다.');
      document = { path: contract.documentPath, sha256: source.digest };
    }
    return { ...structuredClone(contract), sourceDigest: file.digest, contractHash: hash(contract), ...(document ? { document } : {}) };
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
      requireThat(evidence.contracts.every(c => mission.liveCheckpoints?.[evidence.projectId]?.files.some(f => f.path === c.path && f.digest === c.sourceDigest) &&
        (!c.document || mission.liveCheckpoints?.[evidence.projectId]?.files.some(f => f.path === c.document.path && f.digest === c.document.sha256))),
        'stale-contract', '선행 계약의 소스가 이후 인계에서 변경됐습니다. 계약을 다시 검토하세요.');
      result.push({ taskId: id, projectId: evidence.projectId, evidenceId, verificationRunId: evidence.verificationRunId,
        repository: realpathSync.native(store.need('project', evidence.projectId).path), treeDigest: evidence.tree.digest, commit: evidence.delivery?.commit ?? null, contracts: evidence.contracts });
    }
  };
  task.dependsOn.forEach(visit);
  return result;
}
