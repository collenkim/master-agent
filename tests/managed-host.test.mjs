import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { setup } from './helpers.mjs';
import { controlFixture } from './control-fixture.mjs';
import { Store } from '../packages/storage/store.mjs';
import { Engine } from '../packages/orchestrator/engine.mjs';
import { LiveExecution } from '../packages/orchestrator/live.mjs';
import { acceptRequest } from '../packages/orchestrator/requests.mjs';
import { prepareRequest } from '../packages/orchestrator/preparation.mjs';
import { ControlHost, bindControl, checkManagedSupport } from '../packages/runner/control-host.mjs';
import { hostPrompt } from '../packages/runner/claude-host.mjs';
import { controlProbe, hostReadinessIssue } from '../packages/code-agent-adapter/pairing.mjs';

test('managed prompts follow injected host and flow procedures; direct Claude remains explicit', () => {
  const ticket = { goal: '작업', taskNumber: 'TASK-1', codeAgentWorkId: 'MA-1' };
  const managed = hostPrompt(ticket, { control: true });
  assert.ok(!managed.includes('.claude/') && !managed.includes('CLAUDE.md'));
  assert.ok(managed.includes('code-agent flow advance --json'));
  assert.ok(managed.includes('procedure·instruction·agent·contextFile'));
  assert.ok(hostPrompt(ticket).includes('.claude/skills/ca-request/SKILL.md'));
  checkManagedSupport({ versions: [1], hosts: [{ kind: 'codex', supported: true }] });
  assert.throws(() => checkManagedSupport({ versions: [1], hosts: [{ kind: 'codex', supported: false }] }), { code: 'control-unsupported' });
});

test('Codex installation without Claude passes preparation; host selection stays with code-agent', async t => {
  const f = setup(t), p = f.fixture.projects[0];
  mkdirSync(join(p.path, '.code-agent')); writeFileSync(join(p.path, '.code-agent/version'), '1.0.0');
  writeFileSync(join(p.path, 'AGENTS.md'), 'Codex');
  f.store.put('control-binding', { id: p.id, owner: true, controller: 'test', generation: 1 });
  const request = acceptRequest(f.store, { targetType: 'project', targetId: p.id, goal: '작업' }).request;
  const report = await prepareRequest(f.store, request, { observe: async () => ({ status: 'observed' }), clientFor: () => ({ async result(type) {
    return type === 'hello' ? { versions: [1], hosts: [{ kind: 'codex', supported: true }], project: { enabled: true }, ownership: { controller: 'test', generation: 1 } } : {};
  } }) });
  assert.equal(report.state, 'ready'); assert.equal(existsSync(join(p.path, 'CLAUDE.md')), false);
  assert.equal(report.checks.find(c => c.kind === 'host').host, 'code-agent');
  const registered = f.engine.catalog.registerManual({ id: 'managed', name: 'managed', path: f.root, domains: ['test'] });
  assert.deepEqual(registered.capabilities, ['code-agent:managed']);
});

test('managed capability dispatches through LiveExecution and unconfirmed threads cannot continue', async t => {
  const f = controlFixture(t, { capability: 'code-agent:managed' });
  const live = new LiveExecution(f.store);
  await live.dispatch(f.mission.id, 'edit-one', f.host, { expectedRevision: f.store.need('mission', f.mission.id).revision, expectedState: f.stateOf('one').stateVersion });
  const m = f.store.need('mission', f.mission.id), a = m.attempts[0];
  assert.equal(a.provider, 'code-agent'); assert.equal(a.state, 'waiting-decision');
  f.host.updateRun(a.turns.at(-1).result.control.runId, { state: 'completed', hostKind: 'codex', sessionConfirmed: true });
  assert.equal(f.engine.describe(m.id).progress.tasks.find(task => task.taskId === 'edit-one').executionHost, 'codex');
  a.turns.at(-1).result.control.sessionConfirmed = false;
  f.store.put('mission', m, m.revision);
  await assert.rejects(live.continue(m.id, a.id, f.host, { expectedRevision: f.store.need('mission', m.id).revision, expectedState: f.stateOf('one').stateVersion }), { code: 'unconfirmed-session' });
});

test('same-state observations retain Codex thread confirmation instead of the accepted alias', t => {
  const f = setup(t), host = new ControlHost(f.store, { cliPath: fileURLToPath(import.meta.url) });
  f.store.put('control-run', { id: 'r', state: 'running', sessionId: 'alias' });
  host.updateRun('r', { state: 'running', sessionId: 'thread', sessionAlias: 'alias', sessionConfirmed: true, hostKind: 'codex' });
  assert.equal(f.store.need('control-run', 'r').sessionId, 'thread');
  assert.equal(f.store.need('control-run', 'r').hostKind, 'codex');
  const unconfirmed = host.outcome({ run: { state: 'completed', hostKind: 'codex', sessionId: 'alias', sessionConfirmed: false } }, 'r');
  assert.equal(unconfirmed.status, 'blocked');
});

const DIST = resolve(process.env.CODE_AGENT_DIST ?? fileURLToPath(new URL('../../code-agent/dist', import.meta.url)));
const fixture = join(DIST, 'test/masterCodexFixture.js');
test('actual code-agent supervisor injects Codex profile, confirms thread, resumes it and rejects changed host', { skip: !existsSync(fixture) && 'code-agent Codex build unavailable', timeout: 120000 }, async () => {
  // Upstream fixture confines synthetic TTY/trust and fake model execution to a temporary project/home.
  const f = createRequire(import.meta.url)(fixture).codexProject();
  const store = new Store(join(f.dir, 'master.db'));
  try {
    unlinkSync(join(f.root, 'CLAUDE.md'));
    const p = new Engine(store).catalog.registerManual({ id: 'codex', name: 'Codex', path: f.root, domains: ['test'] });
    const cliPath = join(DIST, 'agent/cli.js');
    await bindControl(store, p.id, { cliPath, controller: 'test', tokenFile: join(f.dir, 'token') });
    const host = new ControlHost(store, { cliPath, pollMs: 100, followTimeoutMs: 30000 });
    const ticket = { project: p, projectId: p.id, missionId: 'M-1', id: 'A-1', taskId: 'T-1', planVersion: 1,
      invocationId: randomUUID(), goal: 'MODE=complete', codeAgentWorkId: 'MA-1', expectedState: (await host.inspect(p)).stateVersion };
    const first = await host.execute(ticket);
    assert.equal(first.status, 'returned'); assert.equal(first.control.hostKind, 'codex');
    assert.equal(first.control.sessionConfirmed, true); assert.notEqual(first.sessionId, first.control.sessionAlias);
    assert.equal(store.need('control-run', first.control.runId).sessionId, first.sessionId);
    const resumed = await host.execute({ ...ticket, invocationId: randomUUID(), sessionId: first.sessionId, expectedState: (await host.inspect(p, undefined, first.sessionId)).stateVersion });
    assert.equal(resumed.status, 'returned'); assert.equal(resumed.sessionId, first.sessionId);
    const again = await host.reattach(ticket); assert.equal(again.sessionId, first.sessionId);
    // A synthetic policy change must never turn continue into a fresh session of another host.
    writeFileSync(join(f.root, '.code-agent/execution.json'), JSON.stringify({ version: 1, mode: 'claude' }));
    const rejected = await host.execute({ ...ticket, invocationId: randomUUID(), sessionId: first.sessionId, expectedState: (await host.inspect(p, undefined, first.sessionId)).stateVersion });
    assert.equal(rejected.status, 'blocked'); assert.equal(rejected.control.state, 'rejected');
    assert.equal(store.list('control-run').length, 2);
  } finally { store.close(); f.close(); }
});

test('actual code-agent runs the request host for new runs only and keeps the project execution setting', { skip: !existsSync(fixture) && 'code-agent Codex build unavailable', timeout: 120000 }, async () => {
  const f = createRequire(import.meta.url)(fixture).codexProject();
  const store = new Store(join(f.dir, 'master.db'));
  try {
    unlinkSync(join(f.root, 'CLAUDE.md'));
    // 프로젝트 설정은 Claude 단독 — 요청에서 고른 Codex 가 이번 실행에만 쓰여야 한다
    const setting = JSON.stringify({ version: 1, mode: 'claude' });
    writeFileSync(join(f.root, '.code-agent/execution.json'), setting);
    const p = new Engine(store).catalog.registerManual({ id: 'codex', name: 'Codex', path: f.root, domains: ['test'] });
    const cliPath = join(DIST, 'agent/cli.js');
    await bindControl(store, p.id, { cliPath, controller: 'test', tokenFile: join(f.dir, 'token') });
    const host = new ControlHost(store, { cliPath, pollMs: 100, followTimeoutMs: 30000 });
    const probe = controlProbe(await host.client(p).result('hello'));
    assert.deepEqual(probe.managedHost.runSelection, { supported: true, modes: ['claude', 'codex', 'both'] });
    assert.equal(hostReadinessIssue(probe, { mode: 'codex' }), null);
    store.put('target-request', { id: 'M-1', execution: { mode: 'codex' }, provider: 'codex', state: 'running', projectIds: [p.id] });
    const ticket = { project: p, projectId: p.id, missionId: 'M-1', id: 'A-1', taskId: 'T-1', planVersion: 1,
      invocationId: randomUUID(), goal: 'MODE=complete', codeAgentWorkId: 'MA-1', expectedState: (await host.inspect(p)).stateVersion };
    const first = await host.execute(ticket);
    assert.equal(first.status, 'returned', JSON.stringify(first.control)); assert.equal(first.control.hostKind, 'codex');
    assert.equal(readFileSync(join(f.root, '.code-agent/execution.json'), 'utf8'), setting, '프로젝트 실행 방식은 바꾸지 않는다');
    // 이어 실행은 execution 을 보내지 않고 code-agent 가 이전 실행의 선택(Codex)으로 같은 thread 를 잇는다
    const resumed = await host.execute({ ...ticket, invocationId: randomUUID(), sessionId: first.sessionId, expectedState: (await host.inspect(p, undefined, first.sessionId)).stateVersion });
    assert.equal(resumed.status, 'returned', JSON.stringify(resumed.control)); assert.equal(resumed.sessionId, first.sessionId); assert.equal(resumed.control.hostKind, 'codex');
  } finally { store.close(); f.close(); }
});
