import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { planningSetup, answerFor, blockedAnswer } from './planning-fixture.mjs';
import { Planner, validateAnalysis } from '../packages/reasoning/planner.mjs';
import { KnowledgeRetrieval, queriesFor, setBinding, knowledgeStatus, bindingOf, SHADOW_KIND, LIMITS } from '../packages/knowledge/retrieval.mjs';
import { BUNDLE_KIND, verifiedBundle, taskEvidence } from '../packages/knowledge/evidence.mjs';
import { hash, validatePlan } from '../packages/domain/contracts.mjs';
import { analysisSchemaFor } from '../packages/reasoning/schema.mjs';
import { Store } from '../packages/storage/store.mjs';
import { callKnowledge } from '../packages/knowledge/agent-knowledge.mjs';
import { stopAnalysis } from '../packages/orchestrator/analysis-control.mjs';

/**
 * agent-knowledge 선택 연결 시험 — 생산자는 대역 CLI(tests/agent-knowledge-fake-cli.mjs)다. 실제 색인·검색 연동은 knowledge-real-cli.test.mjs.
 * AI provider도 고정 응답 대역이다. 계획 품질은 이 시험으로 검증하지 않는다.
 */
const FAKE = resolve('tests/agent-knowledge-fake-cli.mjs');
const cli = resolve('apps/cli/main.mjs');
const sha = text => createHash('sha256').update(text).digest('hex');
const commit = n => String(n).repeat(40).slice(0, 40);
const SOURCES = [
  { sourceId: 'order', projectId: 'order', commit: commit(1), requestedRef: 'HEAD' },
  { sourceId: 'payment', projectId: 'payment', commit: commit(2), requestedRef: 'main' },
  { sourceId: 'coupon', projectId: 'coupon', commit: commit(3), requestedRef: 'HEAD' },
  { sourceId: 'contracts', projectId: 'contracts', commit: commit(4), requestedRef: 'HEAD' },
];
const ITEMS = [
  { id: 'order:docs/policy.md#ORD-1', key: 'ORD-1', projectId: 'order', sourceId: 'order', kind: 'policy', path: 'docs/policy.md', startLine: 3, excerpt: '### `ORD-1` 주문 취소\n\n주문 취소는 24시간 안에만 허용한다.', match: ['주문', '취소'] },
  { id: 'order:docs/notes.md#환불-메모', projectId: 'order', sourceId: 'order', kind: 'reference', path: 'docs/notes.md', excerpt: '## 환불 메모\n\n미확정 메모', match: ['환불'], status: 'unverified', section: 'other' },
  { id: 'order:docs/mandatory.md#M-1', key: 'M-1', projectId: 'order', sourceId: 'order', kind: 'policy', path: 'docs/mandatory.md', excerpt: '### `M-1` 필수 정책\n\n로그에 카드번호를 남기지 않는다.', mandatory: true },
  { id: 'payment:docs/policy.md#PAY-1', key: 'PAY-1', projectId: 'payment', sourceId: 'payment', kind: 'policy', path: 'docs/policy.md', startLine: 3, excerpt: '### `PAY-1` 환불\n\n환불은 결제 취소 이벤트로 시작한다.', match: ['환불'] },
  { id: 'coupon:docs/rules.md#COU-1', key: 'COU-1', projectId: 'coupon', sourceId: 'coupon', kind: 'business-rule', path: 'docs/rules.md', excerpt: '### `COU-1` 쿠폰 복구\n\n취소 시 쿠폰을 복구한다.', match: ['쿠폰'] },
  { id: 'contracts:docs/events.md#CON-1', key: 'CON-1', projectId: 'contracts', sourceId: 'contracts', kind: 'contract', path: 'docs/events.md', excerpt: '### `CON-1` 주문 취소 이벤트\n\norder.cancelled', match: ['주문'], section: 'contracts' },
];
const BINDINGS = { 'test-order': { knowledgeProject: 'order', allowedLinks: [{ knowledgeProject: 'contracts', kinds: ['contract'] }] },
  'test-payment': { knowledgeProject: 'payment' }, 'test-coupon': { knowledgeProject: 'coupon' } };

function model(root, overrides = {}) {
  const log = join(root, 'ak-calls.jsonl');
  const value = { log, generation: 7, publishedAt: '2026-11-10T00:00:00.000Z', sources: SOURCES, items: ITEMS, ...overrides };
  const db = join(root, `ak-model-${Object.keys(overrides).join('-') || 'base'}.json`);
  writeFileSync(db, JSON.stringify(value));
  const rc = join(root, 'retrieval.yaml');
  if (!existsSync(rc)) writeFileSync(rc, 'schemaVersion: 1\n');
  return { log, env: { MASTER_AGENT_KNOWLEDGE_CLI: FAKE, MASTER_AGENT_KNOWLEDGE_DB: db, MASTER_AGENT_KNOWLEDGE_RETRIEVAL_CONFIG: rc, MASTER_AGENT_KNOWLEDGE_TIMEOUT_MS: '5000' } };
}
const callsOf = log => existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : [];
function bind(store, mode, projects = Object.keys(BINDINGS)) {
  for (const id of projects) {
    const current = bindingOf(store, id);
    setBinding(store, id, { mode, ...BINDINGS[id], revision: current?.revision });
  }
}
/** 고정 응답 provider — 검색 항목이 있으면 knowledgeRefs를 규칙대로 채운다 */
function recorder(build = answerFor) {
  const calls = [];
  return { calls, provider: { name: 'fixture', model: 'fixture-model', async generate(args) {
    calls.push(args);
    const data = build(args.context);
    if (args.context.knowledge) {
      const items = args.context.knowledge.items;
      data.decisions = data.decisions.map(d => ({ ...d, knowledgeRefs: items.filter(i => i.confirmed).map(i => i.ref).slice(0, 2) }));
      data.issues = data.issues.map(i => ({ ...i, knowledgeRefs: [] }));
      data.plan.tasks = data.plan.tasks.map(t => ({ ...t, knowledgeRefs: items.filter(i => i.forProject === t.projectId).map(i => i.ref).slice(0, 2) }));
    }
    return { data };
  } } };
}
function enabledSetup(t, overrides, mode = 'enabled') {
  const f = planningSetup(t);
  const ak = model(f.root, overrides);
  bind(f.store, mode);
  const retrieval = new KnowledgeRetrieval(f.store, { env: ak.env });
  return { ...f, ak, retrieval, planner: new Planner(f.store, { retrieval }) };
}

test('off·미연결이면 agent-knowledge를 부르지 않고 계획 입력·기록에 새 키를 넣지 않는다', async t => {
  const f = planningSetup(t);
  const ak = model(f.root);
  // 연결 환경은 있지만 binding이 없거나 off다
  setBinding(f.store, 'test-order', { mode: 'off', knowledgeProject: 'order' });
  const before = f.store.need('project', 'test-order').revision;
  const r = recorder();
  const result = await new Planner(f.store, { retrieval: new KnowledgeRetrieval(f.store, { env: ak.env }) }).analyze(f.mission.id, r.provider, { expectedRevision: f.mission.revision });
  assert.equal(callsOf(ak.log).length, 0);
  assert.equal(f.store.need('project', 'test-order').revision, before, 'binding은 project revision을 바꾸지 않는다');
  const context = r.calls[0].context;
  assert.ok(!Object.hasOwn(context, 'knowledge'));
  assert.equal(result.analysis.promptVersion, 'master-planner-v6');
  assert.ok(!Object.hasOwn(result.analysis, 'knowledge'));
  assert.ok(!r.calls[0].prompt.includes('knowledgeRefs'));
  assert.ok(!JSON.stringify(r.calls[0].schema).includes('knowledgeRefs'));
  const plan = f.store.need('mission', f.mission.id).plans.at(-1);
  assert.ok(!Object.hasOwn(plan, 'knowledge'));
  assert.ok(!result.mission.analyses[0].knowledge);
  assert.equal(f.store.list(BUNDLE_KIND).length, 0);
  assert.equal(f.store.list(SHADOW_KIND).length, 0);
});

test('enabled는 AI 호출 전에 프로젝트·질의마다 검색하고 검증한 항목만 context.knowledge에 싣는다', async t => {
  const f = enabledSetup(t);
  const r = recorder();
  const result = await f.planner.analyze(f.mission.id, r.provider, { expectedRevision: f.mission.revision });
  const calls = callsOf(f.ak.log);
  assert.equal(calls.length, 3 * 2, '프로젝트 3개 × 질의 2개(목표·완료 조건)');
  assert.ok(calls.every(c => c.command === 'search' && c.request.profile === 'master' && c.request.scope.projects.length === 1 && c.request.limit === LIMITS.perQuery));
  assert.ok(!calls[0].request.version && calls.slice(1).every(c => c.request.version.generation === 7), '첫 응답 세대로 고정한다');
  assert.deepEqual(calls.find(c => c.request.scope.projects[0] === 'order').request.scope.allowedLinks, [{ project: 'contracts', kinds: ['contract'] }]);
  assert.ok(calls.every(c => c.retrievalConfig === f.ak.env.MASTER_AGENT_KNOWLEDGE_RETRIEVAL_CONFIG));
  const context = r.calls[0].context, items = context.knowledge.items;
  assert.ok(items.every(i => /^kitem:test-[a-z]+:[0-9a-f]{16}$/.test(i.ref) && !i.ref.startsWith('source:')));
  // 같은 이름의 문서(docs/policy.md)도 프로젝트별로 다른 ref·forProject를 갖는다
  const policies = items.filter(i => i.path === 'docs/policy.md');
  assert.deepEqual(policies.map(i => i.forProject).sort(), ['test-order', 'test-payment']);
  assert.notEqual(policies[0].ref, policies[1].ref);
  assert.ok(items.some(i => i.itemId === 'order:docs/mandatory.md#M-1'), '적중이 있는 프로젝트의 필수 자료는 포함한다');
  assert.equal(items.find(i => i.itemId.startsWith('contracts:')).scopeRole, 'allowed-link');
  assert.ok(items.every(i => i.excerptTruncated || sha(i.excerpt) === i.itemSha256));
  assert.equal(context.knowledge.retrieval.generation, 7);
  assert.ok(context.knowledge.retrieval.projects.every(p => p.sources.every(s => s.relation === 'unknown')), '저장소가 아닌 경로의 관계는 unknown');
  assert.ok(Object.hasOwn(context.projects[0], 'sources') && context.projects[0].sources.length, '파일 근거 수집을 유지한다');
  assert.match(r.calls[0].prompt, /PROMPT_VERSION=master-planner-v6\+knowledge-2/);
  assert.match(r.calls[0].prompt, /테스트 통과·승인·완료 증거가 아니다/);
  const taskSchema = r.calls[0].schema.properties.plan.properties.tasks.items;
  assert.deepEqual(taskSchema.properties.knowledgeRefs.items.enum, items.map(i => i.ref));
  assert.ok(taskSchema.required.includes('knowledgeRefs'));
  // 기록: run 요약·묶음 봉인·계획 지식 요약. 지식 ref는 결정 evidence에 넣지 않는다
  const run = result.analysis;
  assert.equal(run.promptVersion, 'master-planner-v6+knowledge-2');
  assert.equal(run.knowledge.outcome, 'used'); assert.equal(run.knowledge.items, items.length);
  assert.equal(run.contextHash, hash(context));
  const bundle = verifiedBundle(f.store, run.knowledge.bundleId, run.knowledge.bundleHash);
  assert.deepEqual(bundle.knowledge, context.knowledge);
  const mission = f.store.need('mission', f.mission.id), plan = mission.plans.at(-1);
  assert.equal(mission.state, 'planned');
  assert.equal(plan.knowledge.bundleId, bundle.id);
  assert.ok(plan.knowledge.refs.every(ref => plan.proposal.tasks.some(t => t.knowledgeRefs.includes(ref.ref))));
  const activate = f.store.list('decision', { missionId: mission.id }).find(d => d.action === 'activate-plan');
  assert.ok(activate.evidence.every(e => !e.startsWith('kitem:')));
  assert.equal(activate.knowledge.bundleId, bundle.id);
  assert.equal(result.mission.analyses.at(-1).knowledge.outcome, 'used');
});

test('분석·계획 검증은 모르는 ID·다른 프로젝트 ID·미확정 판단 근거·묶음 없는 지식 참조를 거부한다', async t => {
  const f = enabledSetup(t);
  const r = recorder();
  await f.planner.analyze(f.mission.id, r.provider, { expectedRevision: f.mission.revision });
  const context = r.calls[0].context, items = context.knowledge.items;
  const valid = () => { const a = answerFor(context); a.decisions = a.decisions.map(d => ({ ...d, knowledgeRefs: [] })); a.plan.tasks = a.plan.tasks.map(x => ({ ...x, knowledgeRefs: [] })); return a; };
  assert.doesNotThrow(() => validateAnalysis(valid(), context));
  const code = fn => { try { fn(); return 'ok'; } catch (e) { return e.code; } };
  let a = valid(); a.plan.tasks[0].knowledgeRefs = ['kitem:test-order:0000000000000000'];
  assert.equal(code(() => validateAnalysis(a, context)), 'unknown-knowledge-reference');
  a = valid(); a.plan.tasks[0].knowledgeRefs = [items.find(i => i.forProject !== a.plan.tasks[0].projectId).ref];
  assert.equal(code(() => validateAnalysis(a, context)), 'knowledge-reference-scope');
  a = valid(); a.decisions[0].knowledgeRefs = [items.find(i => !i.confirmed).ref];
  assert.equal(code(() => validateAnalysis(a, context)), 'unconfirmed-knowledge-basis');
  // 정보 부족 분석의 질문에는 미확정 자료를 쓸 수 있다
  a = blockedAnswer(context); a.decisions = a.decisions.map(d => ({ ...d, knowledgeRefs: [] })); a.plan.tasks = [];
  a.issues = a.issues.map(i => ({ ...i, knowledgeRefs: [items.find(x => !x.confirmed).ref] }));
  assert.equal(code(() => validateAnalysis(a, context)), 'ok');
  a = valid(); delete a.plan.tasks[0].knowledgeRefs;
  assert.equal(code(() => validateAnalysis(a, context)), 'invalid-analysis', 'knowledge가 있는 context에서는 필드가 필요하다');
  // off context는 기존 스키마 그대로다 — knowledgeRefs를 받지 않는다
  const { knowledge: _k, ...offContext } = context;
  a = valid();
  assert.equal(code(() => validateAnalysis(a, offContext)), 'invalid-analysis');
  assert.ok(!JSON.stringify(analysisSchemaFor(offContext)).includes('knowledgeRefs'));
  // 묶음 없는 계획(수동 mission plan)의 지식 참조는 거부, 키가 없는 기존 계획은 그대로 통과
  const plan = structuredClone(valid().plan); plan.tasks[0].knowledgeRefs = [items[0].ref];
  const projects = f.store.need('mission', f.mission.id).scope.projectIds.map(id => f.store.need('project', id));
  assert.equal(code(() => validatePlan(plan, f.store.need('mission', f.mission.id), projects)), 'unknown-knowledge-reference');
  assert.equal(code(() => validatePlan(answerFor(context).plan, f.store.need('mission', f.mission.id), projects)), 'ok');
  const m = f.store.need('mission', f.mission.id);
  assert.equal(code(() => f.engine.plan(m.id, plan, m.revision)), 'unknown-knowledge-reference');
});

test('변조 해시·폐기·다른 세대·범위 밖·커밋 불일치 항목은 버리고 코드별로 센다', async t => {
  const f = planningSetup(t);
  const bad = '0'.repeat(64);
  const ak = model(f.root, { items: [
    ITEMS[0],
    { ...ITEMS[0], id: 'order:a#tampered', match: ['주문'], itemSha256: bad },
    { ...ITEMS[0], id: 'order:a#deprecated', match: ['주문'], status: 'deprecated' },
    { ...ITEMS[0], id: 'order:a#old', match: ['주문'], generation: 6 },
    { ...ITEMS[0], id: 'order:a#commit', match: ['주문'], commit: commit(9) },
    { ...ITEMS[0], id: 'order:a#stranger', match: ['주문'], override: { projectId: 'stranger' } },
    { ...ITEMS[0], id: 'order:a#path', match: ['주문'], path: '../escape.md' },
  ] });
  bind(f.store, 'enabled', ['test-order']);
  const retrieval = new KnowledgeRetrieval(f.store, { env: ak.env });
  const mission = f.store.need('mission', f.mission.id);
  const out = await retrieval.analysis(mission, {}, retrieval.targets(mission, ['enabled']));
  assert.deepEqual(out.knowledge.items.map(i => i.itemId), ['order:docs/policy.md#ORD-1']);
  const rejected = out.knowledge.retrieval.projects[0].rejected;
  assert.deepEqual(rejected, { 'knowledge-item-hash-mismatch': 1, 'knowledge-item-deprecated': 1, 'knowledge-generation-mismatch': 1,
    'knowledge-commit-mismatch': 1, 'knowledge-item-out-of-scope': 1, 'knowledge-item-invalid': 1 });
});

test('빈 결과·필수 자료만·연결 프로젝트 적중·실패는 서로 구별하고 실패·빈 결과는 off 입력을 유지한다', async t => {
  const f = planningSetup(t);
  const mission = f.store.need('mission', f.mission.id);
  bind(f.store, 'enabled', ['test-order']);
  const run = async overrides => { const ak = model(f.root, overrides); const r = new KnowledgeRetrieval(f.store, { env: ak.env });
    return r.analysis(mission, { small: true }, r.targets(mission, ['enabled'])); };
  let out = await run({ items: [ITEMS[2]] });
  assert.equal(out.knowledge, null); assert.equal(out.summary.outcome, 'mandatory-only'); assert.equal(out.summary.counts.mandatoryOnly, 2);
  out = await run({ items: [] });
  assert.equal(out.knowledge, null); assert.equal(out.summary.outcome, 'empty'); assert.equal(out.summary.counts.noResults, 2);
  out = await run({ items: [ITEMS[5], ITEMS[2]] });
  assert.equal(out.summary.outcome, 'used'); assert.equal(out.summary.counts.linkedHit, 1);
  assert.deepEqual(out.knowledge.items.map(i => i.scopeRole), ['allowed-link'], '대상 프로젝트 적중이 없으면 필수 자료를 넣지 않는다');
  out = await run({ behaviour: { '*': 'error:invalid-scope:4:unknown-project' } });
  assert.equal(out.summary.outcome, 'failed');
  assert.deepEqual(out.summary.diagnostics[0], { projectId: 'test-order', query: 0, code: 'knowledge-producer-error', producerCode: 'invalid-scope', reason: 'unknown-project' });
  assert.ok(!JSON.stringify(out.summary).includes('secret'), '생산자 오류 원문·경로를 남기지 않는다');
  out = await run({ behaviour: { '*': 'error:index-missing:5:project-not-indexed' } });
  assert.equal(out.summary.diagnostics[0].reason, 'project-not-indexed');
  out = await run({ schemaVersion: 2 });
  assert.equal(out.summary.diagnostics[0].code, 'knowledge-unsupported-version');
  for (const publishedAt of ['x'.repeat(100), 'yesterday']) {
    out = await run({ publishedAt });
    assert.equal(out.summary.diagnostics[0].code, 'knowledge-invalid-output', '발행 시각 형식·길이를 검사한다');
  }
  out = await run({ behaviour: { '*': 'badjson' } });
  assert.equal(out.summary.diagnostics[0].code, 'knowledge-invalid-output');
  out = await run({ behaviour: { '*': 'big' } });
  assert.equal(out.summary.diagnostics[0].code, 'knowledge-output-limit');
  out = await run({ behaviour: { '*': 'crash' } });
  assert.equal(out.summary.diagnostics[0].code, 'knowledge-invalid-output');
  // 검색 도중 색인이 교체되면(같은 세대 번호, 다른 발행 시각) 이후 응답은 버린다
  const ak = model(f.root, { publishedAtAfter: { calls: 1, value: '2026-11-10T01:00:00.000Z' } });
  writeFileSync(ak.log, '');
  const r = new KnowledgeRetrieval(f.store, { env: ak.env });
  out = await r.analysis(mission, {}, r.targets(mission, ['enabled']));
  assert.equal(out.summary.counts.error, 1); assert.equal(out.summary.diagnostics[0].code, 'knowledge-generation-mismatch');
  // 연결 없음·잘못된 연결
  out = await new KnowledgeRetrieval(f.store, { env: {} }).analysis(mission, {}, r.targets(mission, ['enabled']));
  assert.equal(out.summary.outcome, 'unavailable'); assert.equal(out.summary.diagnostics[0].code, 'knowledge-not-configured');
  out = await new KnowledgeRetrieval(f.store, { env: { MASTER_AGENT_KNOWLEDGE_CLI: join(f.root, 'missing.js'), MASTER_AGENT_KNOWLEDGE_DB: join(f.root, 'x') } }).analysis(mission, {}, r.targets(mission, ['enabled']));
  assert.equal(out.summary.diagnostics[0].code, 'knowledge-unavailable');
});

test('질의 적중 항목을 필수 자료보다 먼저 고르고, 버려진 적중은 필수 자료만과 구별하며, 긴 ID를 받고 전체 기한을 호출 제한 시간으로 지킨다', async t => {
  const f = planningSetup(t);
  const mission = f.store.need('mission', f.mission.id);
  bind(f.store, 'enabled', ['test-order']);
  const run = async (overrides, options = {}) => { const ak = model(f.root, overrides); const r = new KnowledgeRetrieval(f.store, { env: ak.env, ...options });
    return r.analysis(mission, {}, r.targets(mission, ['enabled'])); };
  // 생산자는 필수 자료를 먼저 돌려준다 — 프로젝트 한도를 넘는 필수 자료가 있어도 질의 적중 항목이 먼저 들어간다
  const mandatory = Array.from({ length: LIMITS.itemsPerProject + 2 }, (_, n) => ({ ...ITEMS[2], id: `order:docs/mandatory.md#M-${n}`, key: `M-${n}`, excerpt: `필수 ${n}` }));
  let out = await run({ items: [...mandatory, ITEMS[0]] });
  assert.equal(out.summary.outcome, 'used');
  assert.equal(out.knowledge.items[0].itemId, ITEMS[0].id);
  assert.equal(out.knowledge.items.length, LIMITS.itemsPerProject);
  assert.equal(out.knowledge.retrieval.projects[0].dropped, 3);
  assert.equal(out.knowledge.retrieval.selectionVersion, 'master-knowledge-select-2');
  // 적중 항목이 검증에서 모두 버려지면 '필수 자료만'이 아니라 폐기이며, 폐기 코드가 요약에 남는다
  out = await run({ items: [{ ...ITEMS[0], itemSha256: 'f'.repeat(64) }, ITEMS[2]] });
  assert.equal(out.knowledge, null); assert.equal(out.summary.outcome, 'rejected');
  assert.equal(out.summary.counts.rejected, 1); assert.equal(out.summary.counts.mandatoryOnly, 1);
  assert.deepEqual(out.summary.rejectedItems, { 'knowledge-item-hash-mismatch': 1 });
  out = await run({ items: [{ ...ITEMS[2], itemSha256: 'f'.repeat(64) }] });
  assert.equal(out.summary.outcome, 'rejected', '쓸 항목이 하나도 남지 않으면 폐기다');
  // 생산자 항목 ID·제목에는 길이 상한이 없다 — 긴 제목도 정상 항목이다
  const long = { ...ITEMS[0], id: `order:docs/policy.md#${'긴-제목'.repeat(200)}`, title: '긴 제목 '.repeat(300) };
  out = await run({ items: [long] });
  assert.equal(out.summary.outcome, 'used'); assert.equal(out.knowledge.items[0].itemId, long.id);
  // 전체 기한: 남은 시간을 각 호출의 제한 시간으로 넘기고, 1초 미만이면 호출하지 않는다
  for (const [step, expected, deadline] of [[57000, [5000, 3000], 0], [59500, [5000], 1]]) {
    let now = 0;
    const timeouts = [];
    const call = async (connection, command, request, options) => { timeouts.push(options.timeoutMs); now += step; return callKnowledge(connection, command, request, options); };
    out = await run({}, { clock: () => now, call });
    assert.deepEqual(timeouts, expected);
    assert.equal(out.summary.counts.error, deadline);
  }
});

test('시간 초과는 그 질의만 실패로 기록하고 계획은 기존 입력으로 진행한다', async t => {
  const f = enabledSetup(t, { behaviour: { order: 'timeout' } });
  f.ak.env.MASTER_AGENT_KNOWLEDGE_TIMEOUT_MS = '1000';
  const r = recorder();
  const result = await f.planner.analyze(f.mission.id, r.provider, { expectedRevision: f.mission.revision });
  assert.equal(result.mission.state, 'planned');
  assert.equal(result.analysis.knowledge.counts.error, 2);
  assert.ok(result.analysis.knowledge.diagnostics.every(d => d.code === 'knowledge-timeout' && d.projectId === 'test-order'));
  assert.ok(r.calls[0].context.knowledge.items.every(i => i.forProject !== 'test-order'));
});

test('검색 설정이 바뀌면 같은 세대라도 다른 입력(settingsHash·contextHash)이다', async t => {
  const f = planningSetup(t);
  bind(f.store, 'enabled', ['test-order']);
  const mission = f.store.need('mission', f.mission.id), ak = model(f.root);
  const first = await new KnowledgeRetrieval(f.store, { env: ak.env }).analysis(mission, {}, new KnowledgeRetrieval(f.store).targets(mission, ['enabled']));
  writeFileSync(ak.env.MASTER_AGENT_KNOWLEDGE_RETRIEVAL_CONFIG, 'schemaVersion: 1\nprofiles: {master: {excerptChars: 40}}\n');
  const second = await new KnowledgeRetrieval(f.store, { env: ak.env }).analysis(mission, {}, new KnowledgeRetrieval(f.store).targets(mission, ['enabled']));
  assert.equal(first.knowledge.retrieval.generation, second.knowledge.retrieval.generation);
  assert.notEqual(first.knowledge.retrieval.settingsHash, second.knowledge.retrieval.settingsHash);
  assert.notEqual(hash(first.knowledge), hash(second.knowledge));
  // 같은 설정·같은 세대·같은 요청이면 같은 입력이다(시각·순서 잡음 없음)
  const third = await new KnowledgeRetrieval(f.store, { env: ak.env, clock: () => 123 }).analysis(mission, {}, new KnowledgeRetrieval(f.store).targets(mission, ['enabled']));
  assert.equal(hash(third.knowledge), hash(second.knowledge));
});

test('기존 context가 1MiB 상한에 가까우면 지식을 넣지 않고 진단만 남긴다', async t => {
  const f = planningSetup(t);
  bind(f.store, 'enabled', ['test-order']);
  const mission = f.store.need('mission', f.mission.id), ak = model(f.root), r = new KnowledgeRetrieval(f.store, { env: ak.env });
  const out = await r.analysis(mission, { padding: 'x'.repeat(LIMITS.contextBytes - LIMITS.headroom - 1024) }, r.targets(mission, ['enabled']));
  assert.equal(out.knowledge, null); assert.equal(out.summary.outcome, 'omitted');
  assert.ok(out.summary.diagnostics.some(d => d.code === 'knowledge-context-budget'));
  const some = await r.analysis(mission, { padding: 'x'.repeat(LIMITS.contextBytes - LIMITS.headroom - 9 * 1024) }, r.targets(mission, ['enabled']));
  assert.ok(Buffer.byteLength(JSON.stringify(some.knowledge ?? {})) <= 9 * 1024);
});

test('묶음은 현재 분석·활성 계획만 보존하고 재계획·취소에서 해제하며 해제와 변조를 구별한다', async t => {
  const f = enabledSetup(t);
  const r = recorder();
  const first = await f.planner.analyze(f.mission.id, r.provider, { expectedRevision: f.mission.revision });
  const a = first.analysis.knowledge.bundleId;
  // 새 분석: 이전 묶음은 활성 계획이 쓰므로 유지되고, 새 계획이 활성화되면 해제된다
  let m = f.store.need('mission', f.mission.id);
  const second = await f.planner.analyze(m.id, r.provider, { expectedRevision: m.revision });
  const b = second.analysis.knowledge.bundleId;
  assert.notEqual(a, b);
  // 재분석·재계획 입력의 이전 계획에서는 지난 묶음의 지식 참조를 뺀다
  assert.ok(first.mission.plans.at(-1).proposal.tasks.some(x => x.knowledgeRefs?.length));
  assert.ok(r.calls.at(-1).context.previousPlan.tasks.every(x => !Object.hasOwn(x, 'knowledgeRefs')));
  assert.equal(f.store.need(BUNDLE_KIND, a).state, 'released');
  assert.equal(f.store.need(BUNDLE_KIND, a).knowledge, null);
  assert.equal(f.store.need(BUNDLE_KIND, b).state, 'retained');
  assert.throws(() => verifiedBundle(f.store, a), e => e.code === 'knowledge-bundle-released');
  // 변조: 본문을 바꾸면 봉인 해시가 맞지 않는다
  const bundle = f.store.need(BUNDLE_KIND, b);
  f.store.put(BUNDLE_KIND, { ...bundle, knowledge: { ...bundle.knowledge, items: bundle.knowledge.items.slice(1) } }, bundle.revision);
  m = f.store.need('mission', f.mission.id);
  const task = m.plans.at(-1).proposal.tasks.find(x => x.knowledgeRefs.length);
  assert.throws(() => taskEvidence(f.store, m.plans.at(-1), task), e => e.code === 'knowledge-integrity');
  // 취소: 모든 묶음 본문을 지운다
  f.engine.control(m.id, 'cancel', m.revision);
  assert.ok(f.store.list(BUNDLE_KIND, { missionId: m.id }).every(x => x.state === 'released' && x.knowledge === null && x.sealedHash));
});

async function legacyClassification(t) {
  const f = enabledSetup(t);
  const build = context => { const data = blockedAnswer(context, true); data.status = 'needs-context'; data.issues.push({ ...data.issues[0], id: 'info', kind: 'information' }); return data; };
  const r = recorder(build);
  const result = await f.planner.analyze(f.mission.id, { name: 'fixture', async generate(args) { const out = await r.provider.generate(args); return { ...out, review: { verdict: 'approve' } }; } },
    { expectedRevision: f.mission.revision, maxPasses: 1 });
  const run = f.store.need('analysis-run', result.analysis.id);
  f.store.put('analysis-run', { ...run, status: 'invalid', result: null, error: { code: 'issue-classification', message: '분류 오류' },
    passes: [{ ...run.passes[0], data: { ...run.result, status: 'needs-context' } }] }, run.revision);
  return { ...f, run };
}
test('분석을 중단해도 그 분석의 묶음은 보존되고, 다음 분석이 시작될 때 해제된다', async t => {
  const f = enabledSetup(t);
  let open;
  const gate = new Promise(resolve => { open = resolve; });
  const r = recorder();
  const pending = f.planner.analyze(f.mission.id, { name: 'fixture', async generate(args) { await gate; return r.provider.generate(args); } }, { expectedRevision: f.mission.revision })
    .then(value => ({ value }), error => ({ error }));
  let m = f.store.need('mission', f.mission.id);
  for (let i = 0; i < 500 && !(m.analysisRunId && f.store.get('analysis-run', m.analysisRunId)); i++) { await new Promise(resolve => setTimeout(resolve, 10)); m = f.store.need('mission', f.mission.id); }
  const runId = m.analysisRunId;
  assert.ok(runId, '분석 회차가 시작됐다');
  stopAnalysis(f.store, m.id, runId, m.revision);
  open();
  await pending;
  const bundleId = f.store.need('analysis-run', runId).knowledge.bundleId;
  assert.equal(f.store.need(BUNDLE_KIND, bundleId).state, 'retained', '중단된 분석의 입력은 재현할 수 있게 남긴다');
  m = f.store.need('mission', f.mission.id);
  const next = await f.planner.analyze(m.id, recorder().provider, { expectedRevision: m.revision });
  assert.equal(next.mission.state, 'planned');
  const old = f.store.need(BUNDLE_KIND, bundleId);
  assert.equal(old.state, 'released'); assert.equal(old.releaseReason, 'analysis-superseded');
});

test('분류 정정은 봉인 묶음으로 같은 입력을 다시 만든다', async t => {
  const f = await legacyClassification(t), run = f.run;
  const m = f.store.need('mission', f.mission.id);
  const repaired = f.planner.repairClassification(m.id, m.revision);
  assert.ok(repaired, '봉인 묶음으로 같은 contextHash를 재현한다');
  assert.equal(f.store.need('analysis-run', repaired.analysisRunId).knowledge.bundleId, run.knowledge.bundleId);
  assert.equal(f.store.need(BUNDLE_KIND, run.knowledge.bundleId).state, 'retained');
});
test('분류 정정은 묶음을 잃으면 최신 세대로 바꾸지 않고 새 분석을 요구한다', async t => {
  const g = await legacyClassification(t), run2 = g.run;
  const bundle = g.store.need(BUNDLE_KIND, run2.knowledge.bundleId);
  g.store.put(BUNDLE_KIND, { ...bundle, state: 'released', knowledge: null }, bundle.revision);
  const m2 = g.store.need('mission', g.mission.id);
  const before = callsOf(g.ak.log).length;
  assert.equal(g.planner.repairClassification(m2.id, m2.revision), null);
  assert.equal(callsOf(g.ak.log).length, before, '정정은 다시 검색하지 않는다');
});

test('shadow는 계획 입력·contextHash·상태 전이를 그대로 두고 비교 기록만 남긴다', async t => {
  // 같은 저장소의 두 목표: 첫 목표는 연결 전(off), 둘째 목표는 shadow
  const f = planningSetup(t), ak = model(f.root);
  const planner = new Planner(f.store, { retrieval: new KnowledgeRetrieval(f.store, { env: ak.env }) });
  const ro = recorder(), rs = recorder();
  const a = await planner.analyze(f.mission.id, ro.provider, { expectedRevision: f.mission.revision });
  bind(f.store, 'shadow');
  const second = f.engine.create({ ...f.fixture.mission, requestKey: 'demo-test-shadow' });
  const b = await planner.analyze(second.id, rs.provider, { expectedRevision: second.revision });
  const normal = (value, id) => JSON.stringify(value).replaceAll(id, '<mission>');
  assert.equal(normal(rs.calls[0].prompt, second.id), normal(ro.calls[0].prompt, f.mission.id));
  assert.equal(hash(JSON.parse(normal(rs.calls[0].context, second.id))), hash(JSON.parse(normal(ro.calls[0].context, f.mission.id))));
  assert.equal(normal(rs.calls[0].schema, second.id), normal(ro.calls[0].schema, f.mission.id));
  assert.ok(!Object.hasOwn(b.analysis, 'knowledge')); assert.equal(b.analysis.promptVersion, a.analysis.promptVersion);
  assert.deepEqual(f.store.events(second.id).map(e => e.type), f.store.events(f.mission.id).map(e => e.type));
  assert.deepEqual(f.store.list('decision', { missionId: second.id }).map(d => [d.action, Object.keys(d).sort()]),
    f.store.list('decision', { missionId: f.mission.id }).map(d => [d.action, Object.keys(d).sort()]));
  assert.equal(f.store.list(BUNDLE_KIND).length, 0);
  const shadow = f;
  const record = shadow.store.need(SHADOW_KIND, `ks:${b.analysis.id}`);
  assert.equal(record.outcome, 'compared'); assert.equal(record.contextHash, b.analysis.contextHash);
  assert.ok(record.selected.length > 0 && record.selected.every(i => !Object.hasOwn(i, 'excerpt')));
  const order = record.comparison.find(c => c.projectId === 'test-order');
  assert.deepEqual(order.contextPaths, ['POLICY.md']);
  assert.ok(order.ragOnly.includes('docs/policy.md'));
  assert.deepEqual(order.citedPaths, ['POLICY.md']);
  assert.equal(typeof record.elapsedMs, 'number');
  assert.equal(shadow.store.list(SHADOW_KIND).length, 1, 'off 분석에는 비교 기록이 없다');
});
test('shadow 검색 장애는 분석 결과·상태에 영향을 주지 않는다', async t => {
  const broken = enabledSetup(t, { behaviour: { '*': 'crash' } }, 'shadow');
  const c = await broken.planner.analyze(broken.mission.id, recorder().provider, { expectedRevision: broken.mission.revision });
  assert.equal(c.mission.state, 'planned');
  assert.equal(broken.store.need(SHADOW_KIND, `ks:${c.analysis.id}`).counts.error, 6);
});

test('연결 모드 설정은 범위·형식·버전을 검사하고 끄기는 기록을 지우지 않는다(CLI)', t => {
  const f = planningSetup(t);
  const revision = f.store.need('project', 'test-order').revision;
  f.close();
  const run = (...args) => {
    try { return { ok: true, value: JSON.parse(execFileSync(process.execPath, [cli, ...args, '--db', f.db], { cwd: f.root, encoding: 'utf8', stdio: 'pipe', env: { ...process.env, MASTER_AGENT_KNOWLEDGE_CLI: '' } })) }; }
    catch (e) { return { ok: false, error: JSON.parse(e.stderr.trim().split('\n').at(-1)).error }; }
  };
  assert.equal(run('project', 'knowledge', 'test-order').value.binding.mode, 'off');
  assert.equal(run('project', 'knowledge', 'test-order').value.connection.configured, false);
  assert.equal(run('project', 'knowledge-mode', 'test-order', 'enabled').error, 'invalid-input');
  assert.equal(run('project', 'knowledge-mode', 'test-order', 'on', '--knowledge-project', 'order').error, 'invalid-input');
  assert.equal(run('project', 'knowledge-mode', 'test-order', 'enabled', '--knowledge-project', 'Order!').error, 'invalid-input');
  assert.equal(run('project', 'knowledge-mode', 'test-order', 'enabled', '--knowledge-project', 'order', '--allow-link', 'order:contract').error, 'invalid-input');
  assert.equal(run('project', 'knowledge-mode', 'test-order', 'enabled', '--knowledge-project', 'order', '--allow-link', 'contracts:policy').error, 'invalid-input');
  assert.equal(run('project', 'search', 'test-order', '주문', '--knowledge-project', 'x').error, 'usage');
  const set = run('project', 'knowledge-mode', 'test-order', 'enabled', '--knowledge-project', 'order', '--allow-link', 'contracts:contract,dependency');
  assert.equal(set.value.mode, 'enabled'); assert.deepEqual(set.value.allowedLinks, [{ knowledgeProject: 'contracts', kinds: ['contract', 'dependency'] }]);
  assert.equal(run('project', 'knowledge-mode', 'test-payment', 'shadow', '--knowledge-project', 'order').error, 'knowledge-project-conflict');
  assert.equal(run('project', 'knowledge-mode', 'test-order', 'off').error, 'stale-state', '기존 설정은 revision이 필요하다');
  const offed = run('project', 'knowledge-mode', 'test-order', 'off', '--revision', String(set.value.revision));
  assert.equal(offed.value.mode, 'off'); assert.equal(offed.value.knowledgeProject, 'order'); assert.equal(offed.value.allowedLinks.length, 1);
  const status = run('project', 'knowledge', 'test-order').value;
  assert.equal(status.binding.revision, offed.value.revision);
  // 허용 연결: 생략하면 유지, none이면 모두 철회, 다른 지식 프로젝트로 다시 연결하면 물려받지 않는다
  const kept = run('project', 'knowledge-mode', 'test-order', 'enabled', '--revision', String(offed.value.revision));
  assert.equal(kept.value.allowedLinks.length, 1);
  assert.equal(run('project', 'knowledge-mode', 'test-order', 'enabled', '--allow-link', 'none', '--allow-link', 'contracts:contract', '--revision', String(kept.value.revision)).error, 'usage');
  const cleared = run('project', 'knowledge-mode', 'test-order', 'enabled', '--allow-link', 'none', '--revision', String(kept.value.revision));
  assert.deepEqual(cleared.value.allowedLinks, []);
  const relinked = run('project', 'knowledge-mode', 'test-order', 'enabled', '--allow-link', 'contracts:contract', '--revision', String(cleared.value.revision));
  assert.equal(relinked.value.allowedLinks.length, 1);
  const rebound = run('project', 'knowledge-mode', 'test-order', 'enabled', '--knowledge-project', 'order2', '--revision', String(relinked.value.revision));
  assert.equal(rebound.value.knowledgeProject, 'order2'); assert.deepEqual(rebound.value.allowedLinks, []);
  const store = new Store(f.db);
  try { assert.equal(store.need('project', 'test-order').revision, revision, 'binding은 project revision을 바꾸지 않는다'); } finally { store.close(); }
});

test('질의는 목표를 문장 단위로 나누고 완료 조건마다 만들며 상한을 넘은 수를 기록한다', () => {
  const long = Array.from({ length: 80 }, (_, i) => `문장 ${i} ${'가'.repeat(40)}.`).join(' ');
  const { queries, omitted } = queriesFor({ goal: long, criteria: Array.from({ length: 5 }, (_, i) => ({ id: `c${i}`, description: `조건 ${i}` })) });
  assert.equal(queries.length, LIMITS.queries);
  assert.ok(queries.every(q => q.length <= LIMITS.queryChars));
  assert.ok(omitted > 0);
  assert.deepEqual(queries.slice(1, 6), [0, 1, 2, 3, 4].map(i => `조건 ${i}`), '완료 조건이 긴 목표에 밀리지 않는다');
  assert.deepEqual(queriesFor({ goal: '짧은 목표', criteria: [{ id: 'a', description: '짧은 목표' }, { id: 'b', description: '조건' }] }), { queries: ['짧은 목표', '조건'], omitted: 0 });
});

test('연결 상태 조회는 생산자를 호출하지 않고 설정 문제를 코드로만 보인다', t => {
  const f = planningSetup(t);
  const ak = model(f.root);
  assert.equal(knowledgeStatus(f.store, 'test-order', ak.env).connection.configured, true);
  assert.equal(knowledgeStatus(f.store, 'test-order', { ...ak.env, MASTER_AGENT_KNOWLEDGE_TIMEOUT_MS: '5' }).connection.problem.code, 'knowledge-not-configured');
  assert.equal(knowledgeStatus(f.store, 'test-order', { MASTER_AGENT_KNOWLEDGE_CLI: FAKE }).connection.problem.code, 'knowledge-not-configured');
  assert.equal(callsOf(ak.log).length, 0);
});
