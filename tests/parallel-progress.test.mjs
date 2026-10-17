import test from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { controlFixture } from './control-fixture.mjs';
import { LiveWorkflow } from '../packages/orchestrator/drive.mjs';
import { LiveExecution } from '../packages/orchestrator/live.mjs';
import { DecisionDelegation } from '../packages/orchestrator/decisions.mjs';
import { Store } from '../packages/storage/store.mjs';
import { cleanup } from './helpers.mjs';

// Delay completion through an explicit gate, with no wall-clock race or real model.
function pendingHost(f) {
  const original = f.host.client.bind(f.host);
  let released = false;
  f.host.client = project => {
    const client = original(project);
    return { async result(type, options = {}) {
      if (type === 'result' && !released) {
        const run = f.sims[project.id].runs[options.payload.runId];
        return { run: { runId: run.runId, sessionId: run.sessionId, state: 'running' }, final: false };
      }
      return client.result(type, options);
    } };
  };
  return () => { released = true; };
}
const current = f => f.store.need('mission', f.mission.id);

test('progress reads actual phase event from/to fields, ignores another run and clears ended work', async t => {
  const f = controlFixture(t); pendingHost(f);
  await new LiveWorkflow(f.store).advance(f.mission.id, f.host);
  const run = f.store.list('control-run')[0];
  const record = (runId, to, workId = current(f).attempts[0].codeAgentWorkId) => f.store.event(f.mission.id, 'control-event', {
    projectId: 'one', runId, eventType: 'phase.changed', data: { workId, previousWork: current(f).attempts[0].codeAgentWorkId, from: 'analysis', to },
  });
  record(run.id, 'plan');
  record('another-run', 'review');
  const cli = JSON.parse(execFileSync(process.execPath, [resolve('apps/cli/main.mjs'), 'mission', 'progress', f.mission.id, '--db', join(f.root, 'state.db')], { encoding: 'utf8' }));
  assert.equal(cli.tasks[0].phase, 'plan');
  // Approval changes phase before the continuing host is accepted; no runId is attached.
  f.store.transaction(() => f.store.put('control-run', { ...run, acceptedAt: new Date(Date.now() + 1000).toISOString() }, run.revision));
  record(undefined, 'implement');
  assert.equal(f.engine.describe(f.mission.id).progress.tasks[0].phase, 'implement');
  const beforeOtherWork = f.engine.describe(f.mission.id).progress.tasks[0].lastProgressAt;
  record(undefined, 'design', 'different-work');
  assert.equal(f.engine.describe(f.mission.id).progress.tasks[0].phase, 'implement');
  assert.equal(f.engine.describe(f.mission.id).progress.tasks[0].lastProgressAt, beforeOtherWork);
  record(undefined, null, null);
  assert.equal(f.engine.describe(f.mission.id).progress.tasks[0].phase, null);
});

test('independent control runs overlap; dependency and project locks survive pause and a new Store connection', async t => {
  const f = controlFixture(t), release = pendingHost(f), workflow = new LiveWorkflow(f.store);
  await workflow.advance(f.mission.id, f.host, f.provider);
  await workflow.advance(f.mission.id, f.host, f.provider);
  assert.deepEqual(current(f).tasks.map(t => t.state), ['running', 'running', 'queued']);
  assert.equal(f.store.list('control-run').length, 2);
  assert.ok(f.store.lock('one') && f.store.lock('two'));
  const waiting = await workflow.advance(f.mission.id, f.host, f.provider);
  assert.equal(waiting.progressed, false);
  assert.equal(waiting.mission.progress.counts.running, 2);
  assert.equal(waiting.mission.progress.tasks[2].status, 'waiting');
  assert.ok(waiting.mission.taskDetails[2].waitingFor.includes('dependency:edit-two'));
  const submits = f.calls.filter(c => c.type === 'submit').length;
  f.engine.control(f.mission.id, 'pause', current(f).revision);
  assert.equal((await workflow.run(f.mission.id, f.host, f.provider)).mission.state, 'paused');
  assert.equal(f.calls.filter(c => c.type === 'submit').length, submits);
  assert.ok(f.store.lock('one') && f.store.lock('two'));
  f.engine.control(f.mission.id, 'resume', current(f).revision);
  // A fresh orchestrator reads the reservations and command IDs from SQLite.
  const other = new Store(join(f.root, 'state.db')); cleanup(t, () => other.close());
  await new LiveWorkflow(other).advance(f.mission.id, f.host, f.provider);
  assert.equal(f.calls.filter(c => c.type === 'submit').length, submits);
  release();
  const result = await new LiveWorkflow(other).run(f.mission.id, f.host, f.provider);
  assert.equal(result.mission.state, 'succeeded');
  assert.equal(f.engine.describe(f.mission.id).progress.status, 'completed');
  assert.ok(f.engine.describe(f.mission.id).progress.tasks.every(t => t.phase === null));
  const starts = f.calls.filter(c => c.type === 'submit' && c.payload.mode === 'start');
  assert.deepEqual(starts.map(c => c.payload.links.taskId), ['edit-one', 'edit-two', 'integrate']);
  assert.equal(new Set(f.calls.filter(c => c.type === 'submit').map(c => c.commandId)).size, f.calls.filter(c => c.type === 'submit').length);
});

test('drive submits both independent projects before waiting or asking the judgment provider', async t => {
  const f = controlFixture(t), release = pendingHost(f);
  let waits = 0;
  f.host.sleep = async () => {
    waits++;
    assert.equal(current(f).attempts.filter(a => a.state === 'running').length, 2);
    assert.equal(f.provider.prompts.length, 0);
    release();
  };
  assert.equal((await new LiveWorkflow(f.store).run(f.mission.id, f.host, f.provider)).mission.state, 'succeeded');
  assert.equal(waits, 1);
});

test('pending observation timeout preserves unknown ownership and never resubmits the task', async t => {
  const f = controlFixture(t); pendingHost(f);
  const flow = new LiveWorkflow(f.store);
  await flow.advance(f.mission.id, f.host);
  const run = f.store.list('control-run')[0];
  f.store.transaction(() => f.store.put('control-run', { ...run, acceptedAt: '2000-01-01T00:00:00.000Z' }, run.revision));
  await flow.advance(f.mission.id, f.host);
  const a = current(f).attempts[0];
  assert.equal(a.state, 'unknown');
  assert.equal(a.turns.at(-1).error.code, 'control-follow-timeout');
  assert.equal(f.engine.describe(f.mission.id).progress.tasks[0].status, 'blocked');
  assert.equal(f.store.lock('one').attempt_id, a.id);
  await flow.advance(f.mission.id, f.host);
  assert.equal(f.calls.filter(c => c.type === 'submit' && c.project === 'one').length, 1);
  // Inconsistent ownership must return for review, not spin on an unobservable running task.
  const second = current(f).attempts.find(a => a.projectId === 'two');
  f.store.transaction(() => f.store.release('two', second.id));
  f.host.sleep = async () => assert.fail('No owned pending run remains to poll');
  const stopped = await flow.run(f.mission.id, f.host);
  assert.equal(stopped.progressed, false);
  assert.equal(stopped.mission.progress.tasks[1].reason, 'project-lock-missing');
});

test('approval pending, active delegation and human escalation are distinct in the CLI', async t => {
  const f = controlFixture(t), live = new LiveExecution(f.store);
  await live.dispatch(f.mission.id, 'edit-one', f.host, { expectedRevision: current(f).revision, expectedState: f.stateOf('one').stateVersion });
  const a = current(f).attempts[0];
  const status = () => f.engine.describe(f.mission.id).progress.tasks[0];
  assert.equal(status().status, 'approval-pending');
  let enter, release;
  const entered = new Promise(r => enter = r), gate = new Promise(r => release = r);
  const provider = { async generate() { enter(); await gate; return { data: { category: 'critical', verdict: 'defer', reason: '사용자 결정 필요', evidence: ['scope'] } }; } };
  const resolving = new DecisionDelegation(f.store).resolve(f.mission.id, a.id, f.host, provider);
  await entered;
  try {
    assert.equal(status().status, 'approval-processing');
    const cli = JSON.parse(execFileSync(process.execPath, [resolve('apps/cli/main.mjs'), 'mission', 'progress', f.mission.id, '--db', join(f.root, 'state.db')], { encoding: 'utf8' }));
    assert.equal(cli.tasks[0].status, 'approval-processing');
    assert.ok(cli.tasks[0].lastProgressAt);
  } finally { release(); }
  await resolving;
  assert.equal(status().status, 'human-input');
  assert.equal(status().escalations.length, 1);
  // Independent work stays runnable, while the first task requires a person.
  await new LiveWorkflow(f.store).advance(f.mission.id, f.host, f.provider);
  assert.equal(current(f).tasks[1].state, 'running');
  assert.equal(status().status, 'human-input');
});
