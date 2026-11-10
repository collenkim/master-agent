import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { controlFixture } from './control-fixture.mjs';
import { LiveWorkflow } from '../packages/orchestrator/drive.mjs';
import { BUNDLE_KIND, planKnowledge, sealBundle, sourceState } from '../packages/knowledge/evidence.mjs';
import { bindingOf, setBinding } from '../packages/knowledge/retrieval.mjs';
import { hostPrompt } from '../packages/runner/host-context.mjs';
import { validatePlan } from '../packages/domain/contracts.mjs';

/**
 * 배정 경계 시험 — code-agent는 control-fixture의 모의 통신 계약이다(실제 code-agent 통합이 아니다).
 * 지식 인계 블록은 code-agent와 합의한 계약이 없어 보내지 않는다는 점을 고정한다.
 */
const sha = value => createHash('sha256').update(value).digest('hex');
const git = (path, args, encoding = 'utf8') => execFileSync('git', ['-C', path, '-c', 'core.autocrlf=false', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { encoding, stdio: 'pipe' });
function commitFile(path, file, text) {
  mkdirSync(join(path, file, '..'), { recursive: true });
  writeFileSync(join(path, file), text);
  git(path, ['add', file]); git(path, ['commit', '-q', '-m', `update ${file}`]);
}
/** 계획 활성화 뒤의 enabled 계획을 만든다: edit-one 작업이 docs/rules.md 1행 항목을 지식 참조로 쓴다 */
function withKnowledge(f, { mode = 'enabled', confirmed = true, tamper = false } = {}) {
  const one = f.projects.find(p => p.id === 'one');
  commitFile(one.path, 'docs/rules.md', '﻿취소는 24시간 안에만 허용한다.\r\n보조 설명\r\n');
  const commit = git(one.path, ['rev-parse', 'HEAD']).trim(), blobSha = git(one.path, ['rev-parse', 'HEAD:docs/rules.md']).trim();
  const bytes = git(one.path, ['cat-file', 'blob', blobSha], 'buffer');
  const excerpt = new TextDecoder('utf-8', { fatal: true }).decode(bytes).split(/\r\n|\n|\r/).slice(0, 1).join('\n');
  const item = { ref: 'kitem:one:0123456789abcdef', forProject: 'one', scopeRole: 'project', itemId: 'one-ak:docs/rules.md#r', key: null, producerProjectId: 'one-ak', sourceId: 'one-ak',
    kind: 'business-rule', unit: 'section', title: '취소', headingPath: ['취소'], section: 'policies', status: confirmed ? 'confirmed_policy' : 'unverified', confirmed, conflicts: 0,
    path: 'docs/rules.md', startLine: 1, endLine: 1, excerptStartLine: 1, excerptEndLine: 1, commit, blobSha, documentSha256: sha(bytes), itemSha256: sha(excerpt), excerptTruncated: false, excerpt };
  const knowledge = { notice: 'n', retrieval: { contract: 'agent-knowledge.search@1', generation: 3, publishedAt: '2026-11-10T00:00:00.000Z', settingsHash: 's', projects: [] }, items: [item] };
  f.store.transaction(() => {
    const m = f.store.need('mission', f.mission.id);
    const bundle = sealBundle(f.store, m, 'fixture-run', knowledge);
    const plan = m.plans.at(-1);
    plan.proposal.tasks = plan.proposal.tasks.map(t => t.id === 'edit-one' ? { ...t, knowledgeRefs: [item.ref] } : t);
    plan.knowledge = planKnowledge(bundle, plan.proposal);
    f.store.put('mission', m, m.revision);
    if (tamper) f.store.put(BUNDLE_KIND, { ...bundle, knowledge: { ...knowledge, items: [{ ...item, excerpt: '변조' }] } }, bundle.revision);
  });
  setBinding(f.store, 'one', { mode, knowledgeProject: 'one-ak', revision: bindingOf(f.store, 'one')?.revision });
  return { one, item };
}
const attemptOf = (f, taskId) => f.store.need('mission', f.mission.id).attempts.find(a => a.taskId === taskId);
const stateOf = (f, taskId) => f.store.need('mission', f.mission.id).tasks.find(t => t.id === taskId).state;

test('enabled 작업은 봉인 묶음·원본을 확인하고 인계 블록을 만들되 보내지 않으며 프롬프트에 숨기지 않는다', async t => {
  const f = controlFixture(t);
  withKnowledge(f);
  const result = await new LiveWorkflow(f.store).run(f.mission.id, f.host, f.provider);
  assert.equal(result.mission.state, 'succeeded');
  const submits = f.calls.filter(c => c.type === 'submit');
  assert.ok(submits.length > 0);
  assert.ok(submits.every(c => !c.payload.prompt.includes('knowledgeRefs') && !c.payload.prompt.includes('kitem:') && !Object.hasOwn(c.payload, 'knowledge')));
  assert.ok(submits.every(c => Object.keys(c.payload).every(k => ['mode', 'sessionId', 'execution', 'prompt', 'links'].includes(k))), 'submit payload에 새 키를 넣지 않는다');
  const handoff = attemptOf(f, 'edit-one').knowledgeHandoff;
  assert.equal(handoff.status, 'not-sent'); assert.equal(handoff.reason, 'no-agreed-contract');
  assert.equal(handoff.schema, 'master-agent.knowledge-handoff'); assert.equal(handoff.count, 1); assert.equal(handoff.withinLimits, true);
  assert.equal(handoff.dependsOnConfirmed, true); assert.deepEqual(handoff.sourceCheck, { unchanged: 1 });
  assert.ok(!Object.hasOwn(attemptOf(f, 'edit-two'), 'knowledgeHandoff'), '지식 참조가 없는 작업은 기존 기록 그대로다');
  const dispatch = f.store.list('decision', { missionId: f.mission.id }).find(d => d.action === 'dispatch-live' && d.codeAgentWorkId === attemptOf(f, 'edit-one').codeAgentWorkId);
  assert.equal(dispatch.knowledge.status, 'not-sent');
  assert.ok(dispatch.evidence.every(e => !e.startsWith('kitem:')), '지식 참조는 배정 evidence가 아니다');
  // 종료된 목표의 묶음 본문은 남기지 않는다
  assert.ok(f.store.list(BUNDLE_KIND, { missionId: f.mission.id }).every(b => b.state === 'released' && b.releaseReason === 'mission-finished'));
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
    const f = controlFixture(t);
    const { one } = withKnowledge(f);
    commitFile(one.path, 'docs/rules.md', '﻿취소는 24시간 안에만 허용한다.\n바뀐 보조 설명\n');
    const result = await new LiveWorkflow(f.store).run(f.mission.id, f.host, f.provider);
    assert.equal(result.mission.state, 'succeeded');
    assert.deepEqual(attemptOf(f, 'edit-one').knowledgeHandoff.sourceCheck, { 'unchanged-lines': 1 });
  });
  await t.test('미확정 항목 변경 → 기록만', async t => {
    const f = controlFixture(t);
    const { one } = withKnowledge(f, { confirmed: false });
    commitFile(one.path, 'docs/rules.md', '전혀 다른 내용\n');
    const result = await new LiveWorkflow(f.store).run(f.mission.id, f.host, f.provider);
    assert.equal(result.mission.state, 'succeeded');
    assert.deepEqual(attemptOf(f, 'edit-one').knowledgeHandoff.sourceCheck, { changed: 1 });
    assert.equal(attemptOf(f, 'edit-one').knowledgeHandoff.dependsOnConfirmed, false);
  });
});

test('연결을 꺼도 이미 승인된 계획이 기대는 지식의 무결성·원본 검사는 그대로 한다(생산자 호출 없음, 기록 보존)', async t => {
  await t.test('off·정상 → 기존 경로로 배정, 미전송 사유만 다르다', async t => {
    const f = controlFixture(t);
    withKnowledge(f, { mode: 'off' });
    const result = await new LiveWorkflow(f.store).run(f.mission.id, f.host, f.provider);
    assert.equal(result.mission.state, 'succeeded');
    const handoff = attemptOf(f, 'edit-one').knowledgeHandoff;
    assert.equal(handoff.status, 'not-sent'); assert.equal(handoff.reason, 'knowledge-disabled'); assert.deepEqual(handoff.sourceCheck, { unchanged: 1 });
    assert.equal(bindingOf(f.store, 'one').knowledgeProject, 'one-ak');
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
  // 미확정 항목은 원본이 바뀌어도 탐색 근거로 남을 수 있다(배정에서 기록만 한다)
  assert.doesNotThrow(() => validatePlan(plan, m, projects, { knowledgeItems: [{ ...item, confirmed: false, status: 'unverified', sourceState: 'changed' }] }));
});

test('원본 확인은 같은 저장소의 색인 커밋을 찾지 못하면 검증 불가로만 기록한다', t => {
  const f = controlFixture(t);
  const { one, item } = withKnowledge(f);
  assert.equal(sourceState(one.path, item), 'unchanged');
  assert.equal(sourceState(one.path, { ...item, commit: 'f'.repeat(40) }), 'unverifiable');
  assert.equal(sourceState(one.path, { ...item, blobSha: 'e'.repeat(40) }), 'unverifiable', '같은 경로의 다른 원본(다른 저장소)은 대조하지 않는다');
  assert.equal(sourceState(f.root, item), 'unverifiable', '저장소가 아닌 경로');
});

test('hostPrompt는 작업의 knowledgeRefs만 빼고 나머지 키 순서를 유지한다', () => {
  const task = { id: 't1', projectId: 'p', goal: 'g', references: ['source:p:a@1'], knowledgeRefs: ['kitem:p:1'], verification: 'v' };
  const ticket = { missionId: 'm', planVersion: 1, taskId: 't1', id: 'a1', codeAgentWorkId: 'MA-1', goal: 'goal', criteria: [], task, inputEvidence: [], inputContracts: [] };
  const { knowledgeRefs: _refs, ...plain } = task;
  assert.equal(hostPrompt(ticket), hostPrompt({ ...ticket, task: plain }));
  assert.ok(!hostPrompt(ticket).includes('kitem:'));
});
