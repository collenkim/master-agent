import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setup, temporary } from './helpers.mjs';
import { Engine } from '../packages/orchestrator/engine.mjs';
import { dashboardSnapshot } from '../packages/dashboard/monitor.mjs';
import { startDashboard } from '../packages/dashboard/server.mjs';
import { snapshotTree, checkpointsCurrent } from '../packages/verification/tree.mjs';

test('M5: list는 목표 필터와 revision을 SQL 한 번으로 조회한다', t => {
  const { store } = setup(t, { plan: false });
  const a = store.put('decision', { id: 'a', missionId: 'one', value: 'first' });
  store.put('decision', { ...a, value: 'updated' }, a.revision);
  store.put('decision', { id: 'b', missionId: 'two', value: 'other' });
  const prepare = store.db.prepare.bind(store.db); let queries = 0;
  t.mock.method(store.db, 'prepare', (...args) => { queries++; return prepare(...args); });
  assert.deepEqual(store.list('decision', { missionId: 'one' }), [{ id: 'a', missionId: 'one', value: 'updated', revision: 2 }]);
  assert.equal(queries, 1); queries = 0;
  assert.equal(store.list('decision').length, 2); assert.equal(queries, 1);
  assert.ok(prepare('EXPLAIN QUERY PLAN SELECT body FROM records WHERE kind=? AND mission_id=?').all('decision', 'one').some(r => r.detail.includes('records_mission')));
  assert.ok(prepare('EXPLAIN QUERY PLAN SELECT * FROM events WHERE mission_id=? ORDER BY sequence').all('one').some(r => r.detail.includes('events_mission')));
});

test('M5: 완료 목표 describe는 revision이 바뀔 때만 다시 계산한다', t => {
  const f = setup(t, { plan: false });
  const m = f.engine.control(f.mission.id, 'cancel', f.mission.revision);
  const describe = Engine.prototype.describe; let calls = 0;
  t.mock.method(Engine.prototype, 'describe', function (...args) { calls++; return describe.apply(this, args); });
  dashboardSnapshot(f.store, { trustKey: () => null });
  dashboardSnapshot(f.store, { trustKey: () => null });
  assert.equal(calls, 1);
  f.engine.save({ ...m, reason: '종료 기록 갱신' }, 'fixture-update');
  assert.equal(dashboardSnapshot(f.store, { trustKey: () => null }).missions[0].reason, '종료 기록 갱신');
  assert.equal(calls, 2);
});

test('M5: clean HEAD는 파일 해시를 재사용하고 dirty·HEAD·revision 변경은 재검사한다', t => {
  const root = temporary(t), source = join(root, 'source.txt');
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe', shell: false, windowsHide: true });
  git('init', '-q'); git('config', 'user.email', 'fixture@example.test'); git('config', 'user.name', 'Fixture'); git('config', 'core.autocrlf', 'false');
  fs.writeFileSync(source, 'first\n'); git('add', 'source.txt'); git('commit', '-qm', 'fixture');
  const checkpoint = snapshotTree(root), mission = { id: randomUUID(), revision: 1, liveCheckpoints: { project: checkpoint } };
  const readFileSync = fs.readFileSync; let reads = 0;
  t.mock.method(fs, 'readFileSync', function (path, ...args) { if (path === source) reads++; return readFileSync(path, ...args); });
  syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  assert.equal(checkpointsCurrent(mission), true); assert.ok(reads > 0); reads = 0;
  assert.equal(checkpointsCurrent(mission), true); assert.equal(reads, 0);
  fs.writeFileSync(source, 'changed\n');
  assert.equal(checkpointsCurrent(mission), false); assert.ok(reads > 0); reads = 0;
  fs.writeFileSync(source, 'first\n');
  assert.equal(checkpointsCurrent(mission), true); assert.equal(reads, 0);
  mission.revision++;
  assert.equal(checkpointsCurrent(mission), true); assert.ok(reads > 0); reads = 0;
  fs.writeFileSync(source, 'committed change\n'); git('add', 'source.txt'); git('commit', '-qm', 'changed');
  assert.equal(checkpointsCurrent(mission), false); assert.ok(reads > 0);
});

test('M5: 목표 200개·이벤트 2만 건의 첫 overview는 2초 안에 응답한다', async t => {
  const f = setup(t, { plan: false }), base = f.store.need('mission', f.mission.id);
  f.store.transaction(() => {
    f.store.db.prepare('DELETE FROM events').run();
    for (let i = 0; i < 200; i++) {
      const id = i ? `scale-${i}` : base.id;
      f.store.put('mission', { ...base, id, state: 'cancelled', finishedAt: new Date().toISOString() }, i ? 0 : base.revision);
      for (let j = 0; j < 100; j++) f.store.event(id, 'scale-event', { index: j });
    }
  });
  const dashboard = await startDashboard({ dbPath: f.db, port: 0, observe: false });
  try {
    const start = performance.now();
    const response = await fetch(`${dashboard.url}/api/overview`), data = await response.json();
    const elapsed = performance.now() - start;
    t.diagnostic(`첫 overview 응답 ${elapsed.toFixed(1)}ms`);
    assert.equal(response.status, 200); assert.equal(data.missions.length, 200);
    assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM events').get().n, 20000);
    assert.ok(elapsed < 2000, `overview ${elapsed.toFixed(1)}ms`);
    assert.ok(data.missions.every(m => m.events.length === 12));
  } finally { await dashboard.close(); }
});
