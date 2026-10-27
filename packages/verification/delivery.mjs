import { childEnv } from '../runner/process.mjs';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { snapshotTree, changesBetween, checkpointsCurrent, safeRelative, codeAgentRecord } from './tree.mjs';
import { runProcess } from '../reasoning/cli-provider.mjs';
import { sealOf } from './seal.mjs';
import { DomainError, requireThat, hash, now, strings } from '../domain/contracts.mjs';

const git = (path, args) => execFileSync('git', ['-C', path, ...args], { encoding: 'utf8', shell: false, windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024,
  stdio: ['ignore', 'pipe', 'pipe'], env: childEnv({ GIT_OPTIONAL_LOCKS: '0' }) });
export function validateDelivery(contract) {
  requireThat(contract?.mode === 'code-agent-commit', 'invalid-delivery', '지원 반영 계약은 code-agent-commit입니다.');
  strings(contract.metadataPaths, 'delivery.metadataPaths');
  for (const path of contract.metadataPaths) {
    safeRelative(path);
    requireThat(/\.(md|jsonl)$/i.test(path), 'invalid-delivery', '반영 후 변경 허용 목록은 정확한 md·jsonl 기록 경로로 제한합니다.');
  }
}
/**
 * 반영 동의 영수증은 둘 중 하나다 — 사람이 그 세션에서 고른 응답(observed), 또는 master 가 먼저 기록하고 code-agent 가 적용한 위임 판단(delegation).
 * 위임 영수증은 이 시도의 deliver 위임 기록(승인·적용 완료)과 판단 ID 가 같아야 하고, 사람 응답이 섞이지 않아야 한다.
 */
function delegatedReceipt(r, attempt, store) {
  if (!store || r.channel !== 'master-delegation' || typeof r.delegation?.decisionId !== 'string' || r.observed?.length) return false;
  const d = store.get('delegation', r.delegation.decisionId);
  return Boolean(d && d.attemptId === attempt.id && d.kind === 'consent' && d.action === 'deliver' && d.target === r.id && d.verdict === 'approve' && d.state === 'applied' &&
    d.workId === attempt.codeAgentWorkId);
}
export function inspectDelivery(project, attempt, run, tree, store) {
  validateDelivery(attempt.recipe.delivery);
  const receiptPath = `.code-agent/approvals/${attempt.codeAgentWorkId}/consents.jsonl`;
  const changed = changesBetween(run.after, tree);
  requireThat(changed.every(p => p === receiptPath || attempt.recipe.delivery.metadataPaths.includes(p) || (attempt.recipe.codeAgentRecords === true && codeAgentRecord(p, attempt.codeAgentWorkId))),
    'delivery-code-drift', '검증 이후 허용된 반영 기록 밖의 파일이 바뀌었습니다.');
  requireThat(!run.artifacts.some(a => a.path && changed.includes(a.path)), 'delivery-artifact-drift', '검증 산출물은 반영 기록으로 변경할 수 없습니다.');
  const parents = git(project.path, ['rev-list', '--parents', '-n', '1', tree.head]).trim().split(/\s+/);
  requireThat(parents.length === 2 && parents[1] === run.after.head && tree.head !== run.after.head, 'delivery-history', '검증 시점 HEAD 바로 다음의 단일 반영 커밋이 필요합니다.');
  requireThat(!git(project.path, ['status', '--porcelain=v1', '--untracked-files=all']).trim(), 'delivery-dirty', '반영 커밋과 작업 파일·인덱스가 같아야 합니다.');
  const raw = git(project.path, ['show', `${tree.head}:${receiptPath}`]);
  let rows;
  try { rows = raw.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)); }
  catch { throw new DomainError('invalid-delivery-receipt', '반영 동의 기록의 JSON 형식이 손상됐습니다.'); }
  requireThat(rows.every(row => row && typeof row === 'object' && !Array.isArray(row)),
    'invalid-delivery-receipt', '반영 동의 기록은 JSON 객체여야 합니다.');
  const session = attempt.turns.at(-1)?.result?.sessionId;
  const receipts = rows.filter(r => r.action === 'deliver' && r.status === 'this-commit' && typeof r.id === 'string' &&
    r.preparedSession?.host === 'claude' && r.preparedSession.id === session && Date.parse(r.createdAt) >= Date.parse(attempt.startedAt) &&
    (Array.isArray(r.observed) && r.observed.some(o => Array.isArray(o.choices) && o.choices.length) || delegatedReceipt(r, attempt, store)));
  requireThat(receipts.length === 1, 'missing-delivery-receipt', '현재 작업 경로·세션에 결합된 반영 동의 영수증이 필요합니다.');
  return { mode: 'code-agent-commit', commit: tree.head, parent: parents[1], receiptPath, receiptHash: hash(raw), receipt: receipts[0], changedPaths: changed };
}

/** 이미 수행된 로컬 커밋을 읽기 검증한다. 동의 생성·커밋·push는 수행하지 않는다. */
export async function verifyDelivery(verifier, id, attempt, project, run, tree, host, expectedRevision, expectedState) {
  const details = inspectDelivery(project, attempt, run, tree, verifier.store), store = verifier.store, engine = verifier.engine;
  const runId = randomUUID();
  const reserved = store.transaction(() => {
    const current = verifier.locate(id, attempt.id, expectedRevision);
    requireThat(!current.attempt.deliveryRunId, 'delivery-pending', '이미 반영 검사가 시작됐습니다. 중복 실행하지 않습니다.');
    const d = engine.decision(current.m, 'verify-delivery', { reason: '반영 커밋·영수증·기존 산출물을 대조한 뒤 기존 검증 명령을 다시 실행합니다.',
      evidence: [run.id, `commit:${tree.head}`, `receipt:${details.receiptHash}`], alternatives: ['반영 인계 보류', '반영 후 재검증'], nextAction: 'verify-delivery', verification: '기존 계약의 모든 명령 재실행' });
    store.put('delivery-run', { id: runId, missionId: id, attemptId: attempt.id, verificationRunId: run.id, state: 'running', details, before: tree, decisionId: d.id, startedAt: now() });
    current.attempt.deliveryRunId = runId;
    return engine.save(current.m, 'delivery-started', { runId, attemptId: attempt.id, decisionId: d.id });
  });
  const checks = [];
  try {
    for (const check of attempt.recipe.checks) {
      const current = engine.checked(id, reserved.revision);
      requireThat(current.state !== 'paused', 'delivery-paused', '반영 검사가 일시 정지됐습니다.');
      const output = await runProcess(check.executable, check.args, { cwd: project.path, input: '', timeoutMs: check.timeoutMs, maxBytes: 1024 * 1024, captureExit: true });
      checks.push({ id: check.id, criterionIds: check.criterionIds, passed: output.exitCode === 0, exitCode: output.exitCode, outputHash: hash(output.stdout), diagnosticHash: hash(output.stderr) });
      requireThat(output.exitCode === 0, 'delivery-test-failed', '반영 후 독립 검증을 통과하지 못했습니다.');
    }
    const after = snapshotTree(project.path);
    requireThat(after.digest === tree.digest && after.head === tree.head && checkpointsCurrent(store.need('mission', id), project.id), 'delivery-mutated-tree', '반영 검사 중 파일·HEAD·선행 산출물이 바뀌었습니다.');
    inspectDelivery(project, attempt, run, after, store);
    const remote = await host.inspect(project, expectedState);
    requireThat(remote.stateVersion === expectedState && remote.work === null && remote.request === null && remote.resume?.code === 'no-work' &&
      remote.consents?.readable && !remote.consents.open.length && ['none', 'released', 'other-work'].includes(remote.ownership?.lease?.state), 'handoff-pending', '반영 검사 중 외부 작업·임대가 바뀌었습니다.');
    verifier.inputsCurrent(store.need('mission', id), project.id, attempt.taskId);
    engine.checked(id, reserved.revision);
    const record = store.need('delivery-run', runId);
    Object.assign(record, { state: 'verified', checks, after, remote, finishedAt: now() }); record.seal = sealOf(record);
    store.put('delivery-run', record, record.revision);
    return { record: store.need('delivery-run', runId), revision: reserved.revision };
  } catch (error) {
    store.transaction(() => {
      const record = store.need('delivery-run', runId); Object.assign(record, { state: 'unknown', checks, error: error.code ?? 'delivery-error', finishedAt: now() }); record.seal = sealOf(record); store.put('delivery-run', record, record.revision);
      const m = store.need('mission', id), a = m.attempts.find(a => a.id === attempt.id);
      a.state = 'unknown'; m.tasks.find(t => t.id === a.taskId).state = 'unknown'; if (m.state !== 'paused') m.state = 'blocked';
      engine.save(m, 'delivery-blocked', { runId, error: record.error });
    });
    throw error;
  }
}
