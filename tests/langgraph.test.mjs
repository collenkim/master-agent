import { planningSetup, answerFor, blockedAnswer } from './planning-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { hostname } from 'node:os';
import { setup, cleanup } from './helpers.mjs';
import { Store } from '../packages/storage/store.mjs';
import { Engine } from '../packages/orchestrator/engine.mjs';
import { SimulationRunner } from '../packages/runner/simulation.mjs';
import { checkpointer, graphStatus, unlockMission } from '../packages/orchestrator/graph-runtime.mjs';
import { LEASE_TTL_MS } from '../packages/orchestrator/lease.mjs';
import { LiveWorkflow } from '../packages/orchestrator/drive.mjs';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';

const exec = promisify(execFile);
const moduleUrl = name => pathToFileURL(resolve(name)).href;

test('B3: 공식 체크포인터는 import되지만 네이티브 생성 경로는 거부한다', () => {
  assert.equal(typeof SqliteSaver, 'function');
  assert.throws(() => SqliteSaver.fromConnString(':memory:'), /node:sqlite 어댑터만 사용/);
});

test('M2: 취소한 thread는 재열기 뒤에도 checkpoint와 지연 writes를 남기지 않는다', async t => {
  const f = setup(t);
  f.engine.control(f.mission.id, 'pause', f.mission.revision);
  await f.engine.run(f.mission.id, new SimulationRunner());
  const config = { configurable: { thread_id: `master:v1:simulation:${f.mission.id}` } };
  const tuple = await checkpointer(f.store).getTuple(config);
  f.close();
  const store = new Store(f.db); cleanup(t, () => store.close());
  const m = new Engine(store).control(f.mission.id, 'cancel', store.need('mission', f.mission.id).revision);
  assert.deepEqual(m.lastCheckpoint, { id: tuple.checkpoint.id, at: tuple.checkpoint.ts });
  const saver = checkpointer(store);
  await saver.put(tuple.config, tuple.checkpoint, tuple.metadata);
  await saver.putWrites(tuple.config, [['late', 'value']], 'late-task');
  assert.equal(await saver.getTuple(config), undefined);
  for (const table of ['checkpoints', 'writes']) assert.equal(store.db.prepare(`SELECT count(*) AS n FROM ${table} WHERE thread_id=?`).get(config.configurable.thread_id).n, 0);
});

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
  assert.equal(checkpoints.length, 0);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM writes WHERE thread_id=?').get(before.threadId).n, 0);
  assert.ok(result.lastCheckpoint.id); assert.ok(Date.parse(result.lastCheckpoint.at));
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
  await assert.rejects(new Engine(store).run(id, new SimulationRunner()), { code: 'graph-busy' });
  unlockMission(store, id, store.need('mission', id).revision, { confirm: true });
  let calls = [];
  await new Engine(store).run(id, { mode: 'simulation', execute(ticket) { calls.push(ticket.taskId); return new SimulationRunner().execute(ticket); } });
  assert.ok(!calls.includes(old.taskId));
  assert.equal(store.need('mission', id).attempts.filter(a => a.taskId === old.taskId).length, 1);
  assert.equal(store.lock(old.projectId).attempt_id, old.id);
});

function foreignLease(f, { host = 'different-host', pid = 999999999, at = new Date(Date.now() - LEASE_TTL_MS - 1000).toISOString() } = {}) {
  const thread = `master:v1:simulation:${f.mission.id}`;
  f.store.db.prepare('INSERT INTO graph_runs(id,thread_id,graph,status,started_at) VALUES(?,?,?,?,?)').run('old-run', thread, 'simulation', 'running', at);
  f.store.db.prepare('INSERT INTO graph_leases(thread_id,owner,pid,host,started_at,heartbeat_at) VALUES(?,?,?,?,?,?)').run(thread, 'old-run', pid, host, at, at);
  return thread;
}

test('M1: 다른 호스트의 만료 임대는 회수하고 이전 실행을 interrupted로 기록한다', async t => {
  const f = setup(t); foreignLease(f);
  const result = await f.engine.run(f.mission.id, new SimulationRunner());
  assert.equal(result.state, 'simulation-complete');
  assert.equal(f.store.db.prepare('SELECT status FROM graph_runs WHERE id=?').get('old-run').status, 'interrupted');
  assert.ok(f.store.events(f.mission.id).some(e => e.type === 'graph-lease-reclaimed' && e.reason === 'expired'));
});

test('M1: 다른 호스트의 최근 heartbeat는 busy이며 명시적 unlock은 revision과 confirm을 요구한다', async t => {
  const f = setup(t); foreignLease(f, { at: new Date().toISOString() });
  await assert.rejects(f.engine.run(f.mission.id, new SimulationRunner()), { code: 'graph-busy' });
  assert.throws(() => unlockMission(f.store, f.mission.id, f.mission.revision), { code: 'invalid-input' });
  assert.throws(() => unlockMission(f.store, f.mission.id, f.mission.revision - 1, { confirm: true }), { code: 'stale-state' });
  unlockMission(f.store, f.mission.id, f.mission.revision, { confirm: true });
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM graph_leases').get().n, 0);
  assert.ok(f.store.list('decision').some(d => d.action === 'unlock-graph'));
});

test('M1: 같은 호스트의 살아 있는 pid 임대는 TTL이 지나도 실행과 unlock을 거부한다', async t => {
  const f = setup(t); foreignLease(f, { host: hostname(), pid: process.pid });
  await assert.rejects(f.engine.run(f.mission.id, new SimulationRunner()), { code: 'graph-busy' });
  assert.throws(() => unlockMission(f.store, f.mission.id, f.mission.revision, { confirm: true }), { code: 'graph-busy' });
  assert.equal(f.store.db.prepare('SELECT status FROM graph_runs WHERE id=?').get('old-run').status, 'running');
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
  const result = await new LiveWorkflow(f.store).run(mission.id, { execute() { starts++; } }, provider);
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
