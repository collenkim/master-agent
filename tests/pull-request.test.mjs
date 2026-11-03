import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { branchFixture } from './task-branch-fixture.mjs';
import { missionPullRequests } from '../packages/verification/pull-request.mjs';
import { recoverTaskBranches } from '../packages/verification/task-branch.mjs';
import { dashboardSnapshot } from '../packages/dashboard/monitor.mjs';
import { startDashboard } from '../packages/dashboard/server.mjs';

test('taskNumber·과거 성공 기록만으로 없는/오래된 task 브랜치를 PR로 안내하지 않는다', async t => {
  const f = branchFixture(t), a = f.commit('a'); f.handoff('a', a); f.git('branch', 'feature/MA-a', a); f.finish();
  let pr = missionPullRequests(f.store, f.mission.id).projects[0];
  assert.equal(pr.branch, 'feature/MA-a'); assert.equal(pr.taskBranch.state, 'missing'); assert.equal(pr.update.state, 'pending');
  await recoverTaskBranches(f.store, f.mission.id, f.host);
  pr = missionPullRequests(f.store, f.mission.id).projects[0];
  assert.equal(pr.branch, 'task/TASK-42'); assert.equal(pr.update.state, 'completed');
  f.git('update-ref', 'refs/heads/task/TASK-42', f.base);
  pr = missionPullRequests(f.store, f.mission.id).projects[0];
  assert.equal(pr.branch, 'feature/MA-a'); assert.equal(pr.taskBranch.state, 'stale');
  f.git('branch', '-D', 'task/TASK-42'); f.git('branch', '-D', 'feature/MA-a');
  pr = missionPullRequests(f.store, f.mission.id).projects[0];
  assert.equal(pr.branch, null); assert.equal(pr.ready, false); assert.equal(pr.status, 'PR 준비 미완료');
});

test('CLI와 대시보드는 같은 PR 내용·브랜치 상태를 반환하고 Git·분석 완료·DB를 변경하지 않는다', async t => {
  const f = branchFixture(t), a = f.commit('a'); f.handoff('a', a); f.git('branch', 'feature/MA-a', a); f.finish();
  const dbPath = join(f.root, 'state.db');
  f.store.put('analysis-run', { id: 'completed-analysis', missionId: f.mission.id, state: 'completed' });
  const snapshot = () => ({ records: f.store.db.prepare('SELECT * FROM records ORDER BY kind,id').all(),
    events: f.store.db.prepare('SELECT * FROM events ORDER BY sequence').all(), locks: f.store.db.prepare('SELECT * FROM locks').all(),
    graphs: f.store.db.prepare('SELECT * FROM graph_runs').all(), refs: f.git('show-ref'), head: f.git('rev-parse', 'HEAD'),
    status: f.git('status', '--porcelain=v1'), index: readFileSync(join(f.path, '.git', 'index')).toString('hex') });
  const before = snapshot();
  const cli = () => JSON.parse(execFileSync(process.execPath, [resolve('apps/cli/main.mjs'), 'mission', 'pr', f.mission.id, '--db', dbPath], { encoding: 'utf8', stdio: 'pipe' }));
  const first = cli();
  assert.deepEqual(first, dashboardSnapshot(f.store).missions[0].pullRequests);
  const dashboard = await startDashboard({ dbPath, port: 0, observe: false });
  try {
    const response = await fetch(dashboard.url + '/api/overview'); assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).missions[0].pullRequests, first);
  } finally { await dashboard.close(); }
  assert.deepEqual(snapshot(), before);
  // 완료 목표의 상세 캐시가 있어도 Git 브랜치 상태는 다시 읽는다.
  await recoverTaskBranches(f.store, f.mission.id, f.host);
  assert.deepEqual(cli(), dashboardSnapshot(f.store).missions[0].pullRequests);
  assert.equal(cli().projects[0].branch, 'task/TASK-42');
});

test('이벤트 보존 기간 후에도 명령 기록의 인계 순서를 사용하고 기록이 없으면 추측하지 않는다', t => {
  const f = branchFixture(t), a = f.commit('a'), b = f.commit('b', a); f.handoff('a', a); f.handoff('b', b); f.git('branch', 'feature/MA-b', b); f.finish();
  f.store.db.prepare('DELETE FROM events WHERE mission_id=?').run(f.mission.id);
  let pr = missionPullRequests(f.store, f.mission.id).projects[0];
  assert.equal(pr.branch, 'feature/MA-b'); assert.deepEqual(pr.tasks.map(t => t.workId), ['MA-a', 'MA-b']);
  f.store.db.prepare("DELETE FROM records WHERE kind='control-command'").run();
  pr = missionPullRequests(f.store, f.mission.id).projects[0];
  assert.equal(pr.ready, false); assert.equal(pr.code, 'handoff-order-missing');
});

test('조회는 미커밋 파일이 있어도 커밋으로 승격하지 않고 local-files를 미완료로 표시한다', t => {
  const f = branchFixture(t); f.handoff('local', f.base, { localFiles: true }); f.finish();
  writeFileSync(join(f.path, 'uncommitted.txt'), '인계한 파일');
  const before = f.git('status', '--porcelain=v1');
  const pr = missionPullRequests(f.store, f.mission.id).projects[0];
  assert.equal(pr.commit, null); assert.equal(pr.branch, null); assert.equal(pr.ready, false);
  assert.equal(f.git('status', '--porcelain=v1'), before);
});
