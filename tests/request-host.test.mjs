import test from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.mjs';
import { controlFixture } from './control-fixture.mjs';
import { answerFor } from './planning-fixture.mjs';
import { LiveWorkflow } from '../packages/orchestrator/drive.mjs';
import { DecisionDelegation } from '../packages/orchestrator/decisions.mjs';
import { acceptRequest } from '../packages/orchestrator/requests.mjs';
import { prepareRequest } from '../packages/orchestrator/preparation.mjs';
import { Knowledge } from '../packages/knowledge/sources.mjs';
import { Planner } from '../packages/reasoning/planner.mjs';
import { CrossProvider, crossReviewSchema, hostSelection, reasoningFor } from '../packages/reasoning/hosts.mjs';
import { dashboardSnapshot } from '../packages/dashboard/monitor.mjs';

// 모의 시험 — 가짜 AI·code-agent 전송을 쓴다. 실제 Claude·Codex 실행 결과가 아니다.

const observed = async () => ({ status: 'observed' });

test('요청 host 는 단독·교차 선택을 검증하고 계획·판단 AI를 같은 host로 만든다', () => {
  assert.deepEqual(hostSelection({ mode: 'codex' }), { mode: 'codex' });
  assert.deepEqual(hostSelection({ mode: 'claude', main: 'claude' }), { mode: 'claude' });
  assert.deepEqual(hostSelection({ mode: 'both', main: 'codex' }), { mode: 'both', main: 'codex' });
  for (const bad of [null, {}, { mode: 'auto' }, { mode: 'both' }, { mode: 'claude', main: 'codex' }]) assert.throws(() => hostSelection(bad), { code: 'invalid-host' });
  const made = [];
  const cliProvider = options => { made.push(options); return { name: options.provider, model: options.model ?? 'cli-default', async generate() {} }; };
  assert.equal(reasoningFor({ execution: { mode: 'codex' }, model: 'm' }, { cliProvider }).name, 'codex');
  const cross = reasoningFor({ execution: { mode: 'both', main: 'claude' }, model: 'm' }, { cliProvider });
  assert.ok(cross instanceof CrossProvider); assert.equal(cross.name, 'claude+codex');
  // host 를 고르지 않은 요청은 기록된 provider(기본 claude) 하나로 계획·판단한다
  assert.equal(reasoningFor({ execution: null, provider: 'codex' }, { cliProvider }).name, 'codex');
  assert.equal(reasoningFor({}, { cliProvider }).name, 'claude');
  assert.deepEqual(made.map(m => m.provider), ['codex', 'claude', 'codex', 'codex', 'claude']);
  assert.equal(made[1].model, 'm'); assert.equal(made[2].model, undefined, '모델 이름은 host마다 달라 검토 host에는 넘기지 않는다');
});

test('교차 검증은 주 host 결과를 다른 host가 승인한 것만 돌려주고 반려·검토 실패는 통과시키지 않는다', async () => {
  const main = { name: 'claude', model: 'cli-default', async generate() { return { data: { answer: 42 }, provider: 'claude', model: 'cli-default' }; } };
  const reviewer = verdict => ({ name: 'codex', prompts: [], async generate({ prompt, schema }) { this.prompts.push(prompt); assert.equal(schema, crossReviewSchema); return { data: verdict }; } });
  const ok = reviewer({ verdict: 'approve', issues: [] });
  const approved = await new CrossProvider(main, ok).generate({ prompt: '원래 지시', schema: {} });
  assert.deepEqual(approved.data, { answer: 42 }); assert.equal(approved.provider, 'claude+codex'); assert.deepEqual(approved.review, { reviewer: 'codex', verdict: 'approve', issues: [] });
  assert.match(ok.prompts[0], /원래 지시/); assert.match(ok.prompts[0], /"answer":42/);
  await assert.rejects(new CrossProvider(main, reviewer({ verdict: 'reject', issues: [{ summary: '완료 조건 누락', reference: 'criterion-1' }] })).generate({ prompt: 'x', schema: {} }),
    e => e.code === 'cross-review-rejected' && /완료 조건 누락/.test(e.message) && e.draft.answer === 42 && e.review.issues[0].reference === 'criterion-1');
  await assert.rejects(new CrossProvider(main, reviewer({ verdict: 'maybe', issues: [] })).generate({ prompt: 'x', schema: {} }), { code: 'provider-invalid-json' });
  const down = { name: 'codex', async generate() { throw Object.assign(new Error('login'), { code: 'provider-auth-required' }); } };
  await assert.rejects(new CrossProvider(main, down).generate({ prompt: 'x', schema: {} }), { code: 'provider-auth-required' }, '검토 host를 실행하지 못하면 검토 없이 통과시키지 않는다');
  assert.throws(() => new CrossProvider(main, main), { code: 'invalid-provider' });
});

test('요청은 host 선택을 기록하고 계획·판단 provider 를 따로 받지 않는다', t => {
  const f = setup(t), target = f.fixture.projects[0].id;
  const input = { targetType: 'project', targetId: target, goal: 'host 선택', host: { mode: 'both', main: 'codex' }, requestKey: 'host-1' };
  const { request } = acceptRequest(f.store, input);
  assert.deepEqual(request.execution, { mode: 'both', main: 'codex' }); assert.equal(request.provider, 'codex');
  assert.equal(acceptRequest(f.store, input).created, false);
  assert.throws(() => acceptRequest(f.store, { ...input, host: { mode: 'claude' } }), { code: 'request-conflict' });
  assert.throws(() => acceptRequest(f.store, { ...input, requestKey: 'host-2', provider: 'claude' }), { code: 'invalid-input' });
  assert.throws(() => acceptRequest(f.store, { ...input, requestKey: 'host-3', host: { mode: 'both' } }), { code: 'invalid-host' });
  const legacy = acceptRequest(f.store, { targetType: 'project', targetId: f.fixture.projects[1].id, goal: 'host 없는 요청' }).request;
  assert.equal(legacy.execution, null); assert.equal(legacy.provider, 'claude');
  const shown = dashboardSnapshot(f.store).requests;
  assert.deepEqual(shown.find(r => r.id === request.id).execution, { mode: 'both', main: 'codex' }); assert.equal(shown.find(r => r.id === legacy.id).execution, null);
});

test('host 를 고른 요청은 code-agent 의 요청별 선택 지원과 고른 주 host 준비를 점검한다', async t => {
  const f = setup(t), request = acceptRequest(f.store, { targetType: 'project', targetId: f.fixture.projects[0].id, goal: '선택 점검', host: { mode: 'both', main: 'codex' } }).request;
  const managed = patch => ({ selected: 'claude', source: 'default', installedHosts: ['claude', 'codex'], execution: { mode: 'auto' }, ready: true, problems: [], ...patch });
  const hello = managedHost => ({ project: { enabled: false }, pairing: { supported: true, version: 1, trustedControllers: ['dashboard'] }, managedHost });
  const run = value => prepareRequest(f.store, request, { observe: observed, checkHost() {}, trustKey: () => 'dashboard.pem', probe: async () => value });
  const codes = async value => (await run(value)).issues.map(i => i.code);
  const all = { supported: true, modes: ['claude', 'codex', 'both'] };
  // 지원하지 않는 code-agent 에서는 프로젝트 실행 방식으로 대신 실행하지 않는다
  assert.deepEqual(await codes(hello(managed())), ['host-selection-unsupported', 'control-pairing-available']);
  assert.deepEqual(await codes(hello(managed({ runSelection: { supported: true, modes: ['claude'] } }))), ['host-not-installed', 'control-pairing-available']);
  const notReady = await run(hello(managed({ runSelection: all, hosts: { claude: { ready: true, problems: [] }, codex: { ready: false, problems: [{ code: 'codex-project-untrusted', message: 'Codex 프로젝트 신뢰 필요' }] } } })));
  assert.deepEqual(notReady.issues.map(i => i.code), ['host-not-ready', 'control-pairing-available']); assert.match(notReady.issues[0].message, /codex.*Codex 프로젝트 신뢰 필요/);
  // 고른 주 host 가 준비되면 프로젝트 기본 호스트의 문제는 이번 요청을 막지 않는다
  assert.deepEqual(await codes(hello(managed({ ready: false, problems: [{ code: 'hooks-missing', message: 'Claude hook 없음' }], runSelection: all, hosts: { codex: { ready: true, problems: [] } } }))), ['control-pairing-available']);
});

test('교차 검증 계획은 반려 지적을 다음 회차 피드백으로 넘기고 승인된 계획만 활성화한다', async t => {
  const f = setup(t, { plan: false }), projectId = f.fixture.projects[0].id;
  const request = acceptRequest(f.store, { targetType: 'project', targetId: projectId, goal: '교차 계획', host: { mode: 'both', main: 'claude' } }).request;
  new Knowledge(f.store).prepare(projectId);
  const prompts = [];
  const main = { name: 'claude', async generate({ prompt, context }) { prompts.push(prompt); return { data: answerFor(context) }; } };
  let reviews = 0;
  const reviewer = { name: 'codex', async generate() {
    return { data: reviews++ === 0 ? { verdict: 'reject', issues: [{ summary: '통합 검증 근거 부족', reference: 'plan.tasks' }] } : { verdict: 'approve', issues: [] } };
  } };
  const result = await new Planner(f.store).analyze(request.id, new CrossProvider(main, reviewer), { expectedRevision: f.store.need('mission', request.id).revision });
  assert.equal(result.mission.state, 'planned');
  assert.equal(result.analysis.provider, 'claude+codex');
  assert.equal(result.analysis.passes[0].error.code, 'cross-review-rejected'); assert.ok(result.analysis.passes[0].data, '반려된 초안을 기록한다');
  assert.equal(result.analysis.passes[1].review.verdict, 'approve');
  assert.match(prompts[1], /통합 검증 근거 부족/);
});

test('요청에서 고른 host 는 새 실행 접수에만 실려 code-agent 에 전달된다', async t => {
  const f = controlFixture(t);
  f.store.put('target-request', { id: f.mission.id, execution: { mode: 'both', main: 'codex' }, provider: 'codex', state: 'running', projectIds: [] });
  const result = await new LiveWorkflow(f.store).run(f.mission.id, f.host, f.provider);
  assert.equal(result.mission.state, 'succeeded', JSON.stringify(result.blockers));
  const submits = f.calls.filter(c => c.type === 'submit');
  assert.ok(submits.some(c => c.payload.mode === 'start')); assert.ok(submits.some(c => c.payload.mode === 'continue'));
  for (const c of submits) assert.deepEqual(c.payload.execution, c.payload.mode === 'start' ? { mode: 'both', main: 'codex' } : undefined);
});

test('교차 검토가 반려한 위임 판단은 보내지 않고 지적과 함께 사람에게 넘긴다', async t => {
  const f = controlFixture(t);
  const reviewer = { name: 'codex', async generate() { return { data: { verdict: 'reject', issues: [{ summary: '검증 근거와 다른 승인', reference: 'masterVerification' }] } }; } };
  const judge = new CrossProvider(f.provider, reviewer);
  await new LiveWorkflow(f.store).run(f.mission.id, f.host, judge);
  assert.equal(f.calls.filter(c => c.type === 'decide' || c.type === 'answer').length, 0, '반려된 판단은 code-agent 에 보내지 않는다');
  const escalations = new DecisionDelegation(f.store).escalations(f.mission.id);
  assert.ok(escalations.length);
  assert.ok(escalations.every(e => /교차 검토가 fake-judge 결과를 반려했습니다: 검증 근거와 다른 승인/.test(e.reason)), JSON.stringify(escalations.map(e => e.reason)));
});
