import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { controlFixture } from './control-fixture.mjs';
import { LiveWorkflow } from '../packages/orchestrator/drive.mjs';
import { BUNDLE_KIND, planKnowledge, sealBundle, sourceState } from '../packages/knowledge/evidence.mjs';
import { knowledgeDigest } from '../packages/knowledge/handoff.mjs';
import { bindingOf, setBinding } from '../packages/knowledge/retrieval.mjs';
import { hostPrompt } from '../packages/runner/host-context.mjs';
import { validatePlan } from '../packages/domain/contracts.mjs';

/**
 * 배정 경계 시험 — code-agent는 control-fixture의 모의 통신 계약이다(실제 code-agent 통합은 knowledge-integration.test.mjs).
 * 송신 결정은 공통 계약(agent-knowledge docs/integration.md 「송신 결정」)을 따른다: 필수 근거는 진행 게이트(requiredGate)를 공지하고 지금 형식 2를 받는
 * 수신자에게만 형식 2로 실제 start submit에 싣고, 보낼 수 없으면 그 작업만 보류한다. 선택 참조만 있으면 함께 쓰는 형식으로 보내거나 빼고 기존 경로로 진행한다.
 */
/** code-agent 3c5bbac hello 공지(형식 1, 상한 20, 게이트 없음) · 진행 게이트 빌드의 색인 대조 등록(지금 형식 1·2) · 같은 빌드의 기본 등록(지금 형식 1) */
const OLD = { one: {} }, GATE = { one: { gate: true } }, GATE_V1 = { one: { gate: true, versions: [1] } };
const sha = value => createHash('sha256').update(value).digest('hex');
const git = (path, args, encoding = 'utf8') => execFileSync('git', ['-C', path, '-c', 'core.autocrlf=false', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { encoding, stdio: 'pipe' });
function commitFile(path, file, text) {
  mkdirSync(join(path, file, '..'), { recursive: true });
  writeFileSync(join(path, file), text);
  git(path, ['add', file]); git(path, ['commit', '-q', '-m', `update ${file}`]);
}
/** 계획 활성화 뒤의 enabled 계획을 만든다: edit-one 작업이 docs/rules.md 1행 항목을 지식 참조로 쓴다 */
const V2_INDEX = '0123456789abcdef0123456789abcdef';
/** v2: 형식 2 생산자 묶음(색인 식별 포함)인가 — 필수 근거 인계는 형식 2 묶음이어야 한다(기본) */
function withKnowledge(f, { mode = 'enabled', confirmed = true, tamper = false, required = true, declare = true, v2 = true } = {}) {
  const one = f.projects.find(p => p.id === 'one');
  commitFile(one.path, 'docs/rules.md', '﻿취소는 24시간 안에만 허용한다.\r\n보조 설명\r\n');
  const commit = git(one.path, ['rev-parse', 'HEAD']).trim(), blobSha = git(one.path, ['rev-parse', 'HEAD:docs/rules.md']).trim();
  const bytes = git(one.path, ['cat-file', 'blob', blobSha], 'buffer');
  const excerpt = new TextDecoder('utf-8', { fatal: true }).decode(bytes).split(/\r\n|\n|\r/).slice(0, 1).join('\n');
  const item = { ref: 'kitem:one:0123456789abcdef', forProject: 'one', scopeRole: 'project', itemId: 'one-ak:docs/rules.md#r', key: null, producerProjectId: 'one-ak', sourceId: 'one-ak',
    kind: 'business-rule', unit: 'section', title: '취소', headingPath: ['취소'], section: 'policies', status: confirmed ? 'confirmed_policy' : 'unverified', confirmed, conflicts: 0,
    path: 'docs/rules.md', startLine: 1, endLine: 1, excerptStartLine: 1, excerptEndLine: 1, commit, blobSha, documentSha256: sha(bytes), itemSha256: sha(excerpt), excerptTruncated: false, excerpt };
  if (v2) Object.assign(item, { indexId: V2_INDEX, indexGeneration: 3, handle: 'ak-0123456789abcdef0123' });
  const knowledge = { notice: 'n', retrieval: { contract: v2 ? 'agent-knowledge.search@2' : 'agent-knowledge.search@1', generation: 3, publishedAt: '2026-11-10T00:00:00.000Z', settingsHash: 's', projects: [],
    ...(v2 ? { indexId: V2_INDEX } : {}) }, items: [item] };
  f.store.transaction(() => {
    const m = f.store.need('mission', f.mission.id);
    const bundle = sealBundle(f.store, m, 'fixture-run', knowledge);
    const plan = m.plans.at(-1);
    // required: 계획이 이 항목을 필수 의존으로 명시했는가. declare=false 는 필수 여부를 적지 않은 이전 계획(모두 필수로 본다)
    plan.proposal.tasks = plan.proposal.tasks.map(t => t.id === 'edit-one' ? { ...t, knowledgeRefs: [item.ref], ...(declare ? { knowledgeRequired: required ? [item.ref] : [] } : {}) } : t);
    plan.knowledge = planKnowledge(bundle, plan.proposal);
    f.store.put('mission', m, m.revision);
    if (tamper) f.store.put(BUNDLE_KIND, { ...bundle, knowledge: { ...knowledge, items: [{ ...item, excerpt: '변조' }] } }, bundle.revision);
  });
  setBinding(f.store, 'one', { mode, knowledgeProject: 'one-ak', revision: bindingOf(f.store, 'one')?.revision });
  return { one, item };
}
const attemptOf = (f, taskId) => f.store.need('mission', f.mission.id).attempts.find(a => a.taskId === taskId);
const stateOf = (f, taskId) => f.store.need('mission', f.mission.id).tasks.find(t => t.id === taskId).state;
const progressOf = (f, taskId) => f.engine.describe(f.mission.id).progress.tasks.find(t => t.taskId === taskId);
const submitsOf = (f, project) => f.calls.filter(c => c.type === 'submit' && c.project === project);
const eventTypes = f => f.store.events(f.mission.id).map(e => e.type);

test('필수 근거는 게이트 수신자에게 형식 2로 첫 start submit에 실제로 싣고, 접수·저장·정본 해시·게이트 판정을 기록하며 프롬프트·이어 실행에는 싣지 않는다', async t => {
  const f = controlFixture(t, { knowledge: GATE });
  const { item } = withKnowledge(f);
  const result = await new LiveWorkflow(f.store).run(f.mission.id, f.host, f.provider);
  assert.equal(result.mission.state, 'succeeded');
  const handoff = attemptOf(f, 'edit-one').knowledgeHandoff;
  assert.equal(handoff.status, 'prepared');
  assert.equal(handoff.version, 2);
  assert.deepEqual([handoff.receiver.requiredGate, handoff.receiver.gate, handoff.receiver.versions], [true, true, [1, 2]]);
  // 계획 근거(봉인 묶음 항목)와 같은 참조 — 생산자 항목 식별 그대로, 발췌·master 참조(kitem)·묶음 ID는 싣지 않는다
  assert.deepEqual(handoff.payload, { version: 2, refs: [{ indexId: V2_INDEX, indexGeneration: 3, itemId: item.itemId, itemSha256: item.itemSha256, commit: item.commit, sourceId: 'one-ak',
    path: 'docs/rules.md', startLine: 1, endLine: 1, handle: item.handle, projectId: 'one-ak', documentSha256: item.documentSha256, blobSha: item.blobSha, required: true }] });
  assert.equal(handoff.digest, knowledgeDigest(handoff.payload));
  assert.equal(handoff.schema, 'master-agent.knowledge-handoff'); assert.equal(handoff.dependency, 'declared');
  assert.equal(handoff.dependsOnConfirmed, true); assert.deepEqual(handoff.sourceCheck, { unchanged: 1 });
  // 실제로 보낸 것: 첫 submit(start)만 knowledge 를 싣고 그 값은 시도에 고정한 payload 그대로다. 이어 실행·프롬프트에는 없다
  const [first, ...rest] = submitsOf(f, 'one').filter(c => c.payload.links.attemptId === attemptOf(f, 'edit-one').id);
  assert.ok(submitsOf(f, 'one').filter(c => c.payload.links.taskId === 'integrate').every(c => !Object.hasOwn(c.payload, 'knowledge')), '같은 프로젝트의 근거 없는 작업은 싣지 않는다');
  assert.equal(first.payload.mode, 'start');
  assert.deepEqual(first.payload.knowledge, handoff.payload);
  assert.ok(rest.length > 0 && rest.every(c => c.payload.mode === 'continue' && !Object.hasOwn(c.payload, 'knowledge')));
  assert.ok(submitsOf(f, 'one').every(c => !c.payload.prompt.includes('knowledgeRefs') && !c.payload.prompt.includes('knowledgeRequired') && !c.payload.prompt.includes('kitem:') && !c.payload.prompt.includes(item.excerpt)));
  assert.ok(submitsOf(f, 'two').every(c => !Object.hasOwn(c.payload, 'knowledge')), '지식 참조가 없는 작업은 기존 submit 그대로다');
  // 수신자가 저장한 작업 고정 인계 = 보낸 인계, 접수 영수증의 정본 해시 = 보낸 인계의 해시
  assert.deepEqual(Object.values(f.sims.one.works)[0].knowledge.refs, handoff.payload.refs);
  assert.deepEqual([handoff.delivery.state, handoff.delivery.acceptedRefs, handoff.delivery.stored], ['accepted', 1, 'matched']);
  const run = f.store.list('control-run').find(r => r.attemptId === attemptOf(f, 'edit-one').id && r.knowledge);
  assert.deepEqual([run.knowledge.state, run.knowledge.digestMatched, run.knowledge.receiverDigest, run.knowledge.receipt, run.knowledge.receiverVersion], ['accepted', true, handoff.digest, 'stored', 2]);
  // 게이트 판정(작업이 열린 뒤 verified)은 근거 대조가 끝났다는 뜻일 뿐 승인·테스트·완료 증거가 아니다
  assert.deepEqual([handoff.delivery.verification.state, handoff.delivery.verification.source], ['passed', 'code-agent-gate']);
  assert.equal(progressOf(f, 'edit-one').knowledge.verification, 'passed');
  for (const type of ['knowledge-handoff-sent', 'knowledge-handoff-accepted', 'knowledge-handoff-checked', 'knowledge-handoff-recorded']) assert.ok(eventTypes(f).includes(type), type);
  assert.ok(!Object.hasOwn(attemptOf(f, 'edit-two'), 'knowledgeHandoff'), '지식 참조가 없는 작업은 기존 기록 그대로다');
  const dispatch = f.store.list('decision', { missionId: f.mission.id }).find(d => d.action === 'dispatch-live' && d.codeAgentWorkId === attemptOf(f, 'edit-one').codeAgentWorkId);
  assert.deepEqual([dispatch.knowledge.status, dispatch.knowledge.sent, dispatch.knowledge.sentRequired, dispatch.knowledge.hash], ['prepared', 1, 1, handoff.hash]);
  assert.ok(dispatch.evidence.every(e => !e.startsWith('kitem:')), '지식 참조는 배정 evidence가 아니다');
  assert.ok(f.store.list(BUNDLE_KIND, { missionId: f.mission.id }).every(b => b.state === 'released' && b.releaseReason === 'mission-finished'));
});

test('호환: 게이트 이전 수신자(3c5bbac)에게는 선택 참조만 형식 1로 실제로 보내고, 그 확인 결과는 진행을 막지 않는다', async t => {
  const f = controlFixture(t, { knowledge: OLD });
  const { item } = withKnowledge(f, { required: false });
  const result = await new LiveWorkflow(f.store).run(f.mission.id, f.host, f.provider);
  assert.equal(result.mission.state, 'succeeded');
  const handoff = attemptOf(f, 'edit-one').knowledgeHandoff;
  assert.deepEqual([handoff.status, handoff.version, handoff.sentRequired, handoff.receiver.requiredGate], ['prepared', 1, 0, false]);
  assert.deepEqual(handoff.payload, { version: 1, refs: [{ itemId: item.itemId, generation: 3, commit: item.commit, itemSha256: item.itemSha256, required: false }] });
  assert.deepEqual(submitsOf(f, 'one').find(c => c.payload.links.attemptId === attemptOf(f, 'edit-one').id).payload.knowledge, handoff.payload);
  assert.deepEqual([handoff.delivery.state, handoff.delivery.acceptedRefs, handoff.delivery.stored], ['accepted', 1, 'matched']);
  assert.deepEqual([handoff.delivery.verification.state, handoff.delivery.verification.reason], ['not-reported', 'receiver-without-gate'], '게이트가 없으면 확인 결과를 통신 계약으로 받지 않는다');
});

test('필수 근거를 보낼 수 없으면(공지 없음·미수락·통신 실패·게이트 없음·형식 2 불가) 그 작업만 시도 없이 보류하고 다른 작업은 진행한다', async t => {
  for (const [knowledge, code, options = {}, label = code] of [[{}, 'knowledge-handoff-unsupported'], [{ one: { gate: true, accepted: false } }, 'knowledge-handoff-not-accepted'],
    [{ one: 'unreachable' }, 'knowledge-receiver-unreachable'], [OLD, 'knowledge-handoff-ungated'], [GATE_V1, 'knowledge-handoff-version', {}, '수신자가 지금 형식 1만 받음'],
    [GATE, 'knowledge-handoff-version', { v2: false }, '형식 1 생산자 묶음']]) {
    await t.test(label, async t => {
      const f = controlFixture(t, { knowledge });
      withKnowledge(f, options);
      const result = await new LiveWorkflow(f.store).run(f.mission.id, f.host, f.provider);
      assert.notEqual(result.mission.state, 'succeeded');
      assert.equal(stateOf(f, 'edit-one'), 'queued');
      assert.ok(!attemptOf(f, 'edit-one'), '시도를 만들지 않는다');
      assert.equal(submitsOf(f, 'one').length, 0);
      assert.equal(f.store.need('workflow-observation', `${f.mission.id}:edit-one`).code, code);
      assert.ok(f.store.events(f.mission.id).some(e => e.type === 'knowledge-handoff-held' && e.code === code && e.taskId === 'edit-one'));
      assert.equal(stateOf(f, 'edit-two'), 'succeeded', '다른 작업은 계속한다');
    });
  }
});

test('필수 여부를 적지 않은 이전 계획은 모든 참조를 필수로 본다(조용히 낮추지 않는다)', async t => {
  const f = controlFixture(t);
  withKnowledge(f, { declare: false });
  await new LiveWorkflow(f.store).run(f.mission.id, f.host, f.provider);
  assert.equal(f.store.need('workflow-observation', `${f.mission.id}:edit-one`).code, 'knowledge-handoff-unsupported');
  const held = f.store.events(f.mission.id).find(e => e.type === 'knowledge-handoff-held');
  assert.deepEqual([held.required, held.optional], [1, 0]);
});

test('선택 참조만 있으면 지식 인계 이전 수신자에게도 기존 경로로 배정한다(미전송 사유 기록)', async t => {
  const f = controlFixture(t);
  withKnowledge(f, { required: false });
  const result = await new LiveWorkflow(f.store).run(f.mission.id, f.host, f.provider);
  assert.equal(result.mission.state, 'succeeded');
  const handoff = attemptOf(f, 'edit-one').knowledgeHandoff;
  assert.deepEqual([handoff.status, handoff.reason, handoff.required], ['not-sent', 'knowledge-handoff-unsupported', 0]);
  assert.ok(submitsOf(f, 'one').every(c => !Object.hasOwn(c.payload, 'knowledge')));
});

test('접수 영수증이 보낸 참조와 다르면 그 시도를 막고 이어 실행·검증을 하지 않는다', async t => {
  const f = controlFixture(t, { knowledge: GATE, receipt: { one: 5 } });
  withKnowledge(f);
  const result = await new LiveWorkflow(f.store).run(f.mission.id, f.host, f.provider);
  assert.notEqual(result.mission.state, 'succeeded');
  const attempt = attemptOf(f, 'edit-one');
  assert.equal(attempt.knowledgeHandoff.delivery.state, 'receipt-mismatch');
  assert.equal(attempt.state, 'blocked');
  assert.equal(submitsOf(f, 'one').length, 1, '같은 근거로 이어 가지 않는다');
  assert.equal(progressOf(f, 'edit-one').reason, 'knowledge-handoff-unconfirmed');
  assert.match(progressOf(f, 'edit-one').guidance, /확인하지 못했습니다/);
  assert.equal(stateOf(f, 'edit-two'), 'succeeded');
});

test('게이트가 재계획 판정(근거 불일치)이면 그 작업만 막고 재시도·재검증하지 않는다', async t => {
  const f = controlFixture(t, { knowledge: GATE, gate: { one: { initial: 'replan' } } });
  withKnowledge(f);
  const workflow = new LiveWorkflow(f.store);
  await workflow.run(f.mission.id, f.host, f.provider);
  await workflow.run(f.mission.id, f.host, f.provider);
  assert.equal(f.store.need('workflow-observation', `${f.mission.id}:edit-one`).code, 'knowledge-blocked');
  assert.equal(f.calls.filter(c => c.type === 'knowledge').length, 0, '근거가 맞지 않는 판정은 같은 참조로 다시 검증하지 않는다');
  assert.equal(stateOf(f, 'edit-two'), 'succeeded');
  assert.notEqual(f.store.need('mission', f.mission.id).state, 'succeeded');
});

test('게이트가 재검증 판정이면 같은 참조 재검증을 한 번만 요청하고, 통과하면 이어 가고 아니면 막는다', async t => {
  await t.test('재검증 통과 → 계속', async t => {
    const f = controlFixture(t, { knowledge: GATE, gate: { one: { initial: 'reverify', afterVerify: 'verified' } } });
    withKnowledge(f);
    const result = await new LiveWorkflow(f.store).run(f.mission.id, f.host, f.provider);
    assert.equal(result.mission.state, 'succeeded');
    const verify = f.calls.filter(c => c.type === 'knowledge');
    assert.equal(verify.length, 1);
    assert.deepEqual([verify[0].payload.action, verify[0].payload.workId, verify[0].commandId], ['verify', attemptOf(f, 'edit-one').codeAgentWorkId, `kv-${attemptOf(f, 'edit-one').id}`]);
    assert.equal(attemptOf(f, 'edit-one').knowledgeHandoff.reverify.state, 'passed');
    assert.ok(eventTypes(f).includes('knowledge-reverified'));
  });
  await t.test('재검증 뒤에도 미검증 → 한 번만, 그 작업만 막힘', async t => {
    const f = controlFixture(t, { knowledge: GATE, gate: { one: { initial: 'reverify', afterVerify: 'reverify' } } });
    withKnowledge(f);
    const workflow = new LiveWorkflow(f.store);
    await workflow.run(f.mission.id, f.host, f.provider);
    await workflow.run(f.mission.id, f.host, f.provider);
    assert.equal(f.calls.filter(c => c.type === 'knowledge').length, 1, '무한 재시도하지 않는다');
    assert.equal(attemptOf(f, 'edit-one').knowledgeHandoff.reverify.state, 'unverified');
    assert.equal(f.store.need('workflow-observation', `${f.mission.id}:edit-one`).code, 'knowledge-blocked');
    assert.equal(stateOf(f, 'edit-two'), 'succeeded');
  });
});

test('봉인 묶음 변조는 그 작업만 막고 다른 작업은 진행한다', async t => {
  const f = controlFixture(t);
  withKnowledge(f, { tamper: true });
  const result = await new LiveWorkflow(f.store).run(f.mission.id, f.host, f.provider);
  assert.notEqual(result.mission.state, 'succeeded');
  assert.equal(stateOf(f, 'edit-one'), 'queued');
  assert.equal(stateOf(f, 'edit-two'), 'succeeded');
  assert.equal(f.store.need('workflow-observation', `${f.mission.id}:edit-one`).code, 'knowledge-integrity');
  assert.ok(!attemptOf(f, 'edit-one'), '배정 기록을 만들지 않는다');
  assert.equal(f.calls.filter(c => c.type === 'submit' && c.project === 'one').length, 0);
});

test('확정 지식의 원본이 색인 뒤 바뀌면 그 작업만 막고, 미확정 항목·다른 줄 변경은 기록만 한다', async t => {
  await t.test('확정 항목 줄 변경 → 막힘', async t => {
    const f = controlFixture(t);
    const { one } = withKnowledge(f);
    commitFile(one.path, 'docs/rules.md', '취소는 48시간 안에만 허용한다.\n보조 설명\n');
    await new LiveWorkflow(f.store).run(f.mission.id, f.host, f.provider);
    assert.equal(stateOf(f, 'edit-one'), 'queued');
    assert.equal(f.store.need('workflow-observation', `${f.mission.id}:edit-one`).code, 'knowledge-source-changed');
    assert.equal(stateOf(f, 'edit-two'), 'succeeded');
  });
  await t.test('확정 항목 삭제 → 막힘', async t => {
    const f = controlFixture(t);
    const { one } = withKnowledge(f);
    git(one.path, ['rm', '-q', 'docs/rules.md']); git(one.path, ['commit', '-q', '-m', 'remove']);
    await new LiveWorkflow(f.store).run(f.mission.id, f.host, f.provider);
    assert.equal(f.store.need('workflow-observation', `${f.mission.id}:edit-one`).code, 'knowledge-source-changed');
  });
  await t.test('다른 줄만 변경 → unchanged-lines로 진행', async t => {
    const f = controlFixture(t, { knowledge: GATE });
    const { one } = withKnowledge(f);
    commitFile(one.path, 'docs/rules.md', '﻿취소는 24시간 안에만 허용한다.\n바뀐 보조 설명\n');
    const result = await new LiveWorkflow(f.store).run(f.mission.id, f.host, f.provider);
    assert.equal(result.mission.state, 'succeeded');
    assert.deepEqual(attemptOf(f, 'edit-one').knowledgeHandoff.sourceCheck, { 'unchanged-lines': 1 });
  });
  await t.test('미확정 선택 항목 변경 → 기록만', async t => {
    const f = controlFixture(t, { knowledge: OLD });
    const { one } = withKnowledge(f, { confirmed: false, required: false });
    commitFile(one.path, 'docs/rules.md', '전혀 다른 내용\n');
    const result = await new LiveWorkflow(f.store).run(f.mission.id, f.host, f.provider);
    assert.equal(result.mission.state, 'succeeded');
    assert.deepEqual(attemptOf(f, 'edit-one').knowledgeHandoff.sourceCheck, { changed: 1 });
    assert.equal(attemptOf(f, 'edit-one').knowledgeHandoff.dependsOnConfirmed, false);
  });
});

test('연결을 꺼도 이미 승인된 계획이 기대는 지식의 무결성·원본 검사는 그대로 한다(생산자 호출 없음, 기록 보존)', async t => {
  await t.test('off·선택 참조 → 기존 경로로 배정, 미전송 사유만 다르다', async t => {
    const f = controlFixture(t, { knowledge: OLD });
    withKnowledge(f, { mode: 'off', required: false });
    const result = await new LiveWorkflow(f.store).run(f.mission.id, f.host, f.provider);
    assert.equal(result.mission.state, 'succeeded');
    const handoff = attemptOf(f, 'edit-one').knowledgeHandoff;
    assert.equal(handoff.status, 'not-sent'); assert.equal(handoff.reason, 'knowledge-disabled'); assert.deepEqual(handoff.sourceCheck, { unchanged: 1 });
    assert.ok(submitsOf(f, 'one').every(c => !Object.hasOwn(c.payload, 'knowledge')));
    assert.equal(bindingOf(f.store, 'one').knowledgeProject, 'one-ak');
  });
  await t.test('off·필수 의존 → 생산자 호출 없이 이미 승인된 필수 근거는 그대로 인계한다', async t => {
    const f = controlFixture(t, { knowledge: GATE });
    withKnowledge(f, { mode: 'off' });
    const result = await new LiveWorkflow(f.store).run(f.mission.id, f.host, f.provider);
    assert.equal(result.mission.state, 'succeeded');
    const handoff = attemptOf(f, 'edit-one').knowledgeHandoff;
    assert.deepEqual([handoff.status, handoff.sentRequired, handoff.version], ['prepared', 1, 2]);
    assert.deepEqual(submitsOf(f, 'one')[0].payload.knowledge, handoff.payload);
  });
  await t.test('off·묶음 변조 → 그 작업만 막힘', async t => {
    const f = controlFixture(t);
    withKnowledge(f, { mode: 'off', tamper: true });
    await new LiveWorkflow(f.store).run(f.mission.id, f.host, f.provider);
    assert.equal(f.store.need('workflow-observation', `${f.mission.id}:edit-one`).code, 'knowledge-integrity');
    assert.equal(stateOf(f, 'edit-two'), 'succeeded');
  });
  await t.test('off·확정 원본 변경 → 그 작업만 막힘', async t => {
    const f = controlFixture(t);
    const { one } = withKnowledge(f, { mode: 'off' });
    commitFile(one.path, 'docs/rules.md', '바뀐 원본\n');
    await new LiveWorkflow(f.store).run(f.mission.id, f.host, f.provider);
    assert.equal(f.store.need('workflow-observation', `${f.mission.id}:edit-one`).code, 'knowledge-source-changed');
  });
});

test('계획 뒤 연결 범위가 바뀌면(다른 지식 프로젝트로 재연결) 그 작업만 재분석 대상으로 막는다', async t => {
  const f = controlFixture(t);
  withKnowledge(f);
  const binding = bindingOf(f.store, 'one');
  setBinding(f.store, 'one', { mode: 'enabled', knowledgeProject: 'other-ak', revision: binding.revision });
  await new LiveWorkflow(f.store).run(f.mission.id, f.host, f.provider);
  assert.equal(f.store.need('workflow-observation', `${f.mission.id}:edit-one`).code, 'knowledge-scope-changed');
  assert.equal(stateOf(f, 'edit-one'), 'queued');
  assert.equal(stateOf(f, 'edit-two'), 'succeeded');
});

test('커밋하지 않은 작업 트리 변경도 확정 지식 원본 변경으로 본다(선행 작업의 local-files 인계 등)', async t => {
  const f = controlFixture(t);
  const { one } = withKnowledge(f);
  writeFileSync(join(one.path, 'docs/rules.md'), '취소는 72시간 안에만 허용한다.\n');
  await new LiveWorkflow(f.store).run(f.mission.id, f.host, f.provider);
  assert.equal(f.store.need('workflow-observation', `${f.mission.id}:edit-one`).code, 'knowledge-source-changed');
});

test('색인 blob과 다른 원본을 읽거나 디코드할 수 없으면 확인 불가가 아니라 변경이다', async t => {
  await t.test('UTF-8이 아닌 내용', t => {
    const f = controlFixture(t);
    const { one, item } = withKnowledge(f);
    writeFileSync(join(one.path, 'docs/rules.md'), Buffer.from([0xc3, 0x28, 0x0a]));
    git(one.path, ['add', 'docs/rules.md']); git(one.path, ['commit', '-q', '-m', 'binary']);
    assert.equal(sourceState(one.path, item), 'changed');
  });
  await t.test('같은 이름의 폴더로 바뀜', t => {
    const f = controlFixture(t);
    const { one, item } = withKnowledge(f);
    git(one.path, ['rm', '-q', 'docs/rules.md']);
    commitFile(one.path, 'docs/rules.md/inner.md', '안쪽\n');
    assert.ok(['changed', 'missing'].includes(sourceState(one.path, item)));
  });
});

test('계획 검증은 분석 때 원본이 이미 바뀐 확정 항목을 작업 근거로 받지 않는다', t => {
  const f = controlFixture(t);
  const { item } = withKnowledge(f);
  const m = f.store.need('mission', f.mission.id), plan = m.plans.at(-1).proposal, projects = f.projects.map(p => f.store.need('project', p.id));
  for (const [sourceState, ok] of [['changed', false], ['missing', false], ['unchanged-lines', true], ['unverifiable', true]]) {
    const run = () => validatePlan(plan, m, projects, { knowledgeItems: [{ ...item, sourceState }] });
    if (ok) assert.doesNotThrow(run); else assert.throws(run, e => e.code === 'knowledge-source-stale');
  }
  // 미확정 항목은 원본이 바뀌어도 선택 참조(탐색 근거)로 남을 수 있다(배정에서 기록만 한다). 필수 의존이면 확정 여부와 무관하게 받지 않는다
  const unconfirmed = { ...item, confirmed: false, status: 'unverified', sourceState: 'changed' };
  assert.throws(() => validatePlan(plan, m, projects, { knowledgeItems: [unconfirmed] }), e => e.code === 'knowledge-source-stale');
  const optional = { ...plan, tasks: plan.tasks.map(t => t.id === 'edit-one' ? { ...t, knowledgeRequired: [] } : t) };
  assert.doesNotThrow(() => validatePlan(optional, m, projects, { knowledgeItems: [unconfirmed] }));
});

test('원본 확인은 같은 저장소의 색인 커밋을 찾지 못하면 검증 불가로만 기록한다', t => {
  const f = controlFixture(t);
  const { one, item } = withKnowledge(f);
  assert.equal(sourceState(one.path, item), 'unchanged');
  assert.equal(sourceState(one.path, { ...item, commit: 'f'.repeat(40) }), 'unverifiable');
  assert.equal(sourceState(one.path, { ...item, blobSha: 'e'.repeat(40) }), 'unverifiable', '같은 경로의 다른 원본(다른 저장소)은 대조하지 않는다');
  assert.equal(sourceState(f.root, item), 'unverifiable', '저장소가 아닌 경로');
});

test('hostPrompt는 작업의 knowledgeRefs·knowledgeRequired만 빼고 나머지 키 순서를 유지한다', () => {
  const task = { id: 't1', projectId: 'p', goal: 'g', references: ['source:p:a@1'], knowledgeRefs: ['kitem:p:1'], knowledgeRequired: ['kitem:p:1'], verification: 'v' };
  const ticket = { missionId: 'm', planVersion: 1, taskId: 't1', id: 'a1', codeAgentWorkId: 'MA-1', goal: 'goal', criteria: [], task, inputEvidence: [], inputContracts: [] };
  const { knowledgeRefs: _refs, knowledgeRequired: _required, ...plain } = task;
  assert.equal(hostPrompt(ticket), hostPrompt({ ...ticket, task: plain }));
  assert.ok(!hostPrompt(ticket).includes('kitem:'));
});
