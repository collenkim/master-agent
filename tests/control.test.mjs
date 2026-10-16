import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { controlFixture } from './control-fixture.mjs';
import { LiveWorkflow } from '../packages/orchestrator/drive.mjs';
import { LiveExecution } from '../packages/orchestrator/live.mjs';
import { DecisionDelegation } from '../packages/orchestrator/decisions.mjs';
import { inspectDelivery } from '../packages/verification/delivery.mjs';
import { snapshotTree } from '../packages/verification/tree.mjs';
import { hostPrompt } from '../packages/runner/claude-host.mjs';

// 모의 시험 — code-agent 통신 계약을 흉내 낸 전송(control-fixture.mjs)과 가짜 판단기를 쓴다. 실제 code-agent·모델 실행 결과가 아니다.

const attemptOf = (f, taskId) => f.store.need('mission', f.mission.id).attempts.filter(a => a.taskId === taskId).at(-1);
const until = async (f, done, limit = 20) => {
  const workflow = new LiveWorkflow(f.store);
  for (let i = 0; i < limit && !done(); i++) await workflow.advance(f.mission.id, f.host, f.provider);
  assert.ok(done(), '기대한 자리에 닿지 못했다');
};
const dispatch = async (f, taskId) => {
  const task = f.tasks.find(t => t.id === taskId);
  await new LiveExecution(f.store).dispatch(f.mission.id, taskId, f.host, { expectedRevision: f.store.need('mission', f.mission.id).revision, expectedState: f.stateOf(task.projectId).stateVersion });
  return attemptOf(f, taskId);
};

test('drive 는 두 프로젝트를 위임 판단 → 독립 검증 → 위임 반영 → 인계 → 통합 완료까지 잇고, 판단은 보내기 전에 기록한다', async t => {
  const f = controlFixture(t, { questions: { two: [{ id: 'Q1', title: '기본값', body: '값은 2인가?', options: ['예', '아니오'] }] } });
  const result = await new LiveWorkflow(f.store).run(f.mission.id, f.host, f.provider);
  assert.equal(result.mission.state, 'succeeded', JSON.stringify(result.blockers));
  assert.equal(result.mission.attempts.length, 3);
  // 같은 호출의 재전송 없이 회차마다 실행 하나
  const submits = f.calls.filter(c => c.type === 'submit');
  assert.equal(new Set(submits.map(c => c.commandId)).size, submits.length);
  // 위임 판단은 master 기록(recorded)이 먼저 있고 그 뒤에 보낸다
  const sent = f.calls.filter(c => c.type === 'decide' || c.type === 'answer');
  assert.ok(sent.length >= 10);
  assert.ok(sent.every(c => c.delegationState === 'recorded'), '보낸 시점에 판단이 이미 기록돼 있다');
  const delegations = new DecisionDelegation(f.store).delegations(f.mission.id);
  assert.ok(delegations.every(d => ['applied', 'answered'].includes(d.state) && d.category === 'routine'));
  assert.equal(delegations.filter(d => d.action === 'deliver').length, 3);
  assert.ok(f.calls.some(c => c.type === 'answer' && c.payload.actor === 'ai' && c.payload.answers[0].q === 'Q1'));
  // 반영 동의는 master 검증이 끝난 뒤에만 판단했다
  const m = f.store.need('mission', f.mission.id);
  for (const d of delegations.filter(d => d.action === 'deliver')) {
    const verified = f.store.list('verification-run').find(r => r.attemptId === d.attemptId && r.state === 'verified');
    assert.ok(verified && Date.parse(verified.finishedAt) <= Date.parse(d.recordedAt));
  }
  // 증거는 위임 반영 영수증과 결합한다
  const evidence = f.store.list('evidence');
  assert.equal(evidence.length, 3);
  assert.ok(evidence.every(e => e.delivery.level === 'local-commit-with-consent-record'));
  const decisions = f.store.list('decision').filter(d => d.missionId === m.id && (d.action === 'delegate-consent' || d.action === 'delegate-answer'));
  assert.ok(decisions.length >= 10 && decisions.every(d => d.actor === 'ai-delegate' && d.reason && d.evidence.length));
});

test('critical·모호한 승인·권한 없음·사람만 동작·master 가 준비하지 않은 동의는 보내지 않고 사람에게 넘긴다', async t => {
  const f = controlFixture(t);
  let attempt = await dispatch(f, 'edit-one');
  assert.equal(attempt.state, 'waiting-decision');
  const delegation = new DecisionDelegation(f.store);
  f.provider.verdicts.push({ category: 'critical', verdict: 'approve', reason: '외부 영향이 있다', evidence: ['policy'] });
  let out = await delegation.resolve(f.mission.id, attempt.id, f.host, f.provider);
  assert.equal(out.progressed, false); assert.equal(out.blockers.length, 1);
  assert.equal(f.calls.filter(c => c.type === 'decide').length, 0);
  assert.equal(delegation.escalations(f.mission.id)[0].category, 'critical');
  // 같은 대상은 열린 이관 하나로 묶는다
  out = await delegation.resolve(f.mission.id, attempt.id, f.host, f.provider);
  assert.equal(delegation.escalations(f.mission.id).length, 1);
  // 판단기가 없으면 사람에게
  out = await delegation.resolve(f.mission.id, attempt.id, f.host, undefined);
  assert.equal(out.progressed, false);
  // master 실행이 준비하지 않은 동의(사람 세션에서 준비)는 그 세션의 사람이 답한다
  f.sims.one.consents[0].preparedByMasterRun = false;
  f.store.transaction(() => { for (const e of delegation.escalations(f.mission.id)) f.store.put('escalation', { ...e, state: 'resolved' }, e.revision); });
  out = await delegation.resolve(f.mission.id, attempt.id, f.host, f.provider);
  assert.match(delegation.escalations(f.mission.id).find(e => e.state === 'open').reason, /준비하지 않은/);
  assert.equal(f.calls.filter(c => c.type === 'decide').length, 0);
});

test('권한이 없으면 판단기를 부르지 않고 사람에게 넘긴다', async t => {
  const f = controlFixture(t, { humanOnly: { two: ['request'] }, grants: [] });
  const attempt = await dispatch(f, 'edit-one');
  const delegation = new DecisionDelegation(f.store);
  let asked = 0; const judge = { name: 'count', async generate(args) { asked++; return f.provider.generate(args); } };
  const out = await delegation.resolve(f.mission.id, attempt.id, f.host, judge);
  assert.equal(asked, 0, '권한이 없으면 판단기를 부르지 않는다');
  assert.match(out.blockers[0], /human-consent/);
  assert.match(delegation.escalations(f.mission.id)[0].reason, /위임 권한이 없습니다/);
});

test('모호한 판단은 승인하지 않고 수정 요청(재검토)만 보낸다 — 그 밖은 추가 정보 요청으로 멈춘다', async t => {
  const g = controlFixture(t);
  const a2 = await dispatch(g, 'edit-one');
  g.provider.verdicts.push({ category: 'ambiguous', verdict: 'request-changes', reason: '요구 범위가 둘로 읽힌다 — 범위를 좁혀 다시 정리', evidence: ['task.goal'] });
  const r2 = await new DecisionDelegation(g.store).resolve(g.mission.id, a2.id, g.host, g.provider);
  assert.equal(r2.progressed, true);
  const sent = g.calls.find(c => c.type === 'decide');
  assert.equal(sent.payload.verdict, 'request-changes'); assert.equal(sent.payload.category, 'ambiguous');
  g.provider.verdicts.push({ category: 'ambiguous', verdict: 'approve', reason: '근거 부족', evidence: ['task.goal'] });
  g.sims.one.consents.push({ ...g.sims.one.consents[0], id: 'c-second', status: 'pending' });
  const r3 = await new DecisionDelegation(g.store).resolve(g.mission.id, a2.id, g.host, g.provider);
  assert.equal(r3.progressed, false);
  assert.match(new DecisionDelegation(g.store).escalations(g.mission.id)[0].reason, /추가 정보가 필요합니다/);
});

test('반영 동의는 master 의 독립 검증 전에는 판단하지 않는다', async t => {
  const f = controlFixture(t);
  const delegation = new DecisionDelegation(f.store);
  await until(f, () => f.sims.one.consents.at(-1)?.action === 'deliver' && attemptOf(f, 'edit-one')?.state === 'waiting-decision'); // 접수·요구·계획·구현·종료 관측
  const attempt = attemptOf(f, 'edit-one');
  assert.equal(attempt.state, 'waiting-decision');
  assert.equal(f.sims.one.consents.at(-1).action, 'deliver');
  const out = await delegation.resolve(f.mission.id, attempt.id, f.host, f.provider);
  assert.deepEqual(out.blockers, ['edit-one:awaiting-master-verification']);
  assert.equal(f.calls.filter(c => c.type === 'decide' && c.payload.consentId === f.sims.one.consents.at(-1).id).length, 0);
});

test('위임 영수증은 이 시도의 적용된 deliver 판단과 같아야 한다', async t => {
  const f = controlFixture(t);
  await until(f, () => f.store.list('delegation').some(d => d.action === 'deliver' && d.state === 'applied')); // … 검증·위임 반영까지
  const m = f.store.need('mission', f.mission.id), attempt = attemptOf(f, 'edit-one');
  assert.equal(attempt.state, 'verified');
  const run = f.store.need('verification-run', attempt.verificationRunId), project = f.store.need('project', 'one');
  const tree = snapshotTree(project.path);
  assert.equal(inspectDelivery(project, attempt, run, tree, f.store).mode, 'code-agent-commit');
  // 판단 기록이 없거나(다른 저장소) 적용되지 않았으면 영수증으로 받지 않는다
  assert.throws(() => inspectDelivery(project, attempt, run, tree), e => e.code === 'missing-delivery-receipt');
  const d = f.store.list('delegation').find(x => x.attemptId === attempt.id && x.action === 'deliver');
  f.store.transaction(() => f.store.put('delegation', { ...d, state: 'rejected' }, d.revision));
  assert.throws(() => inspectDelivery(project, attempt, run, tree, f.store), e => e.code === 'missing-delivery-receipt');
  assert.ok(m);
});

test('재시작 뒤 실행 중으로 남은 시도는 같은 호출의 실행에 다시 붙고 새 실행을 만들지 않는다', async t => {
  const f = controlFixture(t);
  const live = new LiveExecution(f.store);
  // 접수 뒤 결과를 받기 전에 master 가 멈춘 상황 — 실행은 code-agent 에서 끝났고 시도는 running 으로 남는다
  f.host.follow = async () => { throw Object.assign(new Error('master 중단'), { code: 'master-crashed' }); };
  live.invoke = async (ticket, host) => { await host.execute(ticket, { beforeStart: () => {} }).catch(() => {}); return null; };
  await live.dispatch(f.mission.id, 'edit-one', f.host, { expectedRevision: f.store.need('mission', f.mission.id).revision, expectedState: f.stateOf('one').stateVersion });
  const attempt = attemptOf(f, 'edit-one');
  assert.equal(attempt.state, 'running');
  delete f.host.follow;
  const submitted = f.calls.filter(c => c.type === 'submit').length;
  const after = await new LiveWorkflow(f.store).advance(f.mission.id, f.host, f.provider);
  assert.equal(after.progressed, true);
  assert.equal(attemptOf(f, 'edit-one').state, 'waiting-decision');
  assert.equal(f.calls.filter(c => c.type === 'submit').length, submitted, '다시 붙을 때 실행을 새로 접수하지 않는다');
  assert.ok(f.calls.some(c => c.type === 'command' && c.payload.commandId === `inv-${attempt.invocationId}`));
  assert.ok(f.store.events(f.mission.id).some(e => e.type === 'live-reattach'));
});

test('같은 commandId 를 다른 내용으로 보내면 거부되고, 이벤트 기록 ID 가 바뀌면 스냅샷으로 다시 맞춘다', async t => {
  const f = controlFixture(t);
  const client = f.host.client(f.store.need('project', 'one'));
  await client.result('submit', { commandId: 'x-1', payload: { mode: 'start', prompt: 'a' } });
  await client.result('submit', { commandId: 'x-1', payload: { mode: 'start', prompt: 'a' } });
  await assert.rejects(client.result('submit', { commandId: 'x-1', payload: { mode: 'start', prompt: 'b' } }), e => e.code === 'control-conflict');
  assert.equal(Object.keys(f.sims.one.runs).length, 1);
  const project = f.store.need('project', 'one');
  await f.host.pump(project, client, f.mission.id);
  const cursor = f.store.get('control-cursor', 'one');
  assert.equal(cursor.seq, f.events.one.list.length);
  f.events.one.logId = 'log-one-recreated';
  const out = await f.host.pump(project, client, f.mission.id);
  assert.equal(out.resynced, true);
  assert.equal(f.store.get('control-cursor', 'one').logId, 'log-one-recreated');
  assert.ok(f.store.events(f.mission.id).some(e => e.type === 'control-resynced'));
});

test('정지는 그 시도의 지금 호출로 접수된 실행만 대상으로 한다', async t => {
  const f = controlFixture(t);
  const live = new LiveExecution(f.store);
  live.invoke = async (ticket, host) => { await host.execute(ticket, { beforeStart: () => {} }); return null; };
  const m = f.store.need('mission', f.mission.id);
  await live.dispatch(f.mission.id, 'edit-one', f.host, { expectedRevision: m.revision, expectedState: f.stateOf('one').stateVersion });
  await live.dispatch(f.mission.id, 'edit-two', f.host, { expectedRevision: f.store.need('mission', f.mission.id).revision, expectedState: f.stateOf('two').stateVersion });
  const one = attemptOf(f, 'edit-one');
  const result = await f.host.stopAttempt(f.mission.id, one.id, 'pause', {});
  assert.equal(result.stopped, true);
  const stops = f.calls.filter(c => c.type === 'pause');
  assert.equal(stops.length, 1); assert.equal(stops[0].project, 'one');
  const runOne = f.store.list('control-run').find(r => r.attemptId === one.id);
  assert.equal(stops[0].payload.runId, runOne.id);
  assert.equal(stops[0].commandId, `stop-${runOne.id}-pause`);
  await assert.rejects(f.host.stopAttempt(f.mission.id, 'missing', 'pause', {}), e => e.code === 'invalid-state');
});

test('위임 판단이 처리한 회차만 자동으로 이어 가고, 사람에게 넘긴 판단이 남으면 멈춘다', async t => {
  const f = controlFixture(t);
  const workflow = new LiveWorkflow(f.store);
  f.provider.verdicts.push({ category: 'critical', verdict: 'approve', reason: '정책 변경', evidence: ['policy.txt'] });
  const first = await workflow.run(f.mission.id, f.host, f.provider);
  assert.equal(first.progressed, false);
  assert.ok(first.blockers.some(b => /human-consent/.test(b)), JSON.stringify(first.blockers));
  // 두 프로젝트는 독립이다 — one 이 사람 판단을 기다려도 two 는 진행됐다(통합은 둘 다 끝나야 한다)
  const m = f.store.need('mission', f.mission.id);
  assert.equal(m.tasks.find(t => t.id === 'edit-two').state, 'succeeded');
  assert.equal(m.tasks.find(t => t.id === 'integrate').state, 'queued');
  assert.equal(attemptOf(f, 'edit-one').state, 'waiting-decision');
  // 사람이 code-agent 에서 직접 답하면(위임 아님) 관찰로 이관을 닫는다
  const consent = f.sims.one.consents.find(c => c.status === 'pending');
  consent.status = 'applied'; f.sims.one.request = { status: 'confirmed' }; f.sims.one.work = { id: f.sims.one.pendingWork, phase: 'plan' }; f.sims.one.n++;
  await new DecisionDelegation(f.store).resolve(f.mission.id, attemptOf(f, 'edit-one').id, f.host, f.provider);
  assert.equal(new DecisionDelegation(f.store).escalations(f.mission.id)[0].resolvedBy, 'observed-in-code-agent');
  // 사람이 답한 회차는 위임 회차가 아니다 — 기존 조건(요구 확정·계획 승인)이 없으면 자동 계속하지 않는다
  const next = await workflow.advance(f.mission.id, f.host, f.provider);
  assert.equal(next.progressed, false);
  assert.ok(next.blockers.includes('edit-one:remote-unapproved'), JSON.stringify(next.blockers));
  assert.equal(execFileSync('git', ['-C', f.projects[0].path, 'log', '--oneline'], { encoding: 'utf8' }).trim().split('\n').length, 1, '반영 커밋 없음');
});

test('통신 계약 실행의 프롬프트는 세션에 기대 상태를 다시 대조시키지 않는다 — 접수 때 code-agent 가 대조했다(직접 실행 호스트는 그대로)', () => {
  const ticket = { missionId: 'M', planVersion: 1, taskId: 'T', id: 'A', codeAgentWorkId: 'MA-1', expectedState: 'sha256:x', goal: 'g', criteria: [], task: {}, inputEvidence: [] };
  const control = hostPrompt(ticket, { control: true }), direct = hostPrompt(ticket);
  assert.ok(!control.includes('sha256:x') && !control.includes('"expectedState"') && !control.includes('기대 상태와 다르면'));
  assert.match(control, /다시 대조하지 말고/);
  assert.ok(direct.includes('"expectedState": "sha256:x"') && direct.includes('기대 상태와 다르면'));
  // master 의 독립 검사·범위 제약은 code-agent 요구·테스트로 옮기지 않는다(두 경로 공통)
  for (const prompt of [control, direct]) assert.match(prompt, /독립 검사입니다. 프로젝트 밖 검사 스크립트를 작업 안에서 실행하거나 code-agent의 수락 기준·테스트 케이스로 옮기지 마세요/);
});

test('반영 동의의 문서 변경 후보는 위임 판단이 적용하지 않고(모두 유지), 판단기에도 그렇게 알린다', async t => {
  const f = controlFixture(t);
  f.deliverChoices.one = [{ shown: '--- doc/knowledge/features.md 새 항목', prompt: '적용하려면 y', target: 'doc/knowledge/features.md', key: 'FEAT-x' }];
  await until(f, () => f.store.list('delegation').some(d => d.action === 'deliver' && d.state === 'applied'));
  const d = f.store.list('delegation').find(x => x.action === 'deliver' && x.state === 'applied');
  const sent = f.calls.find(c => c.type === 'decide' && c.payload.consentId === d.target);
  assert.deepEqual(sent.payload.choices, { 1: '유지' });
  const asked = f.provider.prompts.find(p => p.includes('"action": "deliver"') && p.includes('FEAT-x'));
  assert.match(asked, /choices\(문서 변경 후보\)는 위임 판단이 적용하지 않는다/);
  assert.match(asked, /"delegatedAnswer": "유지"/);
});

test('같은 프로젝트의 선행 작업이 반영한 커밋을 새 작업의 기준으로 알려 준다(다른 프로젝트의 반영은 기준이 아니다)', () => {
  const ticket = { missionId: 'M', planVersion: 1, taskId: 'T', id: 'A', projectId: 'app', codeAgentWorkId: 'MA-2', goal: 'g', criteria: [], task: {},
    inputEvidence: [{ projectId: 'core', delivery: { commit: 'c0ffee1' } }, { projectId: 'app', delivery: { commit: 'abc1234' } }, { projectId: 'app', delivery: { level: 'local-files' } }] };
  const prompt = hostPrompt(ticket, { control: true });
  assert.match(prompt, /--base abc1234/);
  assert.match(prompt, /"codeAgentBase": "abc1234"/);
  assert.ok(!prompt.includes('--base c0ffee1'));
  assert.ok(!hostPrompt({ ...ticket, inputEvidence: [] }, { control: true }).includes('codeAgentBase'));
});

test('독립 검증은 code-agent 가 반영 자리에 닿은 뒤에만 한다 — 리뷰 질문이 위임으로 답해지면 같은 세션을 먼저 이어 간다', async t => {
  const f = controlFixture(t, { reviewQuestions: { one: { id: 'Q1', title: '리뷰 지적 처리', body: 'TC 를 더할까?', options: ['재계획으로 TC 추가', '기각'] } } });
  const result = await new LiveWorkflow(f.store).run(f.mission.id, f.host, f.provider);
  assert.equal(result.mission.state, 'succeeded', JSON.stringify(result.blockers));
  const runs = f.store.list('verification-run').filter(r => r.missionId === f.mission.id);
  assert.ok(runs.length >= 3 && runs.every(r => r.remote.work?.phase === 'deliver'), '모든 독립 검증이 반영 자리에서 돌았다');
  const one = f.store.need('mission', f.mission.id).attempts.find(a => a.taskId === 'edit-one');
  assert.equal(runs.filter(r => r.attemptId === one.id).length, 1, '리뷰 자리에서 검증하지 않았다');
  assert.ok(f.calls.some(c => c.project === 'one' && c.type === 'answer' && c.payload.answers[0].q === 'Q1'));
});

test('검증 뒤 code-agent 작업이 반영 자리를 떠나면 그 검증으로 인계하지 않고 같은 세션을 이어 가 반영 자리에서 다시 검증한다', async t => {
  const f = controlFixture(t);
  await until(f, () => attemptOf(f, 'edit-one')?.state === 'verified');
  const first = attemptOf(f, 'edit-one');
  // 반영 동의가 수정 요청으로 닫히고 작업이 리뷰로 되돌아간 자리를 흉내 낸다
  for (const c of f.sims.one.consents.filter(c => c.status === 'pending')) c.status = 'changes-requested';
  f.sims.one.work.phase = 'review'; f.sims.one.n++;
  // 직접 실행 호스트(통신 계약 아님)에는 검증된 시도를 이어 가는 길을 열지 않는다
  const direct = { mode: 'live', name: 'claude', inspect: f.host.inspect.bind(f.host), execute: async () => assert.fail('실행하지 않는다') };
  await assert.rejects(new LiveExecution(f.store).continue(f.mission.id, first.id, direct, { expectedRevision: f.store.need('mission', f.mission.id).revision, expectedState: f.stateOf('one').stateVersion }), { code: 'invalid-state' });
  await until(f, () => f.store.need('mission', f.mission.id).tasks.find(t => t.id === 'edit-one').state === 'succeeded');
  const runs = f.store.list('verification-run').filter(r => r.attemptId === first.id).sort((x, y) => Date.parse(x.startedAt) - Date.parse(y.startedAt));
  assert.equal(runs.length, 2);
  assert.ok(runs.every(r => r.remote.work?.phase === 'deliver'));
  const events = f.store.events(f.mission.id).map(e => e.type);
  const verifiedAt = events.indexOf('verification-recorded');
  assert.ok(events.indexOf('live-continued', verifiedAt) > verifiedAt, '검증 뒤 같은 세션을 이어 갔다');
  const evidence = f.store.list('evidence').find(e => e.attemptId === first.id);
  assert.equal(evidence.verificationRunId, runs.at(-1).id, '인계 증거는 반영 자리에서 다시 한 검증에 결합한다');
});

test('위임 판단이 수정 요청을 보낸 회차는 code-agent 가 다시 받을 확인 요청을 사람 몫으로 보여도 같은 세션이 고쳐 다시 준비하고, 그 확인 요청은 다시 판단한다', async t => {
  const f = controlFixture(t);
  const instruction = `계획은 범위 안이다. ${'근거 문장. '.repeat(50)}다만 가정 문구와 새 TC 가 어긋난다 — 가정을 고치고 TC 의 수락 기준 연결을 밝힌 뒤 다시 확인을 요청하세요`;
  f.provider.verdicts.push({ category: 'routine', verdict: 'approve', reason: '요구 확정', evidence: ['task.goal'] },
    { category: 'ambiguous', verdict: 'request-changes', reason: instruction, evidence: ['plan'] });
  const result = await new LiveWorkflow(f.store).run(f.mission.id, f.host, f.provider);
  assert.equal(result.mission.state, 'succeeded', JSON.stringify(result.blockers));
  const plans = new DecisionDelegation(f.store).delegations(f.mission.id).filter(d => d.projectId === 'one' && d.action === 'plan')
    .sort((x, y) => Date.parse(x.recordedAt) - Date.parse(y.recordedAt));
  assert.deepEqual(plans.map(d => `${d.category}/${d.verdict}/${d.state}`).slice(0, 2), ['ambiguous/request-changes/changes-requested', 'routine/approve/applied']);
  assert.notEqual(plans[0].target, plans[1].target, '고쳐 다시 준비한 확인 요청을 판단했다');
  // 이어 간 회차의 프롬프트에 수정 지시가 전문으로 들어간다(판단 요약은 앞 300자뿐이다)
  assert.ok(instruction.length > 300);
  assert.ok(f.calls.some(c => c.project === 'one' && c.type === 'submit' && c.payload.mode === 'continue' && c.payload.prompt.includes(instruction)));
});

test('code-agent 가 이어 실행 접수를 응답으로 거부하면 실행되지 않은 것으로 확인해 같은 세션의 막힘으로 남기고(미확인 아님), 같은 자리를 되풀이하지 않는다', async t => {
  const f = controlFixture(t, { rejectContinue: { one: true } });
  const result = await new LiveWorkflow(f.store).run(f.mission.id, f.host, f.provider);
  const one = attemptOf(f, 'edit-one'), turn = one.turns.at(-1);
  assert.notEqual(one.state, 'unknown');
  assert.equal(turn.result.control.state, 'rejected');
  assert.equal(turn.result.control.rejected.code, 'invalid-state');
  assert.equal(turn.result.sessionId, one.turns.at(-2).result.sessionId, '세션을 잃지 않는다');
  assert.equal(f.store.list('control-run').filter(r => r.invocationId === one.invocationId).length, 0, '실행 기록이 없다');
  assert.ok(f.store.events(f.mission.id).some(e => e.type === 'control-submit-rejected' && e.attemptId === one.id));
  assert.equal(f.calls.filter(c => c.project === 'one' && c.type === 'submit' && c.payload.mode === 'continue').length, 1, '거부된 이어 실행을 자동으로 다시 보내지 않는다');
  // 독립 프로젝트는 그대로 진행했다
  assert.equal(result.mission.tasks.find(x => x.id === 'edit-two').state, 'succeeded');
});

test('반영 확인이 위임 수정 요청을 받으면 검증된 시도라도 인계하지 않고 같은 세션이 반영 확인을 다시 준비하며, 반영 판단 전에 다시 검증한다', async t => {
  const f = controlFixture(t);
  const instruction = '반영 목록과 master 가 검증한 변경 경로가 다르다 — 목록을 맞추거나 각 파일의 이유를 밝힌 뒤 다시 확인을 요청하세요';
  f.provider.verdicts.push({ category: 'routine', verdict: 'approve', reason: '요구 확정', evidence: ['task.goal'] },
    { category: 'routine', verdict: 'approve', reason: '계획 범위 안', evidence: ['plan'] },
    { category: 'ambiguous', verdict: 'request-changes', reason: instruction, evidence: ['masterVerification.changedPaths'] });
  const result = await new LiveWorkflow(f.store).run(f.mission.id, f.host, f.provider);
  assert.equal(result.mission.state, 'succeeded', JSON.stringify(result.blockers));
  const one = f.store.need('mission', f.mission.id).attempts.find(a => a.taskId === 'edit-one');
  const delivers = new DecisionDelegation(f.store).delegations(f.mission.id).filter(d => d.attemptId === one.id && d.action === 'deliver')
    .sort((x, y) => Date.parse(x.recordedAt) - Date.parse(y.recordedAt));
  assert.deepEqual(delivers.map(d => d.state), ['changes-requested', 'applied']);
  const runs = f.store.list('verification-run').filter(r => r.attemptId === one.id).sort((x, y) => Date.parse(x.startedAt) - Date.parse(y.startedAt));
  assert.equal(runs.length, 2, '다시 준비한 반영 확인 전에 다시 검증했다');
  assert.ok(Date.parse(runs[1].finishedAt) <= Date.parse(delivers[1].recordedAt));
  assert.ok(f.calls.some(c => c.project === 'one' && c.type === 'submit' && c.payload.mode === 'continue' && c.payload.prompt.includes(instruction)));
  assert.equal(f.store.list('evidence').find(e => e.attemptId === one.id).verificationRunId, runs[1].id);
});

test('통신 계약 실행의 프롬프트는 선행 증거를 요약만 싣는다 — 통합 작업도 code-agent 접수 한도(20000자) 안이다(직접 실행 호스트는 그대로)', () => {
  const evidence = (taskId, projectId, commit) => ({ id: `e-${taskId}`, taskId, projectId, attemptId: `a-${taskId}`, verificationRunId: `v-${taskId}`, at: '2026-10-15T00:00:00.000Z',
    checks: [{ id: `${taskId}-independent`, criterionIds: [taskId], passed: true, exitCode: 0, output: '통과\n'.repeat(400), outputHash: 'h' }],
    tree: { head: commit, digest: 'd', files: Array.from({ length: 150 }, (_, i) => ({ path: `doc/work/MA-x/file-${i}.md`, digest: 'f'.repeat(64) })) },
    artifacts: [{ name: `${taskId}-check`, checkId: `${taskId}-independent`, digest: 'a'.repeat(64) }], remote: { stateVersion: 's', work: null, resume: { code: 'no-work', reasons: [] } },
    delivery: { level: 'local-commit-with-consent-record', runId: 'r', commit, receiptHash: 'x'.repeat(64) } });
  const ticket = { missionId: 'M', planVersion: 1, taskId: 'checkout', id: 'A', projectId: 'app', codeAgentWorkId: 'MA-3', goal: 'g', criteria: [], task: { kind: 'integration' },
    inputEvidence: [evidence('discount', 'core', 'c0ffee1'), evidence('total', 'app', 'abc1234')] };
  const control = hostPrompt(ticket, { control: true }), direct = hostPrompt(ticket);
  assert.ok(JSON.stringify(ticket.inputEvidence).length > 20000, '시험 증거는 실제 run4 처럼 한도를 넘는다');
  assert.ok(control.length < 20000, `프롬프트 ${control.length}자`);
  for (const text of ['"commit": "c0ffee1"', '"commit": "abc1234"', '"id": "discount-independent"', '"passed": true', '"codeAgentBase": "abc1234"']) assert.ok(control.includes(text), text);
  // 검사 출력은 JSON 문자열(줄바꿈이 \n 두 글자)로 실린다
  assert.ok(!control.includes('file-149.md') && !control.includes('통과\\n통과'), '파일 트리·검사 출력은 싣지 않는다');
  assert.ok(direct.includes('file-149.md') && direct.includes('통과\\n통과'), '직접 실행 호스트의 프롬프트는 바꾸지 않는다');
});

test('업무 질문 판단에는 같은 작업에서 이미 답한 질문과 답의 출처가 함께 실린다 — 앞 답을 전제로 묻는 질문을 자료 없이 판단하지 않는다', async t => {
  const f = controlFixture(t, { questions: { two: [{ id: 'Q1', title: '기본값', body: '값은 2인가?', options: ['예', '아니오'] },
    { id: 'Q2', title: '되감기', body: 'Q1 답에 맞게 앞 단계로 되감을까?', options: ['되감는다', '보류'] }] } });
  const result = await new LiveWorkflow(f.store).run(f.mission.id, f.host, f.provider);
  assert.equal(result.mission.state, 'succeeded', JSON.stringify(result.blockers));
  const data = prompt => JSON.parse(prompt.slice(prompt.indexOf('\n{\n') + 1));
  const asked = id => f.provider.prompts.find(p => p.includes('업무 질문') && data(p).question.id === id);
  assert.deepEqual(data(asked('Q1')).answered, []);
  assert.deepEqual(data(asked('Q2')).answered, [{ id: 'Q1', title: '기본값', answer: '예', source: null }]);
  assert.match(asked('Q2'), /사람이 정한 답을 뒤집거나 넓히지 않는다/);
});
