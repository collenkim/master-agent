import test from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.mjs';
import { DecisionDelegation } from '../packages/orchestrator/decisions.mjs';

function fixture(t, failure) {
  const f = setup(t), m = f.store.need('mission', f.mission.id), task = m.plans.at(-1).proposal.tasks[0];
  const attempt = { id: 'attempt', projectId: task.projectId, taskId: task.id, state: 'waiting-decision', codeAgentWorkId: 'WORK', turns: [{ id: 'turn' }] };
  m.attempts.push(attempt); m.tasks[0].state = 'waiting-decision'; m.state = 'waiting-decision';
  f.engine.save(m, 'fixture-waiting');
  const delegation = new DecisionDelegation(f.store);
  for (const target of ['q1', 'q2']) delegation.escalate({ m, attempt, kind: 'question', target, reason: '사람의 업무 판단이 필요하다.' });
  const calls = [];
  const host = { client(project) {
    assert.equal(project.id, task.projectId);
    return { async result(command, input) {
      if (command === 'grants') return { grants: [{ id: 'grant', actions: ['answer'], works: ['WORK'], missions: [] }] };
      if (command === 'questions') return { questionsHash: 'questions-hash' };
      assert.equal(command, 'answer');
      const recorded = f.store.need('delegation', input.payload.decisionId);
      assert.equal(recorded.state, 'recorded');
      assert.equal(input.commandId, `rel-${recorded.id}`);
      assert.equal(input.payload.actor, 'human'); assert.equal(input.payload.questionsHash, 'questions-hash');
      calls.push(input);
      if (failure) throw failure;
      return { status: 'answered' };
    } };
  } };
  return { ...f, delegation, host, calls };
}

test('M3: relay 성공은 보내기 전 기록하고 전달한 질문의 escalation만 해결한다', async t => {
  const f = fixture(t);
  const result = await f.delegation.relay(f.mission.id, 'attempt', f.host, { answers: [{ q: 'q1', answer: '확정 이벤트' }] });
  assert.equal(f.calls.length, 1);
  const record = f.store.need('delegation', result.decisionId);
  assert.equal(record.state, 'answered'); assert.equal(record.relayed, true); assert.ok(record.finishedAt);
  assert.equal(f.delegation.escalations(f.mission.id).find(e => e.target === 'q1').state, 'resolved');
  assert.equal(f.delegation.escalations(f.mission.id).find(e => e.target === 'q2').state, 'open');
  assert.equal(f.store.need('mission', f.mission.id).attempts[0].delegatedTurnId, 'turn');
});

test('M3: relay 전송 실패는 코드만 rejected에 남기고 escalation을 열어 둔다', async t => {
  const error = Object.assign(new Error('secret-host-path-and-token'), { code: 'EPIPE', controlCode: 'answer-rejected' });
  const f = fixture(t, error);
  await assert.rejects(f.delegation.relay(f.mission.id, 'attempt', f.host, { answers: [{ q: 'q1', answer: '확정 이벤트' }] }), e => e === error);
  const record = f.delegation.delegations(f.mission.id)[0];
  assert.equal(record.state, 'rejected'); assert.equal(record.error, 'answer-rejected'); assert.ok(record.finishedAt);
  assert.ok(f.delegation.escalations(f.mission.id).every(e => e.state === 'open'));
  assert.equal(f.store.need('mission', f.mission.id).attempts[0].delegatedTurnId, undefined);
  assert.ok(!JSON.stringify(f.store.db.prepare('SELECT body FROM records UNION ALL SELECT body FROM events').all()).includes(error.message));
});
