import { AsyncLocalStorageProviderSingleton } from '@langchain/core/singletons';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import { Command } from '@langchain/langgraph';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { requireThat } from '../domain/contracts.mjs';
import { Engine } from './engine.mjs';
import { leaseActive, localProcessAlive, HEARTBEAT_MS } from './lease.mjs';

// Use the official saver with Node's SQLite driver. No native install scripts are needed.
export function checkpointer(store) {
  if (store.graphCheckpointer) return store.graphCheckpointer;
  const adapter = {
    pragma(sql) { return store.db.exec(`PRAGMA ${sql}`); },
    exec(sql) { return store.db.exec(sql); },
    prepare(sql) {
      const statement = store.db.prepare(sql);
      return Object.fromEntries(['run', 'get', 'all'].map(method => [method, (...args) => statement[method](...args.map(v => v === undefined ? null : v))]));
    },
    transaction(fn) { return (...args) => store.transaction(() => fn(...args)); },
  };
  store.graphCheckpointer = new SqliteSaver(adapter);
  return store.graphCheckpointer;
}

function interruptLease(store, lease, missionId, reason) {
  store.db.prepare('UPDATE graph_runs SET status=?,finished_at=? WHERE id=? AND status=?')
    .run('interrupted', new Date().toISOString(), lease.owner, 'running');
  store.db.prepare('DELETE FROM graph_leases WHERE thread_id=? AND owner=?').run(lease.thread_id, lease.owner);
  store.event(missionId ?? lease.thread_id, 'graph-lease-reclaimed', { threadId: lease.thread_id, owner: lease.owner, reason });
}

export function unlockMission(store, id, expectedRevision, { confirm = false } = {}) {
  requireThat(confirm === true, 'invalid-input', '--confirm이 필요합니다.');
  const engine = new Engine(store);
  return store.transaction(() => {
    const mission = engine.checked(id, expectedRevision);
    const leases = store.db.prepare('SELECT * FROM graph_leases WHERE thread_id IN (?,?)')
      .all(`master:v1:mission:${id}`, `master:v1:simulation:${id}`);
    requireThat(leases.length, 'invalid-state', '회수할 목표 그래프 임대가 없습니다.');
    requireThat(!leases.some(l => localProcessAlive(l.pid, l.host)), 'graph-busy', '같은 호스트에서 살아 있는 프로세스의 임대는 회수할 수 없습니다.');
    const d = engine.decision(mission, 'unlock-graph', { actor: 'operator', reason: '운영자가 중단된 목표 그래프의 임대를 회수했습니다.',
      evidence: leases.map(l => l.owner), alternatives: ['TTL 만료 대기', '임대 강제 회수'], nextAction: 'review-mission',
      verification: '목표 버전·명시적 확인·같은 호스트의 프로세스 생존 대조' });
    for (const lease of leases) interruptLease(store, lease, id, 'operator-reset');
    return engine.save(mission, 'graph-unlocked', { decisionId: d.id });
  });
}

// A domain record is authoritative for external effects. After an unclean exit we
// re-observe it from START; we never replay an unfinished dispatch/commit node.
// Only a side-effect-free wait node is resumed with Command.
export async function invokeGraph(store, graph, name, id, input, { resumeWait = false } = {}) {
  const thread = `master:v1:${name}:${id}`, owner = randomUUID();
  const config = { configurable: { thread_id: thread, checkpoint_ns: '' }, recursionLimit: 100000, durability: 'sync' };
  store.transaction(() => {
    const lease = store.db.prepare('SELECT * FROM graph_leases WHERE thread_id=?').get(thread);
    requireThat(!lease || !leaseActive({ ...lease, heartbeatAt: lease.heartbeat_at, startedAt: lease.started_at }), 'graph-busy', '그래프 임대가 유효합니다. TTL 만료를 기다리거나 mission unlock으로 점검하세요.');
    if (lease) interruptLease(store, lease, store.get('mission', id)?.id, 'expired');
    const at = new Date().toISOString();
    store.db.prepare('INSERT INTO graph_leases(thread_id,owner,pid,host,started_at,heartbeat_at) VALUES (?,?,?,?,?,?)').run(thread, owner, process.pid, hostname(), at, at);
    store.db.prepare('INSERT INTO graph_runs(id,thread_id,graph,status,started_at) VALUES (?,?,?,?,?)').run(owner, thread, name, 'running', new Date().toISOString());
  });
  let heartbeatError;
  const heartbeat = () => {
    if (heartbeatError) throw heartbeatError;
    requireThat(store.db.prepare('UPDATE graph_leases SET heartbeat_at=? WHERE thread_id=? AND owner=?')
      .run(new Date().toISOString(), thread, owner).changes === 1, 'graph-busy', '그래프 임대 소유자가 변경됐습니다.');
  };
  const timer = setInterval(() => { try { heartbeat(); } catch (error) { heartbeatError = error; } }, HEARTBEAT_MS);
  timer.unref();
  config.callbacks = [{ handleChainEnd: heartbeat }];
  try {
    // These are separately persisted graphs, not implicit Pregel child tasks.
    // Do not inherit a caller's task ID, checkpoint namespace or interrupt channel.
    return await AsyncLocalStorageProviderSingleton.runWithConfig({}, async () => {
      const prior = resumeWait ? await graph.getState(config) : undefined;
      const waiting = prior?.tasks?.some(task => task.interrupts?.length) && prior.next?.length === 1 && prior.next[0] === 'wait';
      // Resume is a wake-up signal, never an approval or a grant.
      const output = await graph.invoke(waiting ? new Command({ resume: { recheck: true } }) : input, config);
      heartbeat();
      const state = await graph.getState(config);
      const status = state.tasks?.some(task => task.interrupts?.length) ? 'waiting' : 'completed';
      store.db.prepare('UPDATE graph_runs SET status=?,finished_at=? WHERE id=?').run(status, new Date().toISOString(), owner);
      return output;
    }, true);
  } catch (error) {
    store.db.prepare('UPDATE graph_runs SET status=?,finished_at=?,error=? WHERE id=? AND status=?').run('failed', new Date().toISOString(), error.code ?? 'graph-error', owner, 'running');
    throw error;
  } finally {
    clearInterval(timer);
    store.db.prepare('DELETE FROM graph_leases WHERE thread_id=? AND owner=?').run(thread, owner);
  }
}

export async function graphStatus(store, name, id) {
  const thread = `master:v1:${name}:${id}`;
  const tuple = await checkpointer(store).getTuple({ configurable: { thread_id: thread } });
  return {
    threadId: thread, checkpointId: tuple?.checkpoint.id ?? null,
    lastRun: store.db.prepare('SELECT * FROM graph_runs WHERE thread_id=? ORDER BY rowid DESC LIMIT 1').get(thread) ?? null,
  };
}
