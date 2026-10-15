import { planningSetup, answerFor, blockedAnswer } from './planning-fixture.mjs';
import { runCommand } from '../packages/orchestrator/operation-graph.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setup, cleanup } from './helpers.mjs';
import { Store } from '../packages/storage/store.mjs';
import { Engine } from '../packages/orchestrator/engine.mjs';
import { SimulationRunner } from '../packages/runner/simulation.mjs';
import { checkpointer, graphStatus } from '../packages/orchestrator/graph-runtime.mjs';
import { LiveWorkflow } from '../packages/orchestrator/drive.mjs';

const exec = promisify(execFile);
const moduleUrl = name => pathToFileURL(resolve(name)).href;

test('LangGraph wait survives reopening SQLite and waking it does not bypass mission pause', async t => {
  const f = setup(t);
  f.engine.control(f.mission.id, 'pause', f.mission.revision);
  const first = await f.engine.run(f.mission.id, new SimulationRunner());
  assert.equal(first.state, 'paused');
  const before = await graphStatus(f.store, 'simulation', f.mission.id);
  assert.equal(before.lastRun.status, 'waiting');
  assert.ok(before.checkpointId);
  f.close();
  const store = new Store(f.db); cleanup(t, () => store.close());
  const engine = new Engine(store);
  assert.equal((await engine.run(f.mission.id, new SimulationRunner())).state, 'paused');
  assert.equal(store.need('mission', f.mission.id).attempts.length, 0);
  engine.control(f.mission.id, 'resume', store.need('mission', f.mission.id).revision);
  const result = await engine.run(f.mission.id, new SimulationRunner());
  assert.equal(result.state, 'simulation-complete');
  assert.equal(result.attempts.length, 4);
  assert.equal((await graphStatus(store, 'simulation', f.mission.id)).lastRun.status, 'completed');
  const checkpoints = [];
  for await (const tuple of checkpointer(store).list({ configurable: { thread_id: before.threadId } })) checkpoints.push(tuple);
  assert.ok(checkpoints.length > 10);
  assert.ok(checkpoints.some(t => t.checkpoint.channel_values.route === 'execute'));
  assert.ok(checkpoints.some(t => t.checkpoint.channel_values.route === 'accept'));
});

test('same graph thread cannot be driven concurrently from two Store connections', async t => {
  const f = setup(t), other = new Store(f.db); cleanup(t, () => other.close());
  let entered, release;
  const ready = new Promise(r => entered = r), gate = new Promise(r => release = r);
  const runner = { mode: 'simulation', async execute(ticket) { entered(); await gate; return new SimulationRunner().execute(ticket); } };
  const running = f.engine.step(f.mission.id, runner);
  await ready;
  try { await assert.rejects(new Engine(other).step(f.mission.id, new SimulationRunner()), { code: 'graph-busy' }); }
  finally { release(); }
  await running;
  assert.equal(f.store.need('mission', f.mission.id).attempts.length, 1);
});

test('process death after execution reservation never replays the unfinished external action', async t => {
  const f = setup(t), id = f.mission.id;
  f.close();
  const script = `import { Store } from ${JSON.stringify(moduleUrl('packages/storage/store.mjs'))};
import { Engine } from ${JSON.stringify(moduleUrl('packages/orchestrator/engine.mjs'))};
const store = new Store(${JSON.stringify(f.db)});
await new Engine(store).step(${JSON.stringify(id)}, { mode: 'simulation', execute() { process.exit(17); } });`;
  await assert.rejects(exec(process.execPath, ['--input-type=module', '-e', script]), e => e.code === 17);
  const store = new Store(f.db); cleanup(t, () => store.close());
  const old = store.need('mission', id).attempts[0];
  let calls = [];
  await new Engine(store).run(id, { mode: 'simulation', execute(ticket) { calls.push(ticket.taskId); return new SimulationRunner().execute(ticket); } });
  assert.ok(!calls.includes(old.taskId));
  assert.equal(store.need('mission', id).attempts.filter(a => a.taskId === old.taskId).length, 1);
  assert.equal(store.lock(old.projectId).attempt_id, old.id);
});

test('checkpoint failure after an effect does not allow replay on the next graph invocation', async t => {
  const f = setup(t), saver = checkpointer(f.store), put = saver.put.bind(saver);
  let calls = 0;
  saver.put = async (config, checkpoint, ...rest) => {
    if (checkpoint.channel_values.outcome) throw new Error('checkpoint-disk-full');
    return put(config, checkpoint, ...rest);
  };
  const runner = { mode: 'simulation', execute(ticket) { calls++; return new SimulationRunner().execute(ticket); } };
  await assert.rejects(f.engine.step(f.mission.id, runner), /checkpoint-disk-full/);
  saver.put = put;
  const first = f.store.need('mission', f.mission.id).attempts[0];
  await f.engine.run(f.mission.id, runner);
  assert.equal(f.store.need('mission', f.mission.id).attempts.filter(a => a.taskId === first.taskId).length, 1);
  assert.ok(calls <= 4);
});

test('live graph exposes independent dispatch, observation, verification, recovery and wait nodes', t => {
  const f = setup(t);
  const graph = new LiveWorkflow(f.store).graph({}, undefined, true).getGraph();
  for (const name of ['select', 'observe', 'dispatch', 'continue', 'delegate', 'verify', 'handoff', 'recover', 'replan', 'wait']) assert.ok(graph.nodes[name], name);
});

test('received live mission is planned by the graph and missing verification never starts a host', async t => {
  const f = planningSetup(t);
  const mission = f.engine.create({ ...f.fixture.mission, mode: 'live', requestKey: 'live-graph-plan' });
  let calls = 0, starts = 0;
  const provider = { name: 'fixture', async generate({ context }) { calls++; return { data: answerFor(context) }; } };
  const result = await runCommand(f.store, mission.id, 'drive', () => new LiveWorkflow(f.store).run(mission.id, { execute() { starts++; } }, provider));
  assert.equal(calls, 1); assert.equal(starts, 0);
  assert.equal(result.mission.plans.length, 1);
  assert.ok(result.blockers.some(b => b.endsWith('missing-verification-recipe')));
  assert.equal((await graphStatus(f.store, 'mission', mission.id)).lastRun.status, 'waiting');
  const analysisId = f.store.need('mission', mission.id).analysisRunId;
  assert.ok((await graphStatus(f.store, 'analysis', analysisId)).checkpointId);
});

test('waking a human planning hold does not regenerate, authorize or dispatch it', async t => {
  const f = planningSetup(t);
  const mission = f.engine.create({ ...f.fixture.mission, mode: 'live', requestKey: 'live-graph-hold' });
  let calls = 0;
  const provider = { name: 'fixture', async generate({ context }) { calls++; return { data: blockedAnswer(context, true) }; } };
  const flow = new LiveWorkflow(f.store);
  assert.equal((await flow.run(mission.id, {}, provider)).mission.state, 'waiting-decision');
  assert.equal(calls, 2);
  const again = await flow.run(mission.id, {}, provider);
  assert.equal(again.progressed, false); assert.equal(calls, 2);
  assert.equal(again.mission.attempts.length, 0);
});
