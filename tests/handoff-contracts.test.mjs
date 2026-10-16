import test from 'node:test';
import assert from 'node:assert/strict';
import { controlFixture } from './control-fixture.mjs';
import { LiveWorkflow } from '../packages/orchestrator/drive.mjs';
import { LiveExecution } from '../packages/orchestrator/live.mjs';
import { predecessorContracts, validateExports, bindExports } from '../packages/verification/handoff-contracts.mjs';
import { hash } from '../packages/domain/contracts.mjs';

const contract = {
  id: 'value-api', path: 'source.mjs', symbol: 'value', inputs: [],
  returns: { type: 'number', description: '상수 2' }, errors: [], checkIds: ['check-one'],
};

test('verified contracts and their source provenance reach downstream dispatch, continuation and judgment', async t => {
  const f = controlFixture(t);
  const recipe = { ...f.recipes[0], exports: [contract] };
  f.verifier.configure(f.mission.id, recipe, f.store.need('mission', f.mission.id).revision);
  assert.equal((await new LiveWorkflow(f.store).run(f.mission.id, f.host, f.provider)).mission.state, 'succeeded');
  const m = f.store.need('mission', f.mission.id), evidence = f.store.list('evidence').find(e => e.taskId === 'edit-one');
  assert.equal(evidence.contracts[0].sourceDigest, evidence.tree.files.find(f => f.path === 'source.mjs').digest);
  assert.equal(evidence.contracts[0].contractHash, hash(contract));
  const consumer = m.plans.at(-1).proposal.tasks.find(t => t.id === 'integrate');
  const inherited = predecessorContracts(f.store, m, consumer);
  assert.equal(inherited[0].commit, evidence.delivery.commit);
  const prompts = f.calls.filter(c => c.type === 'submit' && c.payload.links.taskId === 'integrate').map(c => c.payload.prompt);
  assert.ok(prompts.length >= 3);
  for (const prompt of prompts) {
    assert.ok(prompt.includes('"inputContracts"') && prompt.includes(evidence.id) && prompt.includes('value-api'));
    assert.ok(prompt.length < 20000);
  }
  assert.ok(f.provider.prompts.some(p => p.includes('"inputContracts"') && p.includes(evidence.id)));
  // Multi-hop handoff retains the original producer even if the intermediate has no exports.
  const transitive = predecessorContracts(f.store, m, { dependsOn: ['integrate'] });
  assert.equal(transitive.length, 1);
  const changed = structuredClone(m);
  changed.liveCheckpoints.one.files.find(f => f.path === 'source.mjs').digest = 'changed-after-handoff';
  assert.throws(() => predecessorContracts(f.store, changed, consumer), { code: 'stale-contract' });
  f.store.transaction(() => f.store.put('evidence', { ...evidence, contracts: [{ ...evidence.contracts[0], symbol: 'tampered' }] }, evidence.revision));
  assert.throws(() => predecessorContracts(f.store, m, consumer), { code: 'invalid-evidence' });
});

test('contracts require bounded structured inputs, errors, safe files and explicit passing check bindings', () => {
  const recipe = { checks: [{ id: 'check-one' }], exports: [contract] };
  validateExports(recipe);
  const variants = [
    { ...contract, path: '../secret' }, { ...contract, checkIds: ['missing'] },
    { ...contract, inputs: [{ name: 'amount', type: 'number' }] },
    { ...contract, errors: [{ type: 'RangeError' }] }, { ...contract, returns: {} },
    { ...contract, symbol: 'x'.repeat(6001) },
  ];
  for (const c of variants) assert.throws(() => validateExports({ ...recipe, exports: [c] }));
  assert.throws(() => bindExports(recipe, { files: [] }, [{ id: 'check-one', passed: true }]), { code: 'invalid-contract' });
  assert.throws(() => bindExports(recipe, { files: [{ path: 'source.mjs', digest: 'h' }] }, [{ id: 'check-one', passed: false }]), { code: 'invalid-contract' });
  assert.deepEqual(bindExports({ checks: [] }, { files: [] }, []), []);
});

test('missing declared contract source prevents verification evidence and retains the project lock', async t => {
  const f = controlFixture(t);
  f.verifier.configure(f.mission.id, { ...f.recipes[0], exports: [{ ...contract, path: 'missing.mjs' }] }, f.store.need('mission', f.mission.id).revision);
  const withProvider = await new LiveWorkflow(f.store).run(f.mission.id, f.host, f.provider);
  assert.equal(withProvider.mission.attempts.find(a => a.taskId === 'edit-one').state, 'unknown');
  assert.equal(f.store.list('evidence').filter(e => e.taskId === 'edit-one').length, 0);
  assert.ok(f.store.lock('one'));
});

test('oversized handoff context is rejected before reservation or external submission without truncating contracts', async t => {
  const f = controlFixture(t), m = f.store.need('mission', f.mission.id);
  f.store.transaction(() => f.store.put('mission', { ...m, goal: 'x'.repeat(20001) }, m.revision));
  await assert.rejects(new LiveExecution(f.store).dispatch(m.id, 'edit-one', f.host, {
    expectedRevision: f.store.need('mission', m.id).revision, expectedState: f.stateOf('one').stateVersion,
  }), { code: 'handoff-context-limit' });
  assert.equal(f.store.need('mission', m.id).attempts.length, 0);
  assert.equal(f.store.lock('one'), undefined);
  assert.equal(f.calls.filter(c => c.type === 'submit').length, 0);
  const result = await new LiveWorkflow(f.store).run(m.id, f.host);
  assert.equal(result.mission.progress.tasks[0].status, 'blocked');
  assert.equal(result.mission.progress.tasks[0].reason, 'handoff-context-limit');
});
