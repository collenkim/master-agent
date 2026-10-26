import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { Store } from '../packages/storage/store.mjs';
import { temporary, cleanup } from './helpers.mjs';

for (const graphs of [false, true]) test(`M4: v1 DB를 데이터 손실 없이 v2로 이행한다(graph tables=${graphs})`, t => {
  const path = join(temporary(t), 'v1.db'), old = new DatabaseSync(path);
  old.exec(`
    CREATE TABLE records(kind TEXT NOT NULL,id TEXT NOT NULL,revision INTEGER NOT NULL,body TEXT NOT NULL,PRIMARY KEY(kind,id));
    CREATE TABLE events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,mission_id TEXT NOT NULL,type TEXT NOT NULL,at TEXT NOT NULL,body TEXT NOT NULL);
    CREATE TABLE locks(project_id TEXT PRIMARY KEY,mission_id TEXT NOT NULL,attempt_id TEXT NOT NULL);
    CREATE TABLE requests(key TEXT PRIMARY KEY,hash TEXT NOT NULL,mission_id TEXT NOT NULL);
    CREATE TABLE paths(path TEXT PRIMARY KEY,project_id TEXT NOT NULL UNIQUE);
    INSERT INTO records VALUES('evidence','e1',7,'{"id":"e1","missionId":"m1","value":"보존"}');
    INSERT INTO events(mission_id,type,at,body) VALUES('m1','kept','2026-10-01','{}');
    INSERT INTO locks VALUES('p1','m1','a1');
    PRAGMA user_version=1;
  `);
  if (graphs) old.exec(`
    CREATE TABLE graph_leases(thread_id TEXT PRIMARY KEY,owner TEXT NOT NULL,pid INTEGER NOT NULL,host TEXT NOT NULL);
    CREATE TABLE graph_runs(id TEXT PRIMARY KEY,thread_id TEXT NOT NULL,graph TEXT NOT NULL,status TEXT NOT NULL,started_at TEXT NOT NULL,finished_at TEXT,error TEXT);
    INSERT INTO graph_runs VALUES('run','thread','simulation','running','2026-10-01T00:00:00.000Z',NULL,NULL);
    INSERT INTO graph_leases VALUES('thread','run',123,'old-host');
  `);
  old.close();
  const store = new Store(path); cleanup(t, () => store.close());
  assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 2);
  assert.deepEqual(store.need('evidence', 'e1'), { id: 'e1', missionId: 'm1', value: '보존', revision: 7 });
  assert.equal(store.events('m1').length, 1); assert.equal(store.lock('p1').attempt_id, 'a1');
  assert.equal(store.db.prepare('SELECT mission_id FROM records WHERE id=?').get('e1').mission_id, 'm1');
  if (graphs) assert.equal(store.db.prepare('SELECT heartbeat_at FROM graph_leases').get().heartbeat_at, '2026-10-01T00:00:00.000Z');
  const again = new Store(path); cleanup(t, () => again.close());
  assert.equal(again.need('evidence', 'e1').revision, 7);
});
