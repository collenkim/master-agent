import test from 'node:test';
import assert from 'node:assert/strict';
import { controlFixture } from './control-fixture.mjs';
import { LiveWorkflow } from '../packages/orchestrator/drive.mjs';
import { LiveExecution } from '../packages/orchestrator/live.mjs';
import { predecessorContracts, validateExports, bindExports, contractLines, dependencyBundle, verifyContractDocuments } from '../packages/verification/handoff-contracts.mjs';
import { hash } from '../packages/domain/contracts.mjs';
import { writeFileSync, existsSync, mkdirSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { hostPrompt } from '../packages/runner/claude-host.mjs';

const contract = {
  id: 'value-api', path: 'source.mjs', symbol: 'value', inputs: [],
  returns: { type: 'number', description: '상수 2' }, errors: [], checkIds: ['check-one'],
};

const dependencyModule = resolve(process.env.CODE_AGENT_DIST ?? '../code-agent/dist', 'agent/dependencyContracts.js');
test('committed contract documents become a code-agent bundle and verified local copy, never a fabricated claim', async t => {
  const declaration = { ...contract, documentPath: 'contracts/value.md' };
  const f = controlFixture(t, { contractDocuments: { one: { 'contracts/value.md': contractLines(declaration).join('\n') + '\n' } } });
  f.verifier.configure(f.mission.id, { ...f.recipes[0], exports: [declaration] }, f.store.need('mission', f.mission.id).revision);
  assert.equal((await new LiveWorkflow(f.store).run(f.mission.id, f.host, f.provider)).mission.state, 'succeeded');
  const m = f.store.need('mission', f.mission.id);
  const inputs = predecessorContracts(f.store, m, f.tasks.find(t => t.id === 'integrate'));
  const bundle = dependencyBundle(inputs);
  assert.equal(bundle.contracts[0].repository, realpathSync.native(f.projects[0].path));
  assert.equal(bundle.contracts[0].commit.length, 40);
  assert.deepEqual(bundle.contracts[0].claims.map(c => c.text), contractLines(declaration));
  const prompt = hostPrompt({ inputContracts: inputs }, { control: true });
  assert.match(prompt, /code-agent planning contracts/);
  assert.match(prompt, /첫 planning 담당 배정 전에/);
  assert.ok(prompt.length < 20000);
  const evidence = f.store.list('evidence').find(e => e.taskId === 'edit-one');
  assert.throws(() => bindExports({ exports: [{ ...declaration, symbol: 'different' }] }, evidence.tree, evidence.checks), { code: 'invalid-contract' });
  const alteredTree = structuredClone(evidence.tree), alteredContracts = structuredClone(evidence.contracts);
  alteredTree.files.find(f => f.path === declaration.documentPath).digest = '0'.repeat(64);
  alteredContracts[0].document.sha256 = '0'.repeat(64);
  assert.throws(() => verifyContractDocuments(alteredContracts, alteredTree, evidence.delivery.commit), { code: 'invalid-contract' });
  const changedCheckpoint = structuredClone(m);
  changedCheckpoint.liveCheckpoints.one.files.find(f => f.path === declaration.documentPath).digest = 'changed';
  assert.throws(() => predecessorContracts(f.store, changedCheckpoint, f.tasks.find(t => t.id === 'integrate')), { code: 'stale-contract' });
  await t.test('actual code-agent registration accepts the bundle and rejects tampered claims or documents', {
    skip: !existsSync(dependencyModule) && 'code-agent dependencyContracts build absent',
  }, () => {
    const { registerContracts, dependencyContracts } = createRequire(import.meta.url)(dependencyModule);
    const consumer = join(f.root, 'consumer'); mkdirSync(consumer);
    const file = join(f.root, 'bundle.json'); writeFileSync(file, JSON.stringify(bundle));
    registerContracts(consumer, 'contract-test', file);
    assert.equal(dependencyContracts(consumer, 'contract-test').problems.length, 0);
    const altered = structuredClone(bundle); altered.contracts[0].claims[0].text = 'unproven statement';
    writeFileSync(file, JSON.stringify(altered));
    assert.throws(() => registerContracts(consumer, 'contract-test', file), /원문 한 줄/);
    writeFileSync(join(f.projects[0].path, declaration.documentPath), 'changed\n');
    assert.ok(dependencyContracts(consumer, 'contract-test').problems.length);
  });
});

test('document declarations reject uncommitted delivery, escaped paths and text that differs from the structured contract', () => {
  assert.throws(() => validateExports({ checks: [{ id: 'check-one' }], exports: [{ ...contract, documentPath: 'contract.md' }] }), { code: 'invalid-contract' });
  assert.throws(() => validateExports({ delivery: { mode: 'code-agent-commit' }, checks: [{ id: 'check-one' }], exports: [{ ...contract, documentPath: '../contract.md' }] }));
  assert.throws(() => dependencyBundle([{ projectId: 'one', commit: null, contracts: [{ ...contract, document: { path: 'contract.md', sha256: '0'.repeat(64) } }] }]), { code: 'invalid-contract' });
});

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
