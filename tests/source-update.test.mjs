import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { setup } from './helpers.mjs';
import { createSourceInstaller, runUpdateCli } from '../packages/dashboard/source-update.mjs';
import { createUpdates } from '../packages/dashboard/updates.mjs';
import { startDashboard } from '../packages/dashboard/server.mjs';

function fixture(t) {
  const f = setup(t), pkg = join(f.root, 'code-agent'), cliPath = join(pkg, 'dist/agent/cli.js'), file = join(f.root, 'state.json');
  mkdirSync(join(pkg, 'dist/agent'), { recursive: true }); mkdirSync(join(pkg, 'template'));
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'code-agent', version: '1.0.0', type: 'module' }));
  copyFileSync(resolve('tests/update-fake-cli.mjs'), cliPath);
  writeFileSync(file, '{}');
  const before = Object.fromEntries(['FAKE_UPDATE_STATE', 'CLAUDECODE', 'CODEX_SANDBOX', 'CODE_AGENT_RUNTIME_SELF'].map(key => [key, process.env[key]]));
  Object.assign(process.env, { FAKE_UPDATE_STATE: file, CLAUDECODE: '1', CODEX_SANDBOX: '1', CODE_AGENT_RUNTIME_SELF: '1' });
  t.after(() => { for (const [key, value] of Object.entries(before)) if (value === undefined) delete process.env[key]; else process.env[key] = value; });
  const projects = f.store.list('project');
  for (const p of projects) { mkdirSync(join(p.path, '.code-agent')); writeFileSync(join(p.path, '.code-agent/version'), '1'); }
  const read = () => JSON.parse(readFileSync(file, 'utf8'));
  const set = values => writeFileSync(file, JSON.stringify({ ...read(), ...values }));
  const calls = () => existsSync(file + '.calls') ? readFileSync(file + '.calls', 'utf8').trim().split('\n').map(JSON.parse) : [];
  return { ...f, projects, cliPath, file, read, set, calls, installer: createSourceInstaller(), updates: createUpdates(f.store, { cliPath }) };
}
async function installed(f) {
  const plan = await f.updates.preview(); f.updates.install(plan.id); await f.updates.idle(); return plan;
}

test('public CLI installation and per-project confirmations are separate, exact and idempotent', async t => {
  const f = fixture(t), plan = await f.updates.preview();
  assert.equal(plan.stage, 'install'); assert.equal(f.read().installed, undefined);
  assert.throws(() => f.updates.apply(plan.id), { code: 'stale-state' });
  f.updates.install(plan.id); f.updates.install(plan.id); await f.updates.idle();
  assert.equal(f.updates.snapshot().batches[0].state, 'awaiting-confirmation');
  assert.equal(f.read().applied, undefined);
  assert.throws(() => f.updates.apply(plan.id), { code: 'stale-state' });
  const apply = await f.updates.previewApply(plan.id);
  assert.equal(f.read().applied, undefined);
  f.updates.apply(apply.id, apply.previewId); f.updates.apply(apply.id, apply.previewId); await f.updates.idle();
  const result = f.updates.snapshot().batches[0]; assert.equal(result.state, 'completed');
  assert.ok(result.projects.every(p => p.current === result.release.id));
  const calls = f.calls(); assert.ok(calls.every(c => c.marked.length === 0));
  assert.ok(calls.filter(c => c.args.includes('--install-only')).every(c => !c.cwd.startsWith(f.root)));
  assert.equal(calls.filter(c => c.args.includes('--install-only') && c.args.includes('--shown-hash')).length, 1);
  for (const row of apply.projects) assert.ok(calls.some(c => c.cwd === row.path && JSON.stringify(c.args) === JSON.stringify(['update', '--release', result.release.id, '--shown-hash', row.confirmation.shownHash, '--json'])));
});

test('stale installation hash fails before install; unsupported, blocked and malformed previews are explicit', async t => {
  const f = fixture(t), plan = await f.updates.preview(); f.set({ revision: 2 });
  f.updates.install(plan.id); await f.updates.idle();
  assert.equal(f.read().installed, undefined); assert.match(f.updates.snapshot().batches[0].error, /바뀌었습니다/);
  f.set({ legacy: true }); await assert.rejects(f.updates.preview(), { code: 'source-update-unsupported' });
  f.set({ legacy: false, malformed: true }); await assert.rejects(f.updates.preview(), { code: 'source-update-failed' });
  f.set({ malformed: false, blocked: 'npm distribution' }); const blocked = await f.updates.preview();
  assert.equal(blocked.installation.canInstall, false); assert.throws(() => f.updates.install(blocked.id), { code: 'source-update-unavailable' });
  f.set({ refusal: 'policy-forbids: denied' }); await assert.rejects(f.updates.preview(), { code: 'policy-forbids' });
});

test('application previews cannot be replaced by a second tab; stale project hashes fail independently', async t => {
  const f = fixture(t), plan = await installed(f), first = await f.updates.previewApply(plan.id), second = await f.updates.previewApply(plan.id);
  assert.throws(() => f.updates.apply(first.id, first.previewId), { code: 'stale-state' });
  f.set({ revisions: { [second.projects[0].path]: 2 }, failures: { [second.projects[1].path]: 3 } });
  f.updates.apply(second.id, second.previewId); await f.updates.idle();
  assert.deepEqual(f.updates.snapshot().batches[0].projects.map(p => p.state), ['failed', 'skipped', 'completed']);
  assert.equal(f.updates.snapshot().maintenance.length, 0);
});

test('restart requires fresh application preview, rechecks busy roots, and verifies release ID after apply', async t => {
  const f = fixture(t), plan = await installed(f); await f.updates.previewApply(plan.id);
  const restarted = createUpdates(f.store, { cliPath: f.cliPath });
  assert.throws(() => restarted.apply(plan.id), { code: 'stale-state' });
  f.set({ busy: { [f.projects[0].path]: ['work'] }, wrongVersion: true });
  const apply = await restarted.previewApply(plan.id); restarted.apply(plan.id, apply.previewId); await restarted.idle();
  assert.deepEqual(restarted.snapshot().batches[0].projects.map(p => p.state), ['skipped', 'failed', 'failed']);
});

test('changed catalogs invalidate apply confirmation; wrong preview roots are never applied', async t => {
  const f = fixture(t), plan = await installed(f), apply = await f.updates.previewApply(plan.id), project = f.projects[0];
  f.store.put('project', { ...project, name: 'changed' }, project.revision);
  assert.throws(() => f.updates.apply(plan.id, apply.previewId), { code: 'stale-state' });
  f.set({ wrongRoot: true }); const next = await f.updates.previewApply(plan.id);
  assert.ok(next.projects.every(p => p.state === 'skipped'));
  assert.equal(f.read().applied, undefined);
});

test('HTTP routes authenticate both confirmations and never accept a client release or shown hash', async t => {
  const f = fixture(t), dashboard = await startDashboard({ dbPath: f.db, port: 0, observe: false, cliPath: f.cliPath });
  try {
    const overview = await (await fetch(dashboard.url + '/api/overview')).json();
    const post = (path, body, token = overview.token) => fetch(dashboard.url + '/api/updates/' + path, { method: 'POST',
      headers: { Origin: dashboard.url, 'Content-Type': 'application/json', 'X-Master-Token': token }, body: JSON.stringify(body) });
    for (const route of ['preview', 'install', 'apply-preview', 'apply']) assert.equal((await post(route, {}, 'wrong')).status, 403);
    const plan = await (await post('preview', {})).json();
    assert.equal((await post('apply', { id: plan.id })).status, 409);
    assert.equal((await post('install', { id: plan.id })).status, 202);
    for (let n = 0; n < 100 && !f.read().installed; n++) await delay(30);
    await delay(100);
    const applyResponse = await post('apply-preview', { id: plan.id }); assert.equal(applyResponse.status, 200);
    const apply = await applyResponse.json();
    assert.equal((await post('apply', { id: plan.id })).status, 409);
    assert.equal((await post('apply', { id: plan.id, previewId: apply.previewId, release: 'bad', shownHash: 'bad' })).status, 202);
  } finally { await dashboard.close(); }
});

test('timeout terminates descendant processes and returns a failure, never exit code zero', async t => {
  const f = fixture(t); f.set({ timeout: true });
  const result = await runUpdateCli(f.cliPath, ['update', '--install-only', '--preview', '--json'], f.root, undefined, 1800);
  assert.equal(result.code, 'timeout'); assert.equal(result.uncertain, true);
  const pid = Number(readFileSync(f.file + '.pid', 'utf8'));
  let alive = true;
  for (let n = 0; n < 30 && alive; n++) { try { process.kill(pid, 0); await delay(100); } catch { alive = false; } }
  assert.equal(alive, false);
});
