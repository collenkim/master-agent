import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, cleanup } from './helpers.mjs';
import { Store } from '../packages/storage/store.mjs';
import { Engine } from '../packages/orchestrator/engine.mjs';
import { acceptRequest } from '../packages/orchestrator/requests.mjs';

test('업무 번호는 프로젝트별 고유하며 다른 접수 키·그룹 중복도 원자적으로 거부한다', t => {
  const f = setup(t);
  const input = { targetType: 'project', targetId: f.fixture.projects[0].id, goal: '신규 기능', taskNumber: 'UZRF-392', requestKey: 'first' };
  const first = acceptRequest(f.store, input);
  assert.equal(acceptRequest(f.store, input).request.id, first.request.id);
  assert.throws(() => acceptRequest(f.store, { ...input, goal: '같은 기능의 수정', requestKey: 'followup' }), { code: 'request-conflict' });
  assert.throws(() => acceptRequest(f.store, { ...input, taskNumber: 'uzrf-392', requestKey: 'case' }), { code: 'request-conflict' });
  const second = acceptRequest(f.store, { ...input, targetId: f.fixture.projects[1].id, requestKey: 'second' });
  assert.notEqual(first.request.id, second.request.id);
  const before = f.store.list('mission').length;
  assert.throws(() => acceptRequest(f.store, { ...input, targetType: 'group', targetId: f.fixture.group.id, requestKey: 'group' }), { code: 'request-conflict' });
  assert.equal(f.store.list('mission').length, before);
  assert.equal(f.store.db.prepare('SELECT * FROM requests WHERE key=?').get('group'), undefined);
});

test('기존 저장소의 완료·취소된 업무 번호도 재시작 뒤 새 목표로 중복 생성하지 않는다', t => {
  const f = setup(t);
  const input = { ...f.fixture.mission, taskNumber: 'UZRF-394', requestKey: 'legacy', scope: { projectIds: [f.fixture.projects[0].id], groupIds: [] } };
  const mission = f.engine.create(input);
  f.store.transaction(() => f.store.put('mission', { ...mission, state: 'succeeded' }, mission.revision));
  const other = new Store(f.db); cleanup(t, () => other.close());
  assert.throws(() => new Engine(other).create({ ...input, requestKey: 'new' }), { code: 'request-conflict' });
  assert.equal(new Engine(other).create(input).id, mission.id);
});

test('하나의 그룹 요청은 같은 업무 번호를 여러 프로젝트에 예약한다', t => {
  const f = setup(t);
  const input = { targetType: 'group', targetId: f.fixture.group.id, goal: '통합 기능', taskNumber: 'UZRF-395', requestKey: 'group' };
  const first = acceptRequest(f.store, input);
  assert.deepEqual([...first.request.projectIds].sort(), [...f.store.need('group', f.fixture.group.id).projectIds].sort());
  for (const projectId of first.request.projectIds) {
    assert.throws(() => acceptRequest(f.store, { ...input, targetType: 'project', targetId: projectId, requestKey: projectId }), { code: 'request-conflict' });
  }
});
