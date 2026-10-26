import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import fs from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { installationFingerprint } from '../packages/dashboard/installation.mjs';
import { hostname } from 'node:os';
import { setup } from './helpers.mjs';
import { createUpdates, runUpdateCli } from '../packages/dashboard/updates.mjs';
import { startDashboard } from '../packages/dashboard/server.mjs';
import { findCodeAgent } from '../packages/code-agent-adapter/discovery.mjs';
import { SimulationRunner } from '../packages/runner/simulation.mjs';

function fixture(t) {
  const f = setup(t), pkg = join(f.root, 'code-agent'), cliPath = join(pkg, 'dist/agent/cli.js');
  f.fixture.projects = f.store.list('project');
  mkdirSync(join(pkg, 'dist/agent'), { recursive: true }); mkdirSync(join(pkg, 'template'));
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'code-agent', version: '2.0.0' }));
  writeFileSync(cliPath, '// fixture'); writeFileSync(join(pkg, 'template/SKILL.md'), 'new template');
  for (const p of f.fixture.projects) { mkdirSync(join(p.path, '.code-agent')); writeFileSync(join(p.path, '.code-agent/version'), '1'); }
  const calls = [], views = new Map(), outcomes = new Map();
  const run = async (cli, args, cwd, onSpawn) => {
    calls.push({ cli, args, cwd });
    if (args[0] === 'version') return { code: 0, stdout: JSON.stringify({ schema: 'code-agent.version v1',
      running: { kind: 'bundle', version: '2.0.0', entryPackage: null }, project: { root: cwd, busy: [], applied: null, pending: null }, ...views.get(cwd) }) };
    onSpawn?.(999999999);
    return outcomes.has(cwd) ? await outcomes.get(cwd)() : { code: 0, stdout: 'applied' };
  };
  return { ...f, cliPath, pkg, calls, views, outcomes, run, updates: createUpdates(f.store, { cliPath, run }) };
}

test('bulk updates use only registered installed idle roots and persist independent results', async t => {
  const f = fixture(t), [one, two, three] = f.fixture.projects;
  f.views.set(two.path, { project: { root: two.path, busy: ['승인 대기'], applied: 'old' } });
  f.outcomes.set(three.path, async () => ({ code: 1, stderr: 'failure detail' }));
  const plan = await f.updates.preview({ mode: 'installed' });
  assert.deepEqual(plan.target.args, ['update', '--bundled']); assert.equal(plan.target.resetsPin, true);
  assert.equal(plan.projects.find(p => p.id === two.id).state, 'skipped');
  const batch = await f.updates.apply(plan.id);
  assert.equal((await f.updates.apply(plan.id)).id, batch.id);
  await f.updates.idle();
  const result = f.updates.snapshot().batches[0];
  assert.equal(result.projects.find(p => p.id === one.id).state, 'completed');
  assert.equal(result.projects.find(p => p.id === two.id).state, 'skipped');
  assert.equal(result.projects.find(p => p.id === three.id).state, 'failed');
  assert.match(result.projects.find(p => p.id === three.id).output, /failure detail/);
  assert.equal(f.calls.filter(c => c.args[0] === 'update').length, 2);
  assert.equal(f.updates.snapshot().maintenance.length, 0);
});

test('preview binds the exact install and catalog, rejecting changed builds and new registrations', async t => {
  const f = fixture(t), plan = await f.updates.preview({ mode: 'installed' });
  writeFileSync(join(f.pkg, 'template/SKILL.md'), 'changed since preview');
  await assert.rejects(async () => await f.updates.apply(plan.id), { code: 'stale-state' });
  const next = await f.updates.preview({ mode: 'installed' }), project = f.store.need('project', f.fixture.projects[0].id);
  f.store.put('project', { ...project, name: 'changed' }, project.revision);
  await assert.rejects(async () => await f.updates.apply(next.id), { code: 'stale-state' });
  assert.equal(f.calls.some(c => c.args[0] === 'update'), false);
});

test('deleting a project invalidates old update previews and excludes its path from new updates', async t => {
  const f = fixture(t);
  await f.engine.run(f.mission.id, new SimulationRunner());
  const plan = await f.updates.preview({ mode: 'installed' }), project = f.store.need('project', plan.projects[0].id);
  f.engine.catalog.remove(project.id, project.revision);
  await assert.rejects(async () => await f.updates.apply(plan.id), { code: 'stale-state' });
  f.calls.length = 0;
  const next = await f.updates.preview({ mode: 'installed' });
  assert.equal(next.projects.length, 2);
  await f.updates.apply(next.id); await f.updates.idle();
  assert.equal(f.calls.some(c => c.cwd === project.path), false);
  assert.equal(f.updates.snapshot().batches[0].state, 'completed');
});

test('master execution and maintenance mutually exclude each other; shutdown cancels remaining projects', async t => {
  const f = fixture(t), plan = await f.updates.preview({ mode: 'installed' });
  const [first, second, third] = plan.projects;
  f.store.acquire(second.id, f.mission.id, 'existing-work');
  let unblock, started;
  const gate = new Promise(resolve => { unblock = resolve; }), signal = new Promise(resolve => { started = resolve; });
  f.outcomes.set(first.path, async () => { started(); await gate; return { code: 0, stdout: 'done' }; });
  await f.updates.apply(plan.id); await signal;
  assert.throws(() => f.store.acquire(first.id, 'other', 'attempt'), { code: 'project-busy' });
  await assert.rejects(async () => await f.updates.apply('other-plan'), { code: 'request-busy' });
  const closing = f.updates.stop(); unblock(); await closing;
  const result = f.updates.snapshot().batches[0];
  assert.equal(result.projects.find(p => p.id === first.id).state, 'completed');
  assert.equal(result.projects.find(p => p.id === third.id).state, 'cancelled');
  assert.equal(f.calls.filter(c => c.args[0] === 'update').length, 1);
  f.store.acquire(first.id, 'other', 'released');
});

test('apply rechecks master locks after preview and continues past template warnings or held updates', async t => {
  const f = fixture(t), plan = await f.updates.preview({ mode: 'installed' }), [one, two, three] = plan.projects;
  f.store.acquire(one.id, f.mission.id, 'new-work');
  f.outcomes.set(two.path, async () => ({ code: 0, stdout: '!! template-conflicts: user changes preserved' }));
  f.outcomes.set(three.path, async () => ({ code: 3, stdout: 'pending next work' }));
  await f.updates.apply(plan.id); await f.updates.idle();
  assert.deepEqual(f.updates.snapshot().batches[0].projects.map(p => p.state), ['skipped', 'needs-attention', 'skipped']);
});

test('unconfirmed process exit blocks development until explicit idle recovery; interrupted runs are never replayed', async t => {
  const f = fixture(t), plan = await f.updates.preview({ mode: 'installed' }), one = plan.projects[0];
  f.outcomes.set(one.path, async () => ({ code: 'TIMEOUT', uncertain: true }));
  await f.updates.apply(plan.id); await f.updates.idle();
  assert.equal(f.updates.snapshot().batches[0].projects[0].state, 'interrupted');
  assert.throws(() => f.store.acquire(one.id, 'm', 'a'), { code: 'project-busy' });
  const record = f.store.need('project-maintenance', one.id);
  f.store.put('project-maintenance', { ...record, pid: 999999998, host: hostname() }, record.revision);
  const restarted = createUpdates(f.store, { cliPath: f.cliPath, run: f.run });
  assert.equal(restarted.snapshot().maintenance[0].recoverable, true);
  assert.equal((await restarted.recover(one.id)).state, 'released');
  f.store.acquire(one.id, 'm', 'a');
  const count = f.calls.length;
  await restarted.apply(plan.id); await restarted.idle(); assert.equal(f.calls.length, count);
});

test('wrong project roots and malformed version responses are skipped without mutation', async t => {
  const f = fixture(t), [one, two, three] = f.fixture.projects;
  f.views.set(one.path, { project: { root: f.root, busy: [] } });
  f.views.set(two.path, { schema: 'unsupported' });
  f.views.set(three.path, { project: { root: three.path, busy: null } });
  const plan = await f.updates.preview({ mode: 'installed' }); await f.updates.apply(plan.id); await f.updates.idle();
  assert.ok(plan.projects.every(p => p.state === 'skipped'));
  assert.equal(f.calls.some(c => c.args[0] === 'update'), false);
});

test('npm entry selects public templates-only update and verifies the applied package release', async t => {
  const f = fixture(t), applied = new Set();
  const run = async (cli, args, cwd) => {
    if (args[0] === 'update') { assert.deepEqual(args, ['update', '--templates-only']); applied.add(cwd); return { code: 0 }; }
    return { code: 0, stdout: JSON.stringify({ schema: 'code-agent.version v1',
      running: { kind: 'bundle', version: '2', entryPackage: { id: 'package-new' } },
      project: { root: cwd, busy: [], applied: applied.has(cwd) ? 'package-new' : null, pending: null } }) };
  };
  const updates = createUpdates(f.store, { cliPath: f.cliPath, run }), plan = await updates.preview({ mode: 'installed' });
  await updates.apply(plan.id); await updates.idle();
  assert.equal(updates.snapshot().batches[0].state, 'completed');
});

test('HTTP update endpoints require dashboard authentication and only accept server preview identifiers', async t => {
  const f = fixture(t), dashboard = await startDashboard({ dbPath: f.db, port: 0, observe: false, updateOptions: { cliPath: f.cliPath, run: f.run } });
  try {
    const overview = await (await fetch(dashboard.url + '/api/overview')).json();
    const post = (path, body, token = overview.token) => fetch(dashboard.url + path, { method: 'POST', headers: { Origin: dashboard.url,
      'Content-Type': 'application/json', 'X-Master-Token': token }, body: JSON.stringify(body) });
    assert.equal((await post('/api/updates/preview', {}, 'wrong')).status, 403);
    assert.equal((await post('/api/updates/apply', { id: 'fake', path: f.root, args: ['update'] })).status, 409);
    const plan = await (await post('/api/updates/preview', { mode: 'installed' })).json();
    assert.equal((await post('/api/updates/apply', { id: plan.id })).status, 202);
  } finally { await dashboard.close(); }
});

test('CLI runner passes argument arrays, preserves nonzero output and clears inherited runtime overrides', async t => {
  const f = fixture(t);
  writeFileSync(f.cliPath, "console.log(JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),override:process.env.CODE_AGENT_RUNTIME_SELF??null}));process.exit(3)");
  const prior = process.env.CODE_AGENT_RUNTIME_SELF; process.env.CODE_AGENT_RUNTIME_SELF = '1';
  try {
    const result = await runUpdateCli(f.cliPath, ['update', '--bundled'], f.root);
    assert.equal(result.code, 3); assert.equal(result.uncertain, false);
    assert.deepEqual(JSON.parse(result.stdout), { args: ['update', '--bundled'], cwd: f.root, override: null });
  } finally { if (prior === undefined) delete process.env.CODE_AGENT_RUNTIME_SELF; else process.env.CODE_AGENT_RUNTIME_SELF = prior; }
});

test('installed code-agent updates isolated projects, restores missing templates and preserves user edits', async t => {
  const cliPath = findCodeAgent(undefined, { required: false });
  if (!cliPath) return t.skip('code-agent 설치본 없음');
  const f = setup(t), projects = f.store.list('project');
  for (const project of projects) {
    execFileSync('git', ['init', '--quiet', project.path], { windowsHide: true, stdio: 'pipe' });
    const init = await runUpdateCli(cliPath, ['init', '--host', 'claude'], project.path);
    assert.equal(init.code, 0, init.stderr || init.stdout);
  }
  const updates = createUpdates(f.store, { cliPath });
  const baseline = await updates.preview({ mode: 'installed' }); await updates.apply(baseline.id); await updates.idle();
  assert.ok(updates.snapshot().batches[0].projects.every(p => ['completed', 'needs-attention'].includes(p.state)), JSON.stringify(updates.snapshot()));
  const skill = '.claude/skills/ca-request/SKILL.md';
  const original = readFileSync(join(projects[0].path, skill), 'utf8');
  rmSync(join(projects[0].path, skill));
  const custom = readFileSync(join(projects[1].path, skill), 'utf8') + '\n사용자 추가 규칙을 보존한다.\n';
  writeFileSync(join(projects[1].path, skill), custom);
  writeFileSync(join(projects[2].path, '.code-agent/request-session.json'), '{}');
  const plan = await updates.preview({ mode: 'installed' }); await updates.apply(plan.id); await updates.idle();
  const result = updates.snapshot().batches.find(b => b.id === plan.id);
  assert.ok(['completed', 'needs-attention'].includes(result.projects[0].state), JSON.stringify(result));
  assert.equal(result.projects[1].state, 'needs-attention');
  assert.equal(result.projects[2].state, 'skipped');
  assert.equal(readFileSync(join(projects[0].path, skill), 'utf8'), original);
  assert.equal(readFileSync(join(projects[1].path, skill), 'utf8'), custom);
});



test('M7: N개 프로젝트를 적용해도 설치본 지문 호출은 시작·끝 두 번이다', async t => {
  const f = fixture(t); let count = 0;
  const updates = createUpdates(f.store, { cliPath: f.cliPath, run: f.run, fingerprint: async cli => { count++; return installationFingerprint(cli); } });
  const plan = await updates.preview({ mode: 'installed' }); count = 0;
  const first = updates.apply(plan.id), replay = updates.apply(plan.id);
  await assert.rejects(updates.apply('another-plan'), { code: 'request-busy' });
  assert.equal((await first).id, (await replay).id);
  await updates.idle();
  assert.equal(count, 2); assert.equal(f.calls.filter(c => c.args[0] === 'update').length, plan.projects.length);
  assert.equal(updates.snapshot().batches[0].state, 'completed');
});

test('M7: 설치본 파일 집합·크기·시각이 같으면 본문 스트림을 다시 열지 않는다', async t => {
  const f = fixture(t), open = fs.open; let reads = 0;
  t.mock.method(fs, 'open', (...args) => { reads++; return open(...args); });
  const first = await installationFingerprint(f.cliPath), initialReads = reads;
  assert.ok(initialReads > 0);
  assert.equal(await installationFingerprint(f.cliPath), first);
  assert.equal(reads, initialReads);
  writeFileSync(join(f.pkg, 'template/SKILL.md'), 'changed template bytes');
  assert.notEqual(await installationFingerprint(f.cliPath), first);
  assert.ok(reads > initialReads);
});

test('M7: 적용 중 설치본 변경은 남은 프로젝트를 취소하고 성공으로 기록하지 않는다', async t => {
  const f = fixture(t), plan = await f.updates.preview({ mode: 'installed' });
  f.outcomes.set(plan.projects[0].path, async () => {
    writeFileSync(join(f.pkg, 'template/SKILL.md'), 'install changed while applying');
    await delay(30);
    return { code: 0, stdout: 'applied' };
  });
  await f.updates.apply(plan.id); await f.updates.idle();
  const result = f.updates.snapshot().batches[0];
  assert.equal(f.calls.filter(c => c.args[0] === 'update').length, 1);
  assert.deepEqual(result.projects.map(p => p.state), ['failed', 'cancelled', 'cancelled']);
  assert.equal(result.state, 'failed'); assert.equal(f.updates.snapshot().maintenance.length, 0);
});
