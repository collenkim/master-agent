import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { planningSetup, answerFor } from './planning-fixture.mjs';
import { Planner } from '../packages/reasoning/planner.mjs';
import { KnowledgeRetrieval, setBinding, bindingOf, leaseHolder } from '../packages/knowledge/retrieval.mjs';
import { BUNDLE_KIND, dispatchEvidence, leaseHold } from '../packages/knowledge/evidence.mjs';
import { receiverCapability } from '../packages/knowledge/handoff.mjs';
import { renewForTask, settleLeases } from '../packages/knowledge/lease.mjs';

/**
 * 생산자 형식 2 협의·정확한 색인 고정·세대 임대 수명 시험. 생산자는 대역 CLI(tests/agent-knowledge-fake-cli.mjs, model.v2)다.
 * 실제 agent-knowledge 와의 협의·임대는 knowledge-real-cli.test.mjs·knowledge-integration.test.mjs 가 본다. AI provider 는 고정 응답 대역이다.
 */
const FAKE = resolve('tests/agent-knowledge-fake-cli.mjs');
const commit = n => String(n).repeat(40).slice(0, 40);
const SOURCES = [{ sourceId: 'order', projectId: 'order', commit: commit(1), requestedRef: 'HEAD' }, { sourceId: 'payment', projectId: 'payment', commit: commit(2), requestedRef: 'main' },
  { sourceId: 'coupon', projectId: 'coupon', commit: commit(3), requestedRef: 'HEAD' }];
const ITEMS = [
  { id: 'order:docs/policy.md#ORD-1', key: 'ORD-1', projectId: 'order', sourceId: 'order', kind: 'policy', path: 'docs/policy.md', startLine: 3, excerpt: '### `ORD-1` 주문 취소\n\n주문 취소는 24시간 안에만 허용한다.', match: ['주문', '취소'] },
  { id: 'payment:docs/policy.md#PAY-1', key: 'PAY-1', projectId: 'payment', sourceId: 'payment', kind: 'policy', path: 'docs/policy.md', startLine: 3, excerpt: '### `PAY-1` 환불\n\n환불은 결제 취소 이벤트로 시작한다.', match: ['환불', '취소'] },
  { id: 'coupon:docs/rules.md#COU-1', key: 'COU-1', projectId: 'coupon', sourceId: 'coupon', kind: 'business-rule', path: 'docs/rules.md', excerpt: '### `COU-1` 쿠폰 복구\n\n취소 시 쿠폰을 복구한다.', match: ['쿠폰', '취소'] },
];
const BINDINGS = { 'test-order': 'order', 'test-payment': 'payment', 'test-coupon': 'coupon' };
const calls = log => existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : [];

function setup(t, { v2 = {}, mode = 'enabled', retrievalYaml = 'schemaVersion: 1\n', extra = {} } = {}) {
  const f = planningSetup(t);
  const log = join(f.root, 'ak-calls.jsonl'), db = join(f.root, 'ak-model.json'), rc = join(f.root, 'retrieval.yaml');
  const value = { log, generation: 7, publishedAt: '2026-11-10T00:00:00.000Z', sources: SOURCES, items: ITEMS, ...(v2 ? { v2 } : {}), ...extra };
  writeFileSync(db, JSON.stringify(value)); writeFileSync(rc, retrievalYaml);
  for (const [id, knowledgeProject] of Object.entries(BINDINGS)) setBinding(f.store, id, { mode, knowledgeProject, revision: bindingOf(f.store, id)?.revision });
  const env = { MASTER_AGENT_KNOWLEDGE_CLI: FAKE, MASTER_AGENT_KNOWLEDGE_DB: db, MASTER_AGENT_KNOWLEDGE_RETRIEVAL_CONFIG: rc, MASTER_AGENT_KNOWLEDGE_TIMEOUT_MS: '5000' };
  const retrieval = new KnowledgeRetrieval(f.store, { env });
  const patch = change => writeFileSync(db, JSON.stringify(change(JSON.parse(readFileSync(db, 'utf8')))));
  return { ...f, log, db, env, retrieval, patch, planner: new Planner(f.store, { retrieval }), leases: () => existsSync(`${db}.leases.json`) ? JSON.parse(readFileSync(`${db}.leases.json`, 'utf8')) : [] };
}
/** 고정 응답 provider — 작업마다 자기 프로젝트 항목의 첫 참조만 필수 의존이다 */
const provider = (seen = []) => ({ name: 'fixture', model: 'fixture-model', async generate(args) {
  seen.push(args);
  const data = answerFor(args.context), items = args.context.knowledge?.items ?? [];
  if (args.context.knowledge) {
    data.decisions = data.decisions.map(d => ({ ...d, knowledgeRefs: items.filter(i => i.confirmed).map(i => i.ref).slice(0, 1) }));
    data.issues = data.issues.map(i => ({ ...i, knowledgeRefs: [] }));
    data.plan.tasks = data.plan.tasks.map(t => { const refs = items.filter(i => i.forProject === t.projectId).map(i => i.ref).slice(0, 1); return { ...t, knowledgeRefs: refs, knowledgeRequired: refs }; });
  }
  return { data };
} });
const analyze = async (f, seen) => { const m = f.store.need('mission', f.mission.id); return f.planner.analyze(m.id, provider(seen), { expectedRevision: m.revision }); };
/** 진행 게이트 빌드의 색인 대조 등록 공지 — 필수 근거는 형식 2로만 간다(공통 계약 송신 결정) */
const RECEIVER = receiverCapability({ knowledge: { schemaVersion: 1, mode: 'enabled', refs: { supported: true, accepted: true, max: 20, versions: [1, 2], maxBytes: 32768, requiredGate: true } } });

test('형식 2 생산자: 기능 협의 뒤 정확한 세대·색인 ID로 검색하고, 묶음·계획에 색인 식별·설정 해시를 남기며 분석이 세대 임대를 잡는다', async t => {
  const f = setup(t), seen = [];
  const result = await analyze(f, seen);
  assert.equal(result.mission.state, 'planned');
  const log = calls(f.log);
  assert.deepEqual(log.slice(0, 2).map(c => c.command), ['capabilities', 'status'], '협의는 검색 전에 한 번');
  const searches = log.filter(c => c.command === 'search');
  assert.ok(searches.length > 0 && searches.every(c => c.request.responseVersion === 2 && c.request.profile === 'master' && Array.isArray(c.request.queries)));
  assert.ok(searches.every(c => c.request.version?.exact === true && c.request.version.indexId === '0123456789abcdef0123456789abcdef' && c.request.version.generation === 7), '세대·색인 ID를 정확히 고정한다');
  const knowledge = seen[0].context.knowledge;
  assert.equal(knowledge.retrieval.contract, 'agent-knowledge.search@2');
  assert.equal(knowledge.retrieval.indexId, '0123456789abcdef0123456789abcdef');
  assert.equal(knowledge.retrieval.configHash, 'c'.repeat(64));
  assert.ok(knowledge.items.every(i => i.indexId === '0123456789abcdef0123456789abcdef' && i.indexGeneration === 7 && /^ak-[0-9a-f]{20}$/.test(i.handle)));
  const plan = f.store.need('mission', f.mission.id).plans.at(-1);
  assert.equal(plan.knowledge.indexId, '0123456789abcdef0123456789abcdef');
  assert.equal(plan.knowledge.configHash, 'c'.repeat(64));
  // 임대: 목표 단위 보유자, 고정 세대, 3일. 임대는 근거(contextHash·묶음 봉인)에 들어가지 않는다
  const bundle = f.store.need(BUNDLE_KIND, plan.knowledge.bundleId);
  assert.deepEqual([bundle.lease.state, bundle.lease.holder, bundle.lease.generation, bundle.lease.indexId], ['held', leaseHolder(f.mission.id), 7, '0123456789abcdef0123456789abcdef']);
  assert.ok(!JSON.stringify(bundle.knowledge).includes(bundle.lease.leaseId));
  assert.deepEqual(f.leases().map(l => [l.holder, l.generation]), [[leaseHolder(f.mission.id), 7]]);
  const lease = log.find(c => c.command === 'lease');
  assert.deepEqual(lease.args.slice(0, 7), ['acquire', '--holder', leaseHolder(f.mission.id), '--generation', '7', '--ttl', '259200']);
});

test('설정 해시: 형식 2는 생산자 설정 해시·질의·선택 판으로 정한다 — 검색 설정 파일의 주석만 바뀌면 같고, 생산자 설정이 바뀌면 다르다', async t => {
  const hashes = {};
  for (const [name, options] of [['a', {}], ['b', { retrievalYaml: 'schemaVersion: 1\n# 주석만 다르다\n' }], ['c', { v2: { configHash: 'd'.repeat(64) } }]]) {
    await t.test(name, async t => { const f = setup(t, options), seen = []; await analyze(f, seen); hashes[name] = seen[0].context.knowledge.retrieval.settingsHash; });
  }
  const { a: ha, b: hb, c: hc } = hashes;
  assert.equal(ha, hb);
  assert.notEqual(ha, hc);
});

test('형식 1로 돌아가는 협의 실패는 사유를 남기고, 형식 2 검색 오류는 형식 1로 다시 묻지 않는다', async t => {
  await t.test('형식 1만 아는 생산자 → search-v2-unsupported, 임대 없음', async t => {
    const f = setup(t, { v2: null }), seen = [];
    const result = await analyze(f, seen);
    assert.equal(result.analysis.knowledge.negotiation.reason, 'search-v2-unsupported');
    assert.equal(seen[0].context.knowledge.retrieval.contract, 'agent-knowledge.search@1');
    assert.ok(!calls(f.log).some(c => c.command === 'lease'));
    assert.equal(f.store.need(BUNDLE_KIND, f.store.need('mission', f.mission.id).plans.at(-1).knowledge.bundleId).lease ?? null, null);
  });
  await t.test('status 형식 2 실패 → status-unavailable', async t => {
    const f = setup(t, { extra: { behaviourByCommand: { status: 'error:internal:9' } } });
    const result = await analyze(f, []);
    assert.equal(result.analysis.knowledge.negotiation.responseVersion, 1);
    assert.equal(result.analysis.knowledge.negotiation.reason, 'status-unavailable');
  });
  await t.test('검색 응답의 색인 ID가 협의와 다르면 그 프로젝트는 오류이고 형식 1로 다시 묻지 않는다', async t => {
    const f = setup(t, { v2: { searchIndexId: 'ffffffffffffffffffffffffffffffff' } });
    const result = await analyze(f, []);
    assert.ok(result.analysis.knowledge.diagnostics.some(d => d.code === 'knowledge-index-mismatch'));
    assert.ok(calls(f.log).filter(c => c.command === 'search').every(c => c.request.responseVersion === 2));
  });
  await t.test('생산자 설정 해시가 협의와 다르면 knowledge-config-mismatch', async t => {
    const f = setup(t, { v2: { searchConfigHash: 'e'.repeat(64) } });
    const result = await analyze(f, []);
    assert.ok(result.analysis.knowledge.diagnostics.some(d => d.code === 'knowledge-config-mismatch'));
  });
});

test('임대 획득 실패는 진단으로 남고 계획은 진행한다(선택 검색 장애 — 기존 경로)', async t => {
  const f = setup(t, { extra: { behaviourByCommand: { 'lease:acquire': 'error:internal:9' } } });
  const result = await analyze(f, []);
  assert.equal(result.mission.state, 'planned');
  assert.ok(result.analysis.knowledge.diagnostics.some(d => d.code === 'knowledge-lease-failed'));
  const bundle = f.store.need(BUNDLE_KIND, f.store.need('mission', f.mission.id).plans.at(-1).knowledge.bundleId);
  assert.equal(bundle.lease.state, 'unavailable');
});

test('배정 전 임대 연장: enabled만 생산자를 부르고, 만료면 같은 세대로 다시 잡고, 세대가 지워졌으면 필수 근거 작업만 막는다', async t => {
  const f = setup(t);
  await analyze(f, []);
  const m = f.store.need('mission', f.mission.id), plan = m.plans.at(-1), bundleId = plan.knowledge.bundleId;
  const task = plan.proposal.tasks.find(x => x.knowledgeRequired?.length), project = f.store.need('project', task.projectId);
  const first = f.store.need(BUNDLE_KIND, bundleId).lease;
  // off·shadow: 생산자를 부르지 않는다(저장된 임대 그대로)
  const before = calls(f.log).length;
  for (const mode of ['off', 'shadow']) assert.deepEqual(await renewForTask(f.store, bundleId, mode, { env: f.env }), first);
  assert.equal(calls(f.log).length, before);
  // enabled: 연장
  const renewed = await renewForTask(f.store, bundleId, 'enabled', { env: f.env });
  assert.deepEqual([renewed.state, renewed.leaseId], ['held', first.leaseId]);
  assert.deepEqual(calls(f.log).at(-1).args.slice(0, 3), ['renew', '--lease-id', first.leaseId]);
  // 만료 → 같은 세대·색인으로 다시 잡는다
  f.patch(model => ({ ...model, expireLeases: true }));
  const again = await renewForTask(f.store, bundleId, 'enabled', { env: f.env });
  assert.equal(again.state, 'held');
  assert.notEqual(again.leaseId, first.leaseId);
  assert.ok(f.store.events(f.mission.id).some(e => e.type === 'knowledge-lease-reacquired'));
  assert.doesNotThrow(() => dispatchEvidence(f.store, plan, task, project, { mode: 'enabled', capability: RECEIVER, lease: again }));
  // 세대가 지워졌다(재색인·보존 정리) → lost(고정) → 필수 근거 작업은 재계획 대상으로 막힌다
  f.patch(model => ({ ...model, generation: 9, expireLeases: false }));
  writeFileSync(`${f.db}.leases.json`, '[]');
  const lost = await renewForTask(f.store, bundleId, 'enabled', { env: f.env });
  assert.deepEqual([lost.state, lost.reason], ['lost', 'generation-not-found']);
  assert.equal(leaseHold(lost), 'knowledge-generation-expired');
  assert.ok(f.store.events(f.mission.id).some(e => e.type === 'knowledge-lease-failed' && e.state === 'lost'));
  assert.throws(() => dispatchEvidence(f.store, plan, task, project, { mode: 'enabled', capability: RECEIVER, lease: lost }), e => e.code === 'knowledge-generation-expired' && Boolean(e.handoff));
  // 선택 참조만 있는 작업은 막지 않고 그 참조를 사유와 함께 뺀다
  const optional = { ...task, knowledgeRequired: [] };
  const decision = dispatchEvidence(f.store, plan, optional, project, { mode: 'enabled', capability: RECEIVER, lease: lost });
  assert.equal(decision.status, 'not-sent');
  assert.deepEqual(decision.omitted.map(o => o.reason), ['generation-expired']);
  // lost 는 고정이다 — 같은 실패를 반복해 묻지 않는다
  const count = calls(f.log).length;
  assert.equal((await renewForTask(f.store, bundleId, 'enabled', { env: f.env })).state, 'lost');
  assert.equal(calls(f.log).length, count);
});

test('재계획은 새 묶음·새 임대를 만들고 이전 묶음의 임대를 놓는다(생산자 임대 목록에서 사라진다)', async t => {
  const f = setup(t);
  await analyze(f, []);
  const firstBundle = f.store.need('mission', f.mission.id).plans.at(-1).knowledge.bundleId;
  const firstLease = f.store.need(BUNDLE_KIND, firstBundle).lease.leaseId;
  await analyze(f, []);
  const secondBundle = f.store.need('mission', f.mission.id).plans.at(-1).knowledge.bundleId;
  assert.notEqual(secondBundle, firstBundle);
  assert.equal(f.store.need(BUNDLE_KIND, firstBundle).lease.state, 'released');
  assert.equal(f.store.need(BUNDLE_KIND, secondBundle).lease.state, 'held');
  assert.ok(!f.leases().some(l => l.leaseId === firstLease));
  assert.equal(f.leases().length, 1);
  assert.ok(f.store.events(f.mission.id).some(e => e.type === 'knowledge-lease-released'));
  // 생산자에 닿지 못하면 해제 대기로 남고 다음 기회에 놓는다
  const pending = f.store.need(BUNDLE_KIND, secondBundle);
  f.store.transaction(() => f.store.put(BUNDLE_KIND, { ...pending, lease: { ...pending.lease, state: 'release-pending', releaseReason: 'mission-finished' } }, pending.revision));
  const offline = await settleLeases(f.store, { missionId: f.mission.id, env: { ...f.env, MASTER_AGENT_KNOWLEDGE_CLI: join(f.root, 'missing-cli.mjs') } });
  assert.ok(offline.every(r => r.state === 'release-pending'));
  await settleLeases(f.store, { missionId: f.mission.id, env: f.env });
  assert.equal(f.store.need(BUNDLE_KIND, secondBundle).lease.state, 'released');
  assert.equal(f.leases().length, 0);
});
