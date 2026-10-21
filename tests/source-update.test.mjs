import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { setup } from './helpers.mjs';
import { createSourceBuilder, runSourceCommand } from '../packages/dashboard/source-update.mjs';
import { createUpdates } from '../packages/dashboard/updates.mjs';
import { startDashboard } from '../packages/dashboard/server.mjs';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = cwd => { git(cwd, 'add', '.'); git(cwd, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'fixture'); };
function fixture(t) {
  const f = setup(t), remote = join(f.root, 'remote.git'), seed = join(f.root, 'seed'), source = join(f.root, 'code-agent');
  mkdirSync(seed); git(seed, 'init', '--quiet', '-b', 'main'); git(f.root, 'init', '--quiet', '--bare', remote);
  const cli = `const fs=require('fs'),path=require('path'),root=path.resolve(__dirname,'../..'),pkg=require(path.join(root,'package.json'));
const file=path.join(process.cwd(),'.code-agent','applied');
const id=fs.existsSync(path.join(root,'.git'))?null:'package-'+pkg.version;
if(process.argv[2]==='version')console.log(JSON.stringify({schema:'code-agent.version v1',running:{kind:'bundle',version:pkg.version,entryPackage:id?{id}:null},project:{root:process.cwd(),busy:[],applied:fs.existsSync(file)?fs.readFileSync(file,'utf8'):null,pending:null}}));
else if(process.argv[2]==='update'){fs.writeFileSync(file,id);console.log('applied '+id)}else if(process.argv[2]==='help'&&process.env.CODE_AGENT_RUNTIME_SELF==='1')console.log('code-agent fixture help');else process.exit(1);`;
  writeFileSync(join(seed, 'build.cjs'), `const fs=require('fs');fs.mkdirSync('dist/agent',{recursive:true});fs.writeFileSync('dist/agent/cli.js',${JSON.stringify(cli)});`);
  writeFileSync(join(seed, 'test.cjs'), "require('assert').ok(require('fs').existsSync('dist/agent/cli.js'));console.log('fixture tests passed');");
  writeFileSync(join(seed, '.gitignore'), 'node_modules/\n');
  mkdirSync(join(seed, 'template')); writeFileSync(join(seed, 'template/SKILL.md'), 'fixture');
  function manifest(version) {
    writeFileSync(join(seed, 'package.json'), JSON.stringify({ name: 'code-agent', version, scripts: { build: 'node build.cjs', test: 'node test.cjs' } }));
    writeFileSync(join(seed, 'package-lock.json'), JSON.stringify({ name: 'code-agent', version, lockfileVersion: 3, packages: { '': { name: 'code-agent', version } } }));
  }
  manifest('1.0.0'); execFileSync(process.execPath, ['build.cjs'], { cwd: seed, windowsHide: true }); commit(seed);
  git(seed, 'remote', 'add', 'origin', remote); git(seed, 'push', '--quiet', '-u', 'origin', 'main');
  git(f.root, 'clone', '--quiet', '--branch', 'main', remote, source);
  const oldHead = git(source, 'rev-parse', 'HEAD');
  manifest('2.0.0'); commit(seed); git(seed, 'push', '--quiet');
  writeFileSync(join(source, 'local-note.txt'), '사용자 미커밋 내용');
  const cliPath = join(source, 'dist/agent/cli.js'), cacheRoot = join(f.root, 'builds');
  for (const p of f.store.list('project')) { mkdirSync(join(p.path, '.code-agent')); writeFileSync(join(p.path, '.code-agent/version'), '1'); }
  const builder = createSourceBuilder({ cacheRoot });
  return { ...f, remote, seed, source, oldHead, cliPath, cacheRoot, builder };
}

test('remote update pulls, installs, builds and runs the terminal entry check once before applying the same package to every project', async t => {
  const f = fixture(t), updates = createUpdates(f.store, { cliPath: f.cliPath, cacheRoot: f.cacheRoot });
  const plan = await updates.preview();
  assert.equal(plan.mode, 'remote'); assert.equal(plan.source.dirty, true);
  assert.equal(JSON.stringify(plan).includes(f.remote), false);
  updates.apply(plan.id); await updates.idle();
  const result = updates.snapshot().batches[0];
  assert.equal(result.state, 'completed', JSON.stringify(result));
  assert.deepEqual(result.preparation.steps.map(s => s.phase), ['clone', 'pull', 'install', 'build', 'verify', 'validate']);
  assert.equal(result.target.packageId, 'package-2.0.0');
  assert.equal(result.source.commit, git(f.seed, 'rev-parse', 'HEAD'));
  for (const p of f.store.list('project')) assert.equal(readFileSync(join(p.path, '.code-agent/applied'), 'utf8'), 'package-2.0.0');
  assert.equal(git(f.source, 'rev-parse', 'HEAD'), f.oldHead);
  assert.equal(readFileSync(join(f.source, 'local-note.txt'), 'utf8'), '사용자 미커밋 내용');
  assert.ok(existsSync(join(result.source.buildRoot, 'git-metadata')));
  assert.equal(JSON.parse(readFileSync(join(result.source.buildRoot, 'build.json'), 'utf8')).commit, result.source.commit);
});

test('a later update of the same commit reuses the completed build and drops its fresh clone', async t => {
  const f = fixture(t), updates = createUpdates(f.store, { cliPath: f.cliPath, cacheRoot: f.cacheRoot });
  // An interrupted build of the same commit has no build.json and is never reused.
  mkdirSync(join(f.cacheRoot, 'interrupted/node_modules/code-agent/dist/agent'), { recursive: true });
  updates.apply((await updates.preview()).id); await updates.idle();
  const first = updates.snapshot().batches[0];
  updates.apply((await updates.preview()).id); await updates.idle();
  const second = updates.snapshot().batches[0];
  assert.notEqual(second.id, first.id);
  assert.equal(second.state, 'completed', JSON.stringify(second));
  assert.deepEqual(second.preparation.steps.map(s => s.phase), ['clone', 'pull', 'reuse', 'verify', 'validate']);
  assert.equal(second.source.buildRoot, first.source.buildRoot);
  assert.equal(second.target.packageId, 'package-2.0.0');
  assert.deepEqual(readdirSync(f.cacheRoot).sort(), [basename(first.source.buildRoot), 'interrupted'].sort());
});

for (const phase of ['pull', 'install', 'build', 'verify']) test(`${phase} failure never invokes project update`, async t => {
  const f = fixture(t);
  if (phase === 'pull') git(f.source, 'remote', 'set-url', 'origin', 'https://user:private-token@example.invalid/source.git');
  const builder = createSourceBuilder({ cacheRoot: f.cacheRoot, run: async (file, args, cwd, timeout, env) => {
    const match = phase === 'pull' ? args[0] === 'pull' : phase === 'install' ? args.includes('ci') : phase === 'build' ? args.includes('build') : args.includes('help');
    return match ? { code: 1, stdout: 'injected failure https://user:private-token@example.invalid/source.git' } : runSourceCommand(file, args, cwd, timeout, env);
  } });
  const updates = createUpdates(f.store, { cliPath: f.cliPath, sourceBuilder: builder });
  const plan = await updates.preview(); updates.apply(plan.id); await updates.idle();
  const result = updates.snapshot().batches[0];
  assert.equal(result.state, 'failed'); assert.equal(result.preparation.phase, phase);
  assert.equal(JSON.stringify(result).includes('private-token'), false);
  assert.ok(result.source.buildRoot);
  if (phase !== 'pull') assert.equal(result.source.commit, git(f.seed, 'rev-parse', 'HEAD'));
  assert.ok(result.projects.every(p => p.state === 'cancelled'));
  assert.ok(f.store.list('project').every(p => !existsSync(join(p.path, '.code-agent/applied'))));
  assert.equal(git(f.source, 'rev-parse', 'HEAD'), f.oldHead);
});

test('a step that outlives its limit fails instead of passing and its process tree stops', async t => {
  const f = setup(t), pidFile = join(f.root, 'grandchild.pid');
  const script = `const c=require('child_process').spawn(process.execPath,['-e','setTimeout(()=>{},60000)'],{stdio:'ignore'});require('fs').writeFileSync(${JSON.stringify(pidFile)},String(c.pid));setTimeout(()=>{},60000);`;
  const result = await runSourceCommand(process.execPath, ['-e', script], f.root, 2000);
  assert.equal(result.code, 'timeout');
  if (process.platform !== 'win32') return;
  const pid = Number(readFileSync(pidFile, 'utf8'));
  let alive = true;
  for (let n = 0; n < 30 && alive; n++) { try { process.kill(pid, 0); await delay(100); } catch { alive = false; } }
  assert.equal(alive, false);
});

test('changed upstream and divergent local history are rejected before applying projects', async t => {
  const f = fixture(t), expected = await f.builder.audit(f.cliPath);
  git(f.source, 'config', 'branch.main.merge', 'refs/heads/other');
  await assert.rejects(f.builder.prepare(expected), { code: 'stale-state' });
  git(f.source, 'config', 'branch.main.merge', 'refs/heads/main');
  writeFileSync(join(f.source, 'local-commit.txt'), 'unpublished'); commit(f.source);
  const changed = await f.builder.audit(f.cliPath);
  await assert.rejects(f.builder.prepare(changed), { code: 'source-update-failed' });
});

test('source validation rejects missing upstream and non-Git installations without guessing a remote', async t => {
  const f = fixture(t);
  git(f.source, 'config', '--unset', 'branch.main.remote');
  await assert.rejects(f.builder.audit(f.cliPath), { code: 'source-unavailable' });
  await assert.rejects(f.builder.audit(join(f.root, 'missing/dist/agent/cli.js')), { code: 'source-unavailable' });
});

test('stopping source preparation prevents later stages and never updates managed projects', async t => {
  const f = fixture(t); let stop = false;
  await assert.rejects(f.builder.prepare(await f.builder.audit(f.cliPath), {
    stopped: () => stop, progress: event => { if (event.phase === 'pull' && event.state === 'completed') stop = true; },
  }), { code: 'update-stopped' });
  assert.ok(f.store.list('project').every(p => !existsSync(join(p.path, '.code-agent/applied'))));
});

test('remote HTTP preview is read-only and returns progress after authenticated asynchronous apply', async t => {
  const f = fixture(t), dashboard = await startDashboard({ dbPath: f.db, port: 0, observe: false, cliPath: f.cliPath });
  try {
    const overview = await (await fetch(dashboard.url + '/api/overview')).json();
    const post = (path, body) => fetch(dashboard.url + path, { method: 'POST', headers: { Origin: dashboard.url,
      'Content-Type': 'application/json', 'X-Master-Token': overview.token }, body: JSON.stringify(body) });
    const preview = await post('/api/updates/preview', {}); assert.equal(preview.status, 200);
    const plan = await preview.json(); assert.equal(plan.mode, 'remote');
    assert.equal(existsSync(join(f.root, 'code-agent-builds')), false);
    assert.equal((await post('/api/updates/apply', { id: plan.id })).status, 202);
    assert.equal((await post('/api/updates/apply', { id: plan.id })).status, 202);
    // close waits for the current preparation stage and cancels the remaining work.
  } finally { await dashboard.close(); }
  assert.equal(git(f.source, 'rev-parse', 'HEAD'), f.oldHead);
});
