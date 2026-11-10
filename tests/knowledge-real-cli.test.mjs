import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { temporary, cleanup } from './helpers.mjs';
import { answerFor } from './planning-fixture.mjs';
import { Store } from '../packages/storage/store.mjs';
import { Engine } from '../packages/orchestrator/engine.mjs';
import { Knowledge } from '../packages/knowledge/sources.mjs';
import { Planner } from '../packages/reasoning/planner.mjs';
import { KnowledgeRetrieval, setBinding } from '../packages/knowledge/retrieval.mjs';
import { callKnowledge, knowledgeConnection } from '../packages/knowledge/agent-knowledge.mjs';
import { dispatchEvidence, sourceState, taskEvidence, verifiedBundle } from '../packages/knowledge/evidence.mjs';

/**
 * 실제 agent-knowledge CLI(빌드 산출물)와 임시 git 저장소·임시 DB로 하는 연동 시험. AI provider는 고정 응답 대역이다.
 * AGENT_KNOWLEDGE_DIST(기본 옆 저장소 ../agent-knowledge/dist)의 src/cli/main.js가 없으면 건너뛴다.
 */
const CLI = join(resolve(process.env.AGENT_KNOWLEDGE_DIST ?? join(dirname(fileURLToPath(import.meta.url)), '../../agent-knowledge/dist')), 'src/cli/main.js');
const available = existsSync(CLI);
const sha = value => createHash('sha256').update(value).digest('hex');
const GIT = ['-c', 'core.autocrlf=false', '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main'];
function git(repo, ...args) {
  const r = spawnSync('git', ['-C', repo, ...GIT, ...args], { shell: false, windowsHide: true, encoding: 'buffer' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}
function write(root, files) {
  for (const [path, text] of Object.entries(files)) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text); }
}
const ALPHA = {
  'docs/policies.md': '# 알파 공통 정책\n\n### `POL-001` 개인정보 마스킹\n\n- 구분: 필수\n- 상태: 확정\n- 근거: docs/decisions/privacy.md\n\n로그에 카드번호를 남기지 않는다.\n',
  'docs/business-rules.md': '# 주문 업무 규칙\n\n### `BR-001` 주문 취소 가능 기간\n\n- 상태: 확정\n- 근거: docs/decisions/order-cancel.md\n\n결제 완료 후 24시간 이내에만 주문 취소를 허용한다.\n\n### `BR-099` 옛 환불 규칙\n\n- 상태: 폐기\n\n예전에는 주문 취소 시 포인트로만 환불했다.\n',
  'docs/notes.md': '# 작업 메모\n\n## 개요\n\n첫 번째 주문 취소 메모.\n\n## 개요\n\n두 번째 주문 취소 메모.\n',
  // BOM·CRLF 문서 — 줄 슬라이스 해시 규칙(BOM 제거·CRLF 분할) 대조용
  'docs/crlf.md': '﻿# 윈도우 문서\r\n\r\n### `BR-201` 주문 취소 알림\r\n\r\n- 상태: 확정\r\n- 근거: docs/decisions/order-cancel.md\r\n\r\n주문 취소 시 알림을 보낸다.\r\n',
  'docs/decisions/order-cancel.md': '# 주문 취소 기간 결정\n\n24시간으로 정했다.\n',
  'docs/decisions/privacy.md': '# 개인정보 결정\n\n마스킹 대상은 보안팀이 정한다.\n',
};
const BETA = {
  'docs/overview.md': '# 베타 시스템 개요\n\n베타는 주문 취소 이벤트를 받아 정산을 되돌린다.\n\n### `CON-010` 주문 취소 이벤트 계약\n\n- 종류: contract\n- 상태: 확정\n- 근거: docs/contract-decision.md\n\n알파가 order.cancelled 이벤트를 발행한다.\n',
  'docs/contract-decision.md': '# 계약 결정\n\n이벤트 이름은 order.cancelled로 확정했다.\n',
};

function realSetup(t, { retainGenerations } = {}) {
  const root = temporary(t);
  const repos = {};
  for (const [name, files] of Object.entries({ alpha: ALPHA, beta: BETA })) {
    const repo = join(root, 'repos', name); mkdirSync(repo, { recursive: true });
    write(repo, files); git(repo, 'init', '-q'); git(repo, 'add', '-A'); git(repo, 'commit', '-q', '--no-verify', '-m', `${name} v1`);
    repos[name] = repo;
  }
  const db = join(root, 'ak', 'knowledge.sqlite'), config = join(root, 'ak', 'sources.yaml');
  mkdirSync(dirname(db), { recursive: true });
  writeFileSync(config, JSON.stringify({ schemaVersion: 1, database: { path: db }, ...(retainGenerations ? { index: { retainGenerations } } : {}), sources: [
    { id: 'alpha', project: 'alpha', path: repos.alpha, ref: 'HEAD', include: ['docs/**/*.md'], defaultKind: 'reference', rules: [{ match: 'docs/business-rules.md', kind: 'business-rule' }, { match: 'docs/crlf.md', kind: 'business-rule' }, { match: 'docs/policies.md', kind: 'policy' }] },
    { id: 'beta', project: 'beta', path: repos.beta, ref: 'HEAD', include: ['docs/**/*.md'], defaultKind: 'overview' }] }));
  const index = () => {
    const r = spawnSync(process.execPath, [CLI, 'index', '--config', config, '--db', db, '--quiet'], { encoding: 'utf8', windowsHide: true,
      env: { ...process.env, AGENT_KNOWLEDGE_CONFIG: '', AGENT_KNOWLEDGE_DB: '', AGENT_KNOWLEDGE_RETRIEVAL_CONFIG: '' } });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    return JSON.parse(r.stdout);
  };
  index();
  const store = new Store(join(root, 'state.db')); cleanup(t, () => store.close());
  const engine = new Engine(store), knowledge = new Knowledge(store);
  for (const [id, domain, source] of [['alpha', 'order', 'docs/business-rules.md'], ['beta', 'settlement', 'docs/overview.md']]) {
    const p = engine.catalog.register({ id, name: id, path: repos[id], domains: [domain], capabilities: ['simulation'], constraints: [], currentPlans: [], references: ['fixture'] });
    knowledge.collect(id, { schemaVersion: 1, sources: [{ path: source, kind: 'policy' }] }, p.revision);
    setBinding(store, id, { mode: 'enabled', knowledgeProject: id });
  }
  const mission = engine.create({ goal: '주문 취소 가능 기간을 확인하고 주문 취소 이벤트 계약을 정리한다', requestKey: 'real-ak', mode: 'simulation',
    scope: { projectIds: ['alpha', 'beta'], groupIds: [] }, criteria: [{ id: 'c1', description: '주문 취소 이벤트 계약과 정산 되돌림을 확인한다' }] });
  const env = { MASTER_AGENT_KNOWLEDGE_CLI: CLI, MASTER_AGENT_KNOWLEDGE_CONFIG: config, MASTER_AGENT_KNOWLEDGE_DB: db };
  const retrieval = new KnowledgeRetrieval(store, { env });
  return { root, repos, db, config, index, store, engine, mission, env, retrieval, planner: new Planner(store, { retrieval }) };
}
const provider = calls => ({ name: 'fixture', async generate(args) {
  calls.push(args);
  const data = answerFor(args.context), items = args.context.knowledge?.items ?? [];
  if (args.context.knowledge) {
    // 확정 항목 중 원본이 바뀌지 않은 것만 판단·작업 근거로 쓴다(프롬프트 규칙과 같다)
    const usable = items.filter(i => i.confirmed && !['changed', 'missing'].includes(i.sourceState));
    data.decisions = data.decisions.map(d => ({ ...d, knowledgeRefs: usable.map(i => i.ref).slice(0, 2) }));
    data.issues = data.issues.map(i => ({ ...i, knowledgeRefs: [] }));
    data.plan.tasks = data.plan.tasks.map(task => ({ ...task, knowledgeRefs: usable.filter(i => i.forProject === task.projectId).map(i => i.ref).slice(0, 2) }));
  }
  return { data };
} });

test('실제 agent-knowledge: 다중 프로젝트 검색 → 항목 검증 → 계획 입력·참조 검증 → 묶음 봉인', { skip: !available && 'agent-knowledge CLI 빌드 산출물 없음' }, async t => {
  const f = realSetup(t), calls = [];
  const result = await f.planner.analyze(f.mission.id, provider(calls), { expectedRevision: f.mission.revision });
  assert.equal(result.mission.state, 'planned');
  const knowledge = calls[0].context.knowledge;
  assert.ok(knowledge.items.length > 0);
  const ids = knowledge.items.map(i => i.itemId);
  assert.ok(ids.includes('alpha:docs/business-rules.md#BR-001'));
  assert.ok(!ids.some(id => id.includes('BR-099')), '폐기 항목은 넣지 않는다');
  assert.ok(knowledge.items.some(i => i.forProject === 'beta' && i.itemId.startsWith('beta:')));
  assert.ok(knowledge.items.every(i => i.producerProjectId === (i.forProject === 'alpha' ? 'alpha' : 'beta')), '프로젝트별 검색은 다른 프로젝트 항목을 섞지 않는다');
  assert.ok(knowledge.items.filter(i => !i.excerptTruncated).every(i => sha(Buffer.from(i.excerpt)) === i.itemSha256));
  const notes = knowledge.items.filter(i => i.path === 'docs/notes.md');
  assert.equal(new Set(notes.map(i => i.itemId)).size, notes.length, '같은 제목의 절도 서로 다른 항목 ID다');
  const head = git(f.repos.alpha, 'rev-parse', 'HEAD').toString().trim();
  const alpha = knowledge.retrieval.projects.find(p => p.projectId === 'alpha');
  assert.equal(alpha.head, head);
  assert.deepEqual(alpha.sources.map(s => [s.sourceId, s.commit, s.relation]), [['alpha', head, 'same-as-head']]);
  assert.ok(alpha.outcomes.some(o => o.outcome === 'hit'));
  assert.equal(result.analysis.knowledge.outcome, 'used');
  const plan = f.store.need('mission', f.mission.id).plans.at(-1);
  verifiedBundle(f.store, plan.knowledge.bundleId, plan.knowledge.bundleHash);
  // 실제 생산자 해시를 master의 git 대조 규칙으로 재현한다(blob·문서·줄 슬라이스 — BOM·CRLF 포함)
  for (const item of knowledge.items.filter(i => i.forProject === 'alpha')) {
    const repo = f.repos.alpha;
    assert.equal(git(repo, 'rev-parse', `${item.commit}:${item.path}`).toString().trim(), item.blobSha);
    const bytes = git(repo, 'cat-file', 'blob', item.blobSha);
    assert.equal(sha(bytes), item.documentSha256);
    const lines = new TextDecoder('utf-8', { fatal: true }).decode(bytes).split(/\r\n|\n|\r/);
    assert.equal(sha(lines.slice(item.startLine - 1, item.endLine).join('\n')), item.itemSha256, item.itemId);
    assert.equal(sourceState(repo, item), 'unchanged');
  }
  assert.ok(knowledge.items.some(i => i.path === 'docs/crlf.md'), 'BOM·CRLF 문서 항목도 검증을 통과한다');
});

test('실제 agent-knowledge: 재색인·세대 정리 뒤에도 계획 묶음은 로컬로 검증되고 고정 세대를 최신으로 바꾸지 않는다', { skip: !available && 'agent-knowledge CLI 빌드 산출물 없음' }, async t => {
  const f = realSetup(t, { retainGenerations: 1 }), calls = [];
  await f.planner.analyze(f.mission.id, provider(calls), { expectedRevision: f.mission.revision });
  const pinned = calls[0].context.knowledge.retrieval.generation;
  const m = f.store.need('mission', f.mission.id), plan = m.plans.at(-1);
  const task = plan.proposal.tasks.find(x => x.projectId === 'alpha' && x.knowledgeRefs.length);
  assert.ok(task, 'alpha 작업이 확정 지식을 참조한다');
  // 원본 수정 → 재색인 2회(보존 1세대) → 고정 세대는 생산자에서 사라진다
  write(f.repos.alpha, { 'docs/business-rules.md': ALPHA['docs/business-rules.md'].replace('24시간', '48시간') });
  git(f.repos.alpha, 'commit', '-q', '-am', 'alpha v2');
  f.index(); f.index();
  const connection = knowledgeConnection(f.env);
  await assert.rejects(callKnowledge(connection, 'search', { profile: 'master', query: '주문 취소', scope: { projects: ['alpha'] }, version: { generation: pinned } }),
    e => e.code === 'knowledge-producer-error' && e.producerCode === 'index-missing' && e.reason === 'generation-not-found');
  // 계획 묶음은 생산자 없이 검증된다(로컬 정본)
  assert.doesNotThrow(() => taskEvidence(f.store, plan, task));
  // 확정 항목의 원본이 바뀌었으므로 배정은 그 작업만 재검토로 보낸다
  const project = f.store.need('project', 'alpha');
  assert.throws(() => dispatchEvidence(f.store, plan, task, project, { mode: 'enabled' }), e => e.code === 'knowledge-source-changed');
  // 새 분석은 새 세대를 고정하고 이전 묶음을 재사용하지 않는다
  const again = [];
  const m2 = f.store.need('mission', f.mission.id);
  // 프로젝트 근거(business-rules.md)도 바뀌었으므로 먼저 다시 수집한다
  new Knowledge(f.store).collect('alpha', { schemaVersion: 1, sources: [{ path: 'docs/business-rules.md', kind: 'policy' }] }, project.revision);
  const second = await f.planner.analyze(m2.id, provider(again), { expectedRevision: m2.revision });
  assert.ok(again[0].context.knowledge.retrieval.generation > pinned);
  assert.notEqual(second.analysis.knowledge.bundleId, plan.knowledge.bundleId);
  assert.ok(again[0].context.knowledge.items.some(i => i.excerpt.includes('48시간')));
});

test('실제 agent-knowledge: 재색인 전에 원본이 바뀐 확정 항목은 분석 때 표시되고 작업 근거로 거부되어 재분석이 수렴한다', { skip: !available && 'agent-knowledge CLI 빌드 산출물 없음' }, async t => {
  const f = realSetup(t);
  // 색인(v1) 뒤 원본만 바뀐다 — 생산자는 같은 세대에서 같은 항목·같은 ref를 다시 돌려준다
  write(f.repos.alpha, { 'docs/business-rules.md': ALPHA['docs/business-rules.md'].replace('24시간', '48시간') });
  git(f.repos.alpha, 'commit', '-q', '-am', 'alpha v2');
  const project = f.store.need('project', 'alpha');
  new Knowledge(f.store).collect('alpha', { schemaVersion: 1, sources: [{ path: 'docs/business-rules.md', kind: 'policy' }] }, project.revision);
  const BR = 'alpha:docs/business-rules.md#BR-001';
  // 바뀐 항목을 작업 근거로 고집하는 응답은 계획이 되지 않는다
  const insist = { name: 'fixture', async generate(args) {
    const out = await provider([]).generate(args), item = args.context.knowledge.items.find(i => i.itemId === BR);
    out.data.plan.tasks = out.data.plan.tasks.map(task => task.projectId === 'alpha' ? { ...task, knowledgeRefs: [item.ref] } : task);
    return out;
  } };
  let m = f.store.need('mission', f.mission.id);
  const first = await f.planner.analyze(m.id, insist, { expectedRevision: m.revision });
  assert.notEqual(first.mission.state, 'planned');
  assert.ok(JSON.stringify(f.store.need('analysis-run', first.analysis.id)).includes('knowledge-source-stale'));
  // 같은 색인으로 다시 분석하면 바뀐 항목이 표시되므로 그 항목 없이 계획이 활성화된다(배정에서 같은 이유로 다시 막히지 않는다)
  const calls = [];
  m = f.store.need('mission', f.mission.id);
  const second = await f.planner.analyze(m.id, provider(calls), { expectedRevision: m.revision });
  assert.equal(second.mission.state, 'planned');
  const items = calls[0].context.knowledge.items, stale = items.find(i => i.itemId === BR);
  assert.equal(stale.sourceState, 'changed');
  assert.equal(calls[0].context.knowledge.retrieval.projects.find(p => p.projectId === 'alpha').sources[0].relation, 'ancestor-of-head');
  assert.ok(second.analysis.knowledge.diagnostics.some(d => d.code === 'knowledge-index-stale' && d.count >= 1));
  const plan = f.store.need('mission', f.mission.id).plans.at(-1);
  assert.ok(plan.proposal.tasks.every(task => !(task.knowledgeRefs ?? []).includes(stale.ref)));
  for (const task of plan.proposal.tasks.filter(x => x.knowledgeRefs?.length)) {
    assert.doesNotThrow(() => dispatchEvidence(f.store, plan, task, f.store.need('project', task.projectId), { mode: 'enabled' }));
  }
});
