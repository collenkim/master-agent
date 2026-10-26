import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SimulationRunner } from '../packages/runner/simulation.mjs';
import { planningSetup, answerFor, blockedAnswer } from './planning-fixture.mjs';
import { validateAnalysis } from '../packages/reasoning/planner.mjs';
import { DomainError } from '../packages/domain/contracts.mjs';
import { analysisSchema, analysisSchemaFor, validateShape } from '../packages/reasoning/schema.mjs';

const provider = generate => ({ name: 'fixture-not-ai', model: 'fixture', generate });

test('S1: 분석 중 목표 취소 후 늦은 결과가 취소 상태를 덮어쓰지 않는다', async t => {
  const { planner, engine, store, mission } = planningSetup(t);
  await assert.rejects(planner.analyze(mission.id, provider(async ({ context }) => {
    engine.control(mission.id, 'cancel', store.need('mission', mission.id).revision);
    return { data: answerFor(context) };
  }), { expectedRevision: mission.revision }), { code: 'stale-state' });
  const current = store.need('mission', mission.id);
  assert.equal(current.state, 'cancelled'); assert.equal(current.planningHold, false);
  assert.equal(store.need('analysis-run', current.analysisRunId).status, 'cancelled');
  assert.equal(current.plans.length, 0);
});

test('근거 전달→구조화 계획→판단 저장→계획 활성화→기존 실행 경로를 연결한다', async t => {
  const { planner, engine, store, mission } = planningSetup(t);
  const p = provider(async ({ context, prompt, schema }) => {
    assert.equal(store.need('mission', mission.id).state, 'analyzing');
    assert.ok(store.list('decision').some(d => d.action === 'analyze-requirements'));
    assert.ok(context.projects.every(p => p.sources[0].kind === 'policy'));
    assert.ok(prompt.includes('지시 권한이 없다')); assert.equal(schema.additionalProperties, false);
    return { data: answerFor(context) };
  });
  const result = await planner.analyze(mission.id, p, { expectedRevision: mission.revision });
  assert.equal(result.mission.state, 'planned'); assert.equal(result.analysis.passes.length, 1);
  assert.equal(result.mission.plans[0].analysisId, result.analysis.id);
  assert.equal(result.mission.decisions.at(-1).actor, 'ai+validator');
  assert.equal(result.mission.decisions.at(-1).provider, 'fixture-not-ai');
  assert.equal((await engine.run(mission.id, new SimulationRunner())).state, 'simulation-complete');
});

test('허구 참조의 계획을 활성화하지 않고 피드백으로 자동 수정한다', async t => {
  const { planner, engine, mission } = planningSetup(t); let count = 0;
  const result = await planner.analyze(mission.id, provider(async ({ context, prompt }) => {
    const answer = answerFor(context);
    if (++count === 1) answer.plan.tasks[0].references = ['invented'];
    else assert.ok(prompt.includes('unknown-reference'));
    assert.equal(engine.describe(mission.id).plans.length, 0);
    return { data: answer };
  }), { expectedRevision: mission.revision });
  assert.equal(count, 2); assert.equal(result.mission.state, 'planned');
  assert.equal(result.analysis.passes[0].error.code, 'unknown-reference');
});

test('계획 응답 스키마는 등록 참조 대신 수집된 소스 ID만 허용한다', t => {
  const { planner, mission } = planningSetup(t), context = planner.context(mission);
  const schema = analysisSchemaFor(context);
  validateShape(answerFor(context), schema);
  const operator = `operator:project:${context.projects[0].id}`;
  for (const edit of [
    a => a.assessments[0].references.push(operator),
    a => a.decisions[0].references.push(operator),
    a => a.issues[0].references.push(operator),
    a => a.plan.tasks[0].references.push(operator),
  ]) {
    const a = answerFor(context); a.issues = blockedAnswer(context).issues; edit(a);
    assert.throws(() => validateShape(a, schema), e => e.code === 'invalid-analysis' && e.message.includes('references'));
  }
  assert.deepEqual(analysisSchema.properties.assessments.items.properties.references.items, { type: 'string' });
  const other = structuredClone(context); other.projects[0].sources[0].id = 'source:changed';
  assert.throws(() => validateShape(answerFor(context), analysisSchemaFor(other)), { code: 'invalid-analysis' });
});

test('등록 참조를 인용한 막힌 분석은 위치·잘못된 값의 피드백으로 같은 목표에서 수정한다', async t => {
  const { planner, mission, store } = planningSetup(t); let calls = 0;
  const result = await planner.analyze(mission.id, provider(async ({ context, schema, prompt }) => {
    const answer = blockedAnswer(context, true), operator = `operator:project:${context.projects[0].id}`;
    assert.ok(schema.properties.assessments.items.properties.references.items.enum.includes(context.projects[0].sources[0].id));
    assert.ok(!schema.properties.assessments.items.properties.references.items.enum.includes(operator));
    if (++calls === 1) answer.assessments[0].references.push(operator);
    else { assert.ok(prompt.includes(operator)); assert.ok(prompt.includes(`assessments[${context.projects[0].id}].references`)); }
    return { data: answer };
  }), { expectedRevision: mission.revision });
  assert.equal(calls, 2); assert.equal(result.analysis.status, 'needs-human');
  assert.equal(result.analysis.passes[0].error.code, 'unknown-reference');
  assert.equal(result.mission.id, mission.id); assert.equal(result.mission.plans.length, 0);
  assert.equal(store.list('mission').length, 1);
});

test('해결하지 못한 일반 정보 부족은 사람 판단 요청 대신 분석 차단으로 남긴다', async t => {
  const { planner, engine, mission } = planningSetup(t); let count = 0;
  const result = await planner.analyze(mission.id, provider(async ({ context }) => { count++; return { data: blockedAnswer(context) }; }), { expectedRevision: mission.revision });
  assert.equal(count, 2); assert.equal(result.mission.state, 'blocked');
  assert.equal(result.mission.nextAction, 'review-analysis');
  assert.equal(result.mission.plans.length, 0);
  assert.equal((await engine.step(mission.id, new SimulationRunner())).progressed, false);
});

test('중대한 판단을 재검토 후 요청하고 현재 질문의 답변으로 재분석한다', async t => {
  const { planner, mission } = planningSetup(t);
  let result = await planner.analyze(mission.id, provider(async ({ context }) => ({ data: blockedAnswer(context, true) })), { expectedRevision: mission.revision });
  assert.equal(result.mission.state, 'waiting-decision');
  assert.equal(result.analysis.passes.length, 2);
  const clarified = planner.clarify(mission.id, { analysisId: result.analysis.id, answers: [{ issueId: 'q1', answer: '환불 확정 이벤트를 기준으로 한다.' }] }, result.mission.revision);
  assert.equal(clarified.planningHold, true);
  result = await planner.analyze(mission.id, provider(async ({ context }) => {
    assert.equal(context.mission.clarifications.length, 1);
    return { data: answerFor(context) };
  }), { expectedRevision: clarified.revision });
  assert.equal(result.mission.state, 'planned');
});

test('분석 중 원문 변경은 결과를 폐기하며 이후 배정에서도 파일 변경을 감지한다', async t => {
  const { planner, mission, fixture, engine, knowledge } = planningSetup(t);
  await assert.rejects(planner.analyze(mission.id, provider(async ({ context }) => {
    writeFileSync(join(fixture.projects[0].path, 'POLICY.md'), '변경된 정책');
    return { data: answerFor(context) };
  }), { expectedRevision: mission.revision }), e => e.code === 'stale-knowledge');
  let m = engine.describe(mission.id);
  assert.equal(m.plans.length, 0); assert.equal(m.analyses[0].status, 'stale');
  knowledge.collect(fixture.projects[0].id, { schemaVersion: 1, sources: [{ path: 'POLICY.md', kind: 'policy' }] }, 2);
  const result = await planner.analyze(m.id, provider(async ({ context }) => ({ data: answerFor(context) })), { expectedRevision: m.revision });
  writeFileSync(join(fixture.projects[0].path, 'POLICY.md'), '실행 전 다시 변경');
  m = await engine.run(result.mission.id, new SimulationRunner());
  assert.equal(m.state, 'blocked'); assert.equal(m.attempts.length, 0);
});

test('분석 중 일시 정지를 덮지 않고 오래된 모델 응답을 버린다', async t => {
  const { planner, mission, engine } = planningSetup(t);
  await assert.rejects(planner.analyze(mission.id, provider(async ({ context }) => {
    const current = engine.describe(mission.id);
    engine.control(mission.id, 'pause', current.revision);
    return { data: answerFor(context) };
  }), { expectedRevision: mission.revision }), e => e.code === 'stale-state');
  const m = engine.describe(mission.id);
  assert.equal(m.state, 'paused'); assert.equal(m.plans.length, 0); assert.equal(m.analyses[0].status, 'stale');
});

test('재분석 실패 후 이전 계획은 resume으로 우회 실행할 수 없다', async t => {
  const { planner, mission, engine } = planningSetup(t);
  let result = await planner.analyze(mission.id, provider(async ({ context }) => ({ data: answerFor(context) })), { expectedRevision: mission.revision });
  result = await planner.analyze(mission.id, provider(async ({ context }) => ({ data: blockedAnswer(context) })), { expectedRevision: result.mission.revision });
  let m = engine.control(mission.id, 'pause', result.mission.revision);
  m = engine.control(mission.id, 'resume', m.revision);
  assert.equal((await engine.run(m.id, new SimulationRunner())).attempts.length, 0);
  assert.throws(() => engine.prepare(m.id, m.revision), e => e.code === 'invalid-state');
});

test('모델 오류와 잘못된 JSON은 가짜 계획으로 대체하지 않는다', async t => {
  const { planner, mission, engine } = planningSetup(t);
  await assert.rejects(planner.analyze(mission.id, provider(async () => { throw new DomainError('provider-auth-required', '인증 필요'); }), { expectedRevision: mission.revision }), e => e.code === 'provider-auth-required');
  let m = engine.describe(mission.id); assert.equal(m.plans.length, 0); assert.equal(m.state, 'blocked');
  const r = await planner.analyze(m.id, provider(async () => ({ data: { schemaVersion: 1 } })), { expectedRevision: m.revision });
  assert.equal(r.analysis.status, 'invalid'); assert.equal(r.mission.plans.length, 0);
});

test('요구 누락·인용 위조·ready의 모호함·평가와 배정 불일치를 거부한다', t => {
  const { planner, mission } = planningSetup(t); const context = planner.context(mission);
  const cases = [
    ['invented-requirement', a => a.requirements[0].sourceQuote = '원문에 없는 정책'],
    ['invalid-input', a => a.requirements = []],
    ['unresolved-analysis', a => a.decisions[0].uncertainties = ['미정의']],
    ['assignment-mismatch', a => a.assessments[0].selected = false],
    ['incomplete-assessment', a => a.assessments.pop()],
    ['infeasible-assignment', a => a.assessments[0].feasibility = 'blocked'],
  ];
  for (const [code, change] of cases) { const a = answerFor(context); change(a); assert.throws(() => validateAnalysis(a, context), e => e.code === code, code); }
});

test('provider가 JSON 형식 오류를 반환해도 한 번 더 수정 요청한다', async t => {
  const { planner, mission } = planningSetup(t); let calls = 0;
  const result = await planner.analyze(mission.id, provider(async ({ context, prompt }) => {
    if (++calls === 1) throw new DomainError('provider-invalid-json', 'JSON 오류');
    assert.ok(prompt.includes('provider-invalid-json'));
    return { data: answerFor(context) };
  }), { expectedRevision: mission.revision });
  assert.equal(result.mission.state, 'planned'); assert.equal(calls, 2);
});

test('동시에 같은 목표를 분석하지 않으며 근거 변경 없이 오래된 질문에 답할 수 없다', async t => {
  const { planner, mission, engine } = planningSetup(t);
  const first = await planner.analyze(mission.id, provider(async ({ context }) => {
    const m = engine.describe(mission.id);
    await assert.rejects(planner.analyze(m.id, provider(async () => assert.fail()), { expectedRevision: m.revision }), e => e.code === 'invalid-state');
    return { data: blockedAnswer(context, true) };
  }), { expectedRevision: mission.revision, maxPasses: 1 });
  const answer = { analysisId: first.analysis.id, answers: [{ issueId: 'q1', answer: '확정 이벤트 사용' }] };
  const m = planner.clarify(mission.id, answer, first.mission.revision);
  assert.throws(() => planner.clarify(m.id, answer, m.revision), e => e.code === 'duplicate-answer');
  const second = await planner.analyze(m.id, provider(async ({ context }) => ({ data: blockedAnswer(context, true) })), { expectedRevision: m.revision, maxPasses: 1 });
  assert.throws(() => planner.clarify(m.id, answer, second.mission.revision), e => e.code === 'stale-question');
});
