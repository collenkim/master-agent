import test from 'node:test';
import assert from 'node:assert/strict';
import { branchFixture } from './task-branch-fixture.mjs';
import { dispatchBase, projectHandoffs } from '../packages/verification/project-history.mjs';
import { hostPrompt } from '../packages/runner/host-context.mjs';

test('의존 관계 없이 같은 프로젝트의 마지막 인계를 사용하며 배열·commit 시각·다른 프로젝트/목표를 배제한다', async t => {
  const f = branchFixture(t), first = f.commit('first'), last = f.commit('last', first);
  f.handoff('first', first); f.handoff('last', last); f.handoff('other-project', f.commit('unrelated'), { projectId: 'two' });
  const other = f.engine.create({ mode: 'live', goal: '다른 목표', requestKey: 'other', scope: { projectIds: ['one'], groupIds: [] }, criteria: [{ id: 'value', description: '검증' }] });
  const source = f.store.need('mission', f.mission.id);
  f.store.put('mission', { ...other, plans: source.plans, attempts: [], tasks: [] }, other.revision);
  f.handoff('other-mission', f.commit('other'), { missionId: other.id });
  let ticket;
  const host = { ...f.executionHost };
  // 실제 dispatch와 기존 모의 실행을 사용해 ticket·잠금·상태 전이를 확인한다.
  Object.assign(host, { mode: 'live', name: 'code-agent', transport: 'code-agent-master', inspect: async () => structuredClone(f.states.one),
    execute: async value => { ticket = value; return { status: 'blocked', sessionId: 's', summary: 'ticket 확인' }; } });
  await f.live.dispatch(f.mission.id, 'edit-one', host, f.options('one'));
  assert.equal(ticket.codeAgentBase, last); assert.deepEqual(ticket.inputEvidence, []);
  assert.match(hostPrompt(ticket), new RegExp(`--base ${last}`));
  const rows = projectHandoffs(f.store, f.store.need('mission', f.mission.id), 'one');
  assert.deepEqual(rows.map(r => r.commit), [first, last]);
});

test('앞선 인계가 여럿이면 모두 포함해야 하며 끊어진 연결은 배정·잠금·판단 기록 없이 거부한다', async t => {
  const f = branchFixture(t), a = f.commit('a'), b = f.commit('b', a), c = f.commit('c', b);
  f.handoff('a', a); f.handoff('b', b); f.handoff('c', c);
  assert.equal(dispatchBase(f.store, f.store.need('mission', f.mission.id), f.projects[0], 'MA-fresh'), c);
  f.handoff('broken', f.commit('fork', a));
  const before = f.store.need('mission', f.mission.id), decisions = f.store.list('decision').length;
  await assert.rejects(f.live.dispatch(f.mission.id, 'edit-one', { mode: 'live', name: 'code-agent', transport: 'code-agent-master',
    inspect: async () => f.states.one, execute: () => assert.fail('실행 금지') }, f.options('one')), { code: 'delivery-history' });
  assert.deepEqual(f.store.need('mission', f.mission.id), before);
  assert.equal(f.store.lock('one'), undefined); assert.equal(f.store.list('decision').length, decisions);
});

test('같은 work ID 재시도·이어가기에는 새 기준을 주지 않고 local-files HEAD는 시작 기준으로만 쓴다', async t => {
  const f = branchFixture(t), hash = f.commit('a'); f.handoff('a', hash, { localFiles: true });
  const m = f.store.need('mission', f.mission.id);
  assert.equal(dispatchBase(f.store, m, f.projects[0], 'MA-new'), hash);
  assert.equal(dispatchBase(f.store, m, f.projects[0], 'MA-a'), undefined);
  assert.equal(dispatchBase(f.store, m, f.projects[0], 'MA-resume', { work: { id: 'MA-resume' } }), undefined);
  assert.doesNotMatch(hostPrompt({ projectId: 'one', inputEvidence: [f.store.list('evidence')[0]], sessionId: 'continued', codeAgentBase: hash }), /--base|"codeAgentBase"/);
  let ticket;
  await f.live.dispatch(f.mission.id, 'edit-one', { ...f.executionHost, execute: async value => {
    ticket = value; return { status: 'blocked', sessionId: 'retry', summary: '재시도' };
  } }, { ...f.options('one'), workId: 'MA-a' });
  assert.equal(ticket.codeAgentBase, undefined);
});

test('새 작업에 준 기준은 저장된 시도와 다음 continue ticket에 다시 들어가지 않는다', async t => {
  const f = branchFixture(t), hash = f.commit('previous'); f.handoff('previous', hash);
  const tickets = [], execute = f.executionHost.execute;
  f.executionHost.execute = async (...args) => { tickets.push(args[0]); return execute(...args); };
  const attempt = await f.dispatch('edit-one');
  f.states.one.resume = { code: 'ready' };
  await f.live.continue(f.mission.id, attempt.id, f.executionHost, f.options('one'));
  assert.equal(tickets[0].codeAgentBase, hash); assert.equal(tickets[1].codeAgentBase, undefined);
  assert.equal(f.store.need('mission', f.mission.id).attempts.find(a => a.id === attempt.id).codeAgentBase, undefined);
});
