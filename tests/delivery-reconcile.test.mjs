import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { verificationFixture } from './verification-fixture.mjs';
import { Reconciliation } from '../packages/orchestrator/reconcile.mjs';

async function delivered(t, mutate = () => {}) {
  const f = verificationFixture(t);
  f.verifier.configure(f.mission.id, { ...f.recipes[0], delivery: { mode: 'code-agent-commit', metadataPaths: ['delivery.md'] } }, f.options('one').expectedRevision);
  const attempt = await f.dispatch('edit-one'); await f.verify(attempt);
  const root = f.projects[0].path, directory = join(root, '.code-agent', 'approvals', attempt.codeAgentWorkId);
  mkdirSync(directory, { recursive: true });
  const receipt = { id: 'fixture-consent', action: 'deliver', status: 'this-commit', createdAt: new Date().toISOString(),
    preparedSession: { host: 'claude', id: 'fixture-session' }, observed: [{ choices: ['반영'] }] };
  const receiptText = mutate({ f, receipt, root });
  writeFileSync(join(directory, 'consents.jsonl'), receiptText ?? JSON.stringify(receipt) + '\n');
  writeFileSync(join(root, 'delivery.md'), '반영 기록\n');
  const git = args => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe', encoding: 'utf8' });
  git(['add', '.']); git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture delivery']);
  Object.assign(f.states.one, { stateVersion: 'delivered', work: null, request: null, resume: { code: 'no-work' } });
  return { ...f, attempt, root, git };
}
test('실제 반영 커밋·동의 기록·후검증을 결합하고 로컬 파일 인계와 구분', async t => {
  const f = await delivered(t);
  await f.verifier.handoff(f.mission.id, f.attempt.id, f.host, f.options('one'));
  const detail = f.engine.describe(f.mission.id);
  assert.equal(detail.deliveries[0].state, 'verified');
  assert.ok(detail.deliveries[0].checks.every(c => c.passed));
  assert.equal(detail.evidence[0].delivery.level, 'local-commit-with-consent-record');
  assert.equal(detail.evidence[0].delivery.commit, f.git(['rev-parse', 'HEAD']).trim());
  assert.equal(f.store.lock('one'), undefined);
  for (const taskId of ['edit-two', 'integrate']) {
    const a = await f.dispatch(taskId); await f.verify(a); await f.release(a);
  }
  const saved = f.store.list('delivery-run')[0];
  f.store.put('delivery-run', { ...saved, details: { ...saved.details, commit: 'tampered' } }, saved.revision);
  assert.throws(() => f.verifier.complete(f.mission.id, f.options('one').expectedRevision), { code: 'invalid-evidence' });
  f.store.put('delivery-run', saved, saved.revision + 1);
  assert.equal(f.verifier.complete(f.mission.id, f.options('one').expectedRevision).state, 'succeeded');
});
test('영수증 세션 불일치·검증 후 코드 변경·dirty tree는 인계 차단', async t => {
  for (const mode of ['session', 'code', 'dirty']) await t.test(mode, async t => {
    const f = await delivered(t, ({ receipt, root }) => {
      if (mode === 'session') receipt.preparedSession.id = 'someone-else';
      if (mode === 'code') writeFileSync(join(root, 'source.mjs'), 'export const value = 4;\n');
    });
    if (mode === 'dirty') writeFileSync(join(f.root, 'delivery.md'), '커밋 이후 문서 변경');
    await assert.rejects(f.verifier.handoff(f.mission.id, f.attempt.id, f.host, f.options('one')));
    assert.ok(f.store.lock('one')); assert.equal(f.store.list('evidence').length, 0);
  });
});
test('반영 검증 중 상태 조회 실패는 unknown이며 같은 검사 자동 반복 금지', async t => {
  const f = await delivered(t), inspect = f.host.inspect; let count = 0;
  f.host.inspect = async (...args) => { if (++count === 2) throw new Error('offline'); return inspect(...args); };
  await assert.rejects(f.verifier.handoff(f.mission.id, f.attempt.id, f.host, f.options('one')));
  const detail = f.engine.describe(f.mission.id);
  assert.equal(detail.attempts[0].state, 'unknown'); assert.equal(detail.deliveries[0].state, 'unknown');
  await assert.rejects(f.verifier.handoff(f.mission.id, f.attempt.id, f.host, f.options('one')), { code: 'invalid-state' });
  assert.ok(f.store.lock('one'));
});
test('반영 재검증 뒤 인계 저장 실패는 저장된 검증을 재사용해 재개', async t => {
  const f = await delivered(t), put = f.store.put.bind(f.store);
  f.store.put = (kind, ...args) => { if (kind === 'evidence') throw new Error('disk failure'); return put(kind, ...args); };
  await assert.rejects(f.verifier.handoff(f.mission.id, f.attempt.id, f.host, f.options('one')), /disk failure/);
  f.store.put = put;
  assert.equal(f.store.list('delivery-run').length, 1); assert.ok(f.store.lock('one'));
  await f.verifier.handoff(f.mission.id, f.attempt.id, f.host, f.options('one'));
  assert.equal(f.store.list('delivery-run').length, 1); assert.equal(f.store.lock('one'), undefined);
});
async function unobserved(t) {
  const f = verificationFixture(t), inspect = f.host.inspect; let calls = 0;
  f.host.inspect = async (...args) => { if (++calls === 2) throw new Error('observation offline'); return inspect(...args); };
  const attempt = await f.dispatch('edit-one');
  f.host.inspect = inspect;
  return { ...f, attempt, reconcile() { return new Reconciliation(f.store).reconcile(f.mission.id, attempt.id, f.host, f.options('one')); } };
}
test('호스트 반환 후 관측 실패는 재실행 없이 독립 검증 단계로 복구', async t => {
  const f = await unobserved(t);
  assert.equal(f.attempt.state, 'unknown'); assert.equal(f.store.list('host-return').length, 1);
  f.host.execute = () => assert.fail('호스트를 다시 실행하면 안 된다');
  const m = await f.reconcile(); assert.equal(m.attempts[0].state, 'awaiting-verification');
  assert.ok(f.store.lock('one'));
  await assert.rejects(f.live.continue(m.id, f.attempt.id, f.host, f.options('one')), { code: 'invalid-state' });
  await f.verify(f.attempt);
  assert.equal(f.store.need('mission', m.id).attempts[0].state, 'verified');
  assert.equal(f.engine.describe(m.id).reconciliations.length, 1);
});
test('오래된 호출 반환·변조·임대 충돌·실행 중 검증·일시 정지는 복구 차단', async t => {
  for (const mode of ['missing', 'tampered', 'lease', 'verification', 'pause']) await t.test(mode, async t => {
    const f = await unobserved(t);
    if (mode === 'missing') { const m = f.store.need('mission', f.mission.id); m.attempts[0].invocationId = 'newer-invocation'; f.store.put('mission', m, m.revision); }
    if (mode === 'tampered') { const r = f.store.need('host-return', f.attempt.invocationId); r.result.summary = 'changed'; f.store.put('host-return', r, r.revision); }
    if (mode === 'lease') f.states.one.ownership.lease = { state: 'held', host: 'claude', session: 'different' };
    if (mode === 'verification') f.store.put('verification-run', { id: 'unfinished', attemptId: f.attempt.id, state: 'running' });
    if (mode === 'pause') f.engine.control(f.mission.id, 'pause', f.options('one').expectedRevision);
    await assert.rejects(f.reconcile()); assert.ok(f.store.lock('one'));
    assert.equal(f.store.list('reconciliation').length, 0);
  });
});

for (const [kind, raw] of [['손상 JSON', '{broken-json'], ['객체가 아닌 JSON', 'null\n']]) {
  test(`L2: ${kind} 반영 동의 기록은 도메인 오류로 거부하고 잠금을 보존한다`, async t => {
    const f = await delivered(t, () => raw);
    await assert.rejects(f.verifier.handoff(f.mission.id, f.attempt.id, f.host, f.options('one')), { code: 'invalid-delivery-receipt' });
    assert.equal(f.store.list('evidence').length, 0);
    assert.ok(f.store.lock('one'));
  });
}
