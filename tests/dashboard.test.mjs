import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { get } from 'node:http';
import { join } from 'node:path';
import { Store } from '../packages/storage/store.mjs';
import { setup } from './helpers.mjs';
import { dashboardSnapshot, createMonitor } from '../packages/dashboard/monitor.mjs';
import { startDashboard } from '../packages/dashboard/server.mjs';


test('B2: cross-site 요청은 같은 Host에서도 거부한다', async t => {
  const { db, store } = setup(t), dashboard = await startDashboard({ dbPath: db, port: 0, observe: false });
  try {
    const before = store.list('mission').map(m => [m.id, m.revision]);
    const response = await fetch(dashboard.url + '/api/overview', { headers: { 'Sec-Fetch-Site': 'cross-site' } });
    assert.equal(response.status, 403);
    assert.deepEqual(store.list('mission').map(m => [m.id, m.revision]), before);
  } finally { await dashboard.close(); }
});

function state(project, extra = {}) {
  return { schema: 'code-agent.state', schemaVersion: 1, observedAt: new Date().toISOString(), stateVersion: 'v1',
    repo: { root: project.path }, work: { id: 'CA-1', phase: 'implement' }, resume: { code: 'needs-human', reasons: [{ code: 'questions-open', detail: '질문 Q1' }] },
    ownership: { process: 'unverified', lease: { state: 'held' } }, unknown: ['생존 미확인'],
    consents: { open: [{ id: 'C1', action: 'deliver' }] }, questions: { unanswered: ['Q1'], unverified: ['Q2'] }, ...extra };
}

test('dashboard includes all registered projects, preserves question IDs and never exposes control secrets', t => {
  const { store, fixture, mission } = setup(t);
  const p = fixture.projects[0];
  store.put('observation', { id: p.id, status: 'observed', recordedAt: new Date().toISOString(), state: state(p) });
  store.put('control-binding', { id: p.id, controller: 'master', owner: true, tokenFile: 'SECRET-TOKEN-PATH', policy: { secret: 'SECRET-POLICY' } });
  const result = dashboardSnapshot(store);
  assert.equal(result.projects.length, 3);
  const project = result.projects.find(x => x.id === p.id);
  assert.equal(project.observation.stale, false);
  assert.equal(project.process, 'unverified');
  assert.deepEqual(project.questions, [{ id: 'Q1', status: 'unanswered' }, { id: 'Q2', status: 'unverified' }]);
  assert.deepEqual(project.resume.reasons, ['질문 Q1']);
  assert.equal(project.attention, true);
  assert.equal(result.missions[0].id, mission.id);
  assert.equal(result.missions[0].tasks.length, 4);
  assert.equal(JSON.stringify(result).includes('SECRET'), false);
  assert.equal(result.counts.unavailable, 2);
});

test('failed observations retain historical work without presenting it as a fresh success', t => {
  const { store, fixture } = setup(t);
  const p = fixture.projects[0];
  store.put('observation', { id: p.id, status: 'timeout', recordedAt: new Date().toISOString(),
    lastSuccessfulState: state(p, { observedAt: '2020-01-01T00:00:00Z' }) });
  const project = dashboardSnapshot(store).projects.find(x => x.id === p.id);
  assert.equal(project.work.id, 'CA-1');
  assert.equal(project.observation.historical, true);
  assert.equal(project.observation.stale, true);
  assert.equal(project.observation.status, 'timeout');
});

test('accepted requests remain visible before code-agent creates its work', t => {
  const { store, fixture, mission } = setup(t), p = fixture.projects[0];
  store.put('observation', { id: p.id, status: 'observed', recordedAt: new Date().toISOString(), state: state(p, { work: null, resume: { code: 'no-work', reasons: [] }, consents: { open: [{ id: 'baseline', action: 'baseline' }] } }) });
  store.put('target-request', { id: mission.id, projectIds: [p.id], taskNumber: 'YSIJ-263', state: 'waiting', createdAt: new Date().toISOString() });
  let project = dashboardSnapshot(store).projects.find(x => x.id === p.id);
  assert.equal(project.work, null); assert.equal(project.resume.code, 'no-work');
  assert.deepEqual(project.activity.ids, ['YSIJ-263']);
  assert.equal(project.activity.detail, '프로젝트 준비 승인 대기 · code-agent 작업 생성 전');
  const request = store.need('target-request', mission.id);
  store.put('target-request', { ...request, state: 'completed' }, request.revision);
  project = dashboardSnapshot(store).projects.find(x => x.id === p.id);
  assert.equal(project.activity, null);
});

test('monitor calls only status --json, survives malformed project output, and polls projects without missions', async t => {
  const { store, fixture, root, engine } = setup(t);
  const independent = { ...fixture.projects[0], id: 'independent', path: join(root, 'independent') };
  mkdirSync(independent.path); engine.catalog.register(independent);
  for (const p of [...fixture.projects, independent]) {
    mkdirSync(join(p.path, '.code-agent')); writeFileSync(join(p.path, '.code-agent/version'), 'fixture');
  }
  const cliPath = join(root, 'status.mjs');
  writeFileSync(cliPath, `import assert from 'node:assert/strict';
    assert.deepEqual(process.argv.slice(2), ['status', '--json']);
    if (process.cwd().endsWith('payment')) console.log('broken');
    else console.log(JSON.stringify({ ...${JSON.stringify(state(independent))}, repo: { root: process.cwd() } }));`);
  const monitor = createMonitor(store, { cliPath });
  await monitor.refresh();
  const snapshot = monitor.snapshot();
  assert.equal(snapshot.projects.find(p => p.id === 'independent').work.id, 'CA-1');
  assert.equal(snapshot.projects.find(p => p.id.endsWith('payment')).observation.status, 'invalid-json');
  assert.equal(snapshot.projects.filter(p => p.observation.status === 'observed').length, 3);
  await monitor.stop();
});

test('overlapping refreshes share one bounded sweep; a failing project does not hide the others', async t => {
  const { store, fixture, engine, root } = setup(t);
  for (const id of ['extra-1', 'extra-2']) {
    const path = join(root, id); mkdirSync(path);
    engine.catalog.register({ ...fixture.projects[0], id, path });
  }
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let calls = 0;
  const monitor = createMonitor(store, { cliPath: 'fixture', observe: async (_, id) => {
    calls++; await gate;
    if (id === fixture.projects[0].id) throw new Error('project unavailable');
  } });
  const first = monitor.refresh();
  assert.equal(monitor.refresh(), first);
  assert.equal(calls, 4);
  assert.equal(monitor.snapshot().refreshing, true);
  release(); await first;
  assert.equal(monitor.snapshot().projects.find(p => p.id === fixture.projects[0].id).observation.error, 'project unavailable');
  await monitor.stop(); await monitor.refresh(); assert.equal(calls, 5);
});

test('monitor drops deleted projects from an existing queue and later sweeps', async t => {
  const { store, fixture, engine, root } = setup(t);
  for (const id of ['zz-extra-1', 'zz-extra-2']) {
    const path = join(root, id); mkdirSync(path);
    engine.catalog.register({ ...fixture.projects[0], id, path });
  }
  let release;
  const gate = new Promise(resolve => { release = resolve; }), calls = [];
  const monitor = createMonitor(store, { cliPath: 'fixture', observe: async (_, id) => { calls.push(id); await gate; } });
  const pending = monitor.refresh();
  assert.equal(calls.length, 4);
  for (const id of ['zz-extra-1', 'zz-extra-2']) engine.catalog.remove(id, store.need('project', id).revision);
  release(); await pending;
  assert.equal(calls.includes('zz-extra-2'), false);
  assert.equal(monitor.snapshot().projects.length, 3);
  calls.length = 0; await monitor.refresh();
  assert.deepEqual(calls, fixture.projects.map(p => p.id).sort());
  await monitor.stop();
});

test('HTTP serves local UI and saved DB, rejects writes, foreign origins and host rebinding', async t => {
  const { db, store } = setup(t);
  const before = store.list('mission');
  const dashboard = await startDashboard({ dbPath: db, port: 0, observe: false });
  try {
    const page = await fetch(dashboard.url);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /프로젝트 전체 현황/);
    assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    for (const asset of ['/app.mjs', '/style.css']) assert.equal((await fetch(dashboard.url + asset)).status, 200);
    const data = await (await fetch(dashboard.url + '/api/overview')).json();
    assert.equal(data.projects.length, 3); assert.equal(data.live, false);
    assert.equal((await fetch(dashboard.url + '/api/overview', { method: 'POST' })).status, 403);
    assert.equal((await fetch(dashboard.url + '/api/overview', { headers: { Origin: 'https://other.example' } })).status, 403);
    const foreignHost = await new Promise((resolve, reject) => {
      get(dashboard.url + '/api/overview', { headers: { Host: 'other.example' } }, response => { response.resume(); resolve(response.statusCode); }).on('error', reject);
    });
    assert.equal(foreignHost, 403);
    const localAlias = await new Promise((resolve, reject) => {
      get(dashboard.url + '/api/overview', { headers: { Host: 'localhost:' + new URL(dashboard.url).port } }, response => {
        let body = ''; response.setEncoding('utf8'); response.on('data', data => { body += data; });
        response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(body) }));
      }).on('error', reject);
    });
    assert.equal(localAlias.status, 403); assert.ok(localAlias.body.message.includes(dashboard.url));
    assert.equal((await fetch(dashboard.url + '/package.json')).status, 404);
    assert.deepEqual(store.list('mission'), before);
  } finally { await dashboard.close(); }
});

test('dashboard rejects invalid port, polling interval and shell-wrapper CLI before creating a DB', async t => {
  const { root } = setup(t);
  for (const options of [{ port: -1 }, { intervalMs: 0 }, { cliPath: 'code-agent.cmd' }]) {
    await assert.rejects(startDashboard({ dbPath: join(root, 'unused.db'), ...options }), error => ['usage', 'invalid-cli'].includes(error.code));
    assert.equal(existsSync(join(root, 'unused.db')), false);
  }
});


test('M6: 저장 관측 모드는 다른 연결의 DB 변경을 수집하고 동일한 상태를 반복 동기화하지 않는다', async t => {
  const { store, db, fixture } = setup(t), writer = new Store(db);
  let observed = 0;
  const monitor = createMonitor(store, { onObserved: () => { observed++; }, observe: () => { throw new Error('CLI를 호출하지 않는다'); } });
  try {
    await monitor.refresh();
    assert.equal(observed, fixture.projects.length);
    await monitor.refresh();
    assert.equal(observed, fixture.projects.length);
    const mission = writer.list('mission')[0];
    writer.put('mission', { ...mission, reason: '다른 실행기의 변경' }, mission.revision);
    await monitor.refresh();
    assert.equal(observed, fixture.projects.length * 2);
    await monitor.refresh();
    assert.equal(observed, fixture.projects.length * 2);
  } finally { await monitor.stop(); writer.close(); }
});


test('M8: 내부 파일 오류는 경로를 노출하지 않고 500 고정 응답을 반환한다', async t => {
  const { db, root } = setup(t), dashboard = await startDashboard({ dbPath: db, port: 0, observe: false });
  const list = Store.prototype.list, logs = [];
  t.mock.method(console, 'error', (...args) => logs.push(args));
  t.mock.method(Store.prototype, 'list', function (kind, ...args) {
    if (kind === 'agent-update') readFileSync(join(root, 'private-internal-missing-file'));
    return list.call(this, kind, ...args);
  });
  try {
    const response = await fetch(dashboard.url + '/api/overview');
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: 'internal-error', message: '요청 처리 중 오류가 발생했습니다.' });
    assert.equal(logs.length, 1); assert.equal(logs[0][0], 'ENOENT');
    assert.equal(logs[0][1].includes('\n'), false);
  } finally { t.mock.restoreAll(); await dashboard.close(); }
});


test('L5: onObserved 실패는 해당 프로젝트에만 남고 다음 관측에서 복구한다', async t => {
  const { store, fixture } = setup(t); let failing = true;
  const calls = [];
  const monitor = createMonitor(store, { cliPath: 'fixture', observe: async () => {}, onObserved: async project => {
    calls.push(project.id);
    if (failing && project.id === fixture.projects[0].id) throw Object.assign(new Error('private-source-error'), { code: 'invalid-history' });
  } });
  try {
    await monitor.refresh();
    assert.equal(calls.length, fixture.projects.length);
    const first = monitor.snapshot();
    assert.equal(first.projects.find(p => p.id === fixture.projects[0].id).observation.error, '질문 조회 실패: invalid-history');
    assert.ok(!JSON.stringify(first).includes('private-source-error'));
    assert.ok(first.projects.filter(p => p.id !== fixture.projects[0].id).every(p => !p.observation.error));
    failing = false; await monitor.refresh();
    assert.equal(monitor.snapshot().projects.find(p => p.id === fixture.projects[0].id).observation.error, '');
  } finally { await monitor.stop(); }
});
