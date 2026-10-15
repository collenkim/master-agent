import { AsyncLocalStorageProviderSingleton } from '@langchain/core/singletons';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import { Command } from '@langchain/langgraph';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { requireThat } from '../domain/contracts.mjs';

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

function setup(store) {
  store.db.exec(`CREATE TABLE IF NOT EXISTS graph_leases (
    thread_id TEXT PRIMARY KEY, owner TEXT NOT NULL, pid INTEGER NOT NULL, host TEXT NOT NULL
  ); CREATE TABLE IF NOT EXISTS graph_runs (
    id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, graph TEXT NOT NULL, status TEXT NOT NULL,
    started_at TEXT NOT NULL, finished_at TEXT, error TEXT
  );`);
}
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}

// A domain record is authoritative for external effects. After an unclean exit we
// re-observe it from START; we never replay an unfinished dispatch/commit node.
// Only a side-effect-free wait node is resumed with Command.
export async function invokeGraph(store, graph, name, id, input, { resumeWait = false } = {}) {
  setup(store);
  const thread = `master:v1:${name}:${id}`, owner = randomUUID();
  const config = { configurable: { thread_id: thread, checkpoint_ns: '' }, recursionLimit: 100000, durability: 'sync' };
  store.transaction(() => {
    const lease = store.db.prepare('SELECT * FROM graph_leases WHERE thread_id=?').get(thread);
    requireThat(!lease || lease.host === hostname() && !alive(lease.pid), 'graph-busy', 'This graph is already running.');
    if (lease) store.db.prepare('UPDATE graph_runs SET status=?,finished_at=? WHERE id=?').run('interrupted', new Date().toISOString(), lease.owner);
    store.db.prepare('INSERT OR REPLACE INTO graph_leases VALUES (?,?,?,?)').run(thread, owner, process.pid, hostname());
    store.db.prepare('INSERT INTO graph_runs(id,thread_id,graph,status,started_at) VALUES (?,?,?,?,?)').run(owner, thread, name, 'running', new Date().toISOString());
  });
  try {
    // These are separately persisted graphs, not implicit Pregel child tasks.
    // Do not inherit a caller's task ID, checkpoint namespace or interrupt channel.
    return await AsyncLocalStorageProviderSingleton.runWithConfig({}, async () => {
      const prior = resumeWait ? await graph.getState(config) : undefined;
      const waiting = prior?.tasks?.some(task => task.interrupts?.length) && prior.next?.length === 1 && prior.next[0] === 'wait';
      // Resume is a wake-up signal, never an approval or a grant.
      const output = await graph.invoke(waiting ? new Command({ resume: { recheck: true } }) : input, config);
      const state = await graph.getState(config);
      const status = state.tasks?.some(task => task.interrupts?.length) ? 'waiting' : 'completed';
      store.db.prepare('UPDATE graph_runs SET status=?,finished_at=? WHERE id=?').run(status, new Date().toISOString(), owner);
      return output;
    }, true);
  } catch (error) {
    store.db.prepare('UPDATE graph_runs SET status=?,finished_at=?,error=? WHERE id=?').run('failed', new Date().toISOString(), error.code ?? error.message, owner);
    throw error;
  } finally {
    store.db.prepare('DELETE FROM graph_leases WHERE thread_id=? AND owner=?').run(thread, owner);
  }
}

export async function graphStatus(store, name, id) {
  setup(store);
  const thread = `master:v1:${name}:${id}`;
  const tuple = await checkpointer(store).getTuple({ configurable: { thread_id: thread } });
  return {
    threadId: thread, checkpointId: tuple?.checkpoint.id ?? null,
    lastRun: store.db.prepare('SELECT * FROM graph_runs WHERE thread_id=? ORDER BY rowid DESC LIMIT 1').get(thread) ?? null,
  };
}
