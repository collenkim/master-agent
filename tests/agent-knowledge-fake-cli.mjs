#!/usr/bin/env node
// agent-knowledge 계약(search 형식 1·2, capabilities, status 형식 2, lease)을 흉내 내는 대역 CLI(실제 색인·검색이 아니다).
// --db 경로의 JSON 모형을 읽고, 호출마다 모형의 log 파일에 한 줄씩 남긴다({command, args, request, ...} — 요청 파일이 없는 명령은 request null).
// 모형 기본값은 형식 1만 아는 생산자다(capabilities가 search 형식 [1]만 공지·profiles 없음). model.v2(객체)가 있으면 형식 2·status 형식 2·임대를 공지한다.
// 동작 주입: model.behaviour[프로젝트|'*'](요청이 있는 명령), model.behaviourByCommand[명령 | 'lease:<동작>'](명령 단위) —
//   timeout | big | badjson | crash | error:<code>:<exit>[:<reason>]
// 형식 2 응답 깨뜨리기(model.v2): searchConfigHash·searchIndexId(응답에 다른 값), echoRanker·echoSegmentsRequested(선택 반영 불일치).
// 임대 상태는 model.leaseFile(기본 <db>.leases.json)에 남는다. model.expireLeases면 renew가 모두 lease-expired다.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';

const argv = process.argv.slice(2), command = argv[0];
const option = name => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const db = option('--db');
const model = JSON.parse(readFileSync(db, 'utf8'));
const requestFile = option('--request');
const request = requestFile ? JSON.parse(readFileSync(requestFile, 'utf8')) : null;
// 명령 고유 인자: 명령 뒤부터 공통 플래그 전까지(lease 동작·플래그, status --response-version 2)
const COMMON = new Set(['--config', '--db', '--retrieval-config', '--quiet', '--request']);
const end = argv.findIndex((a, i) => i > 0 && COMMON.has(a));
const args = argv.slice(1, end < 0 ? argv.length : end);
const action = command === 'lease' ? args[0] ?? null : null;
const logged = model.log && existsSync(model.log) ? readFileSync(model.log, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
// 발행 시각 교체(publishedAtAfter)는 앞선 search 호출 수로 센다 — 협의(capabilities·status)·임대 호출은 세지 않는다
const calls = logged.filter(c => c.command === 'search').length;
if (model.log) appendFileSync(model.log, `${JSON.stringify({ command, args, request, retrievalConfig: option('--retrieval-config'), config: option('--config') ?? null })}\n`);
const sha = text => createHash('sha256').update(text).digest('hex');
const write = (doc, code) => { process.stdout.write(`${typeof doc === 'string' ? doc : JSON.stringify(doc)}\n`); process.exitCode = code; };
const error = (code, exit, reason) => write({ schema: 'agent-knowledge.error', schemaVersion: 1, ok: false, error: { code, message: `${code} C:\\secret\\path`, detail: reason ? { reason } : {} } }, exit);
const project = request?.scope?.projects?.[0];
const byCommand = model.behaviourByCommand ?? {};
const behaviour = (action ? byCommand[`lease:${action}`] : undefined) ?? byCommand[command] ?? (request ? model.behaviour?.[project] ?? model.behaviour?.['*'] : undefined);
const publishedAt = model.publishedAtAfter && calls >= model.publishedAtAfter.calls ? model.publishedAtAfter.value : model.publishedAt;
const v2 = model.v2 ? { configHash: 'c'.repeat(64), indexId: '0123456789abcdef0123456789abcdef', queryVersion: 'query-2', databaseSchemaVersion: 2, v2RequiresSchemaVersion: 2,
  rankers: [{ name: 'legacy', version: 'keyword-legacy-1' }, { name: 'bm25', version: 'keyword-bm25-2' }], segments: { chunkerVersion: 'chunk-2', maxChars: 1500 }, ...model.v2 } : null;
// 생산자가 보존 중인 세대 — 활성 세대와 model.retained
const available = new Set([model.generation, ...(model.retained ?? [])]);

function render(item, reasons, rank, terms, generation = model.generation) {
  const source = model.sources.find(s => s.sourceId === item.sourceId);
  const excerpt = item.excerpt;
  const lines = excerpt.split('\n').length;
  const base = { id: item.id, key: item.key ?? null, projectId: item.projectId, sourceId: item.sourceId, kind: item.kind, unit: item.unit ?? 'entry',
    title: item.title ?? item.id, headingPath: item.headingPath ?? [item.title ?? item.id], excerpt, excerptTruncated: item.excerptTruncated ?? false,
    provenance: { path: item.path, startLine: item.startLine ?? 1, endLine: item.endLine ?? (item.startLine ?? 1) + lines - 1,
      excerptStartLine: item.startLine ?? 1, excerptEndLine: item.endLine ?? (item.startLine ?? 1) + lines - 1, anchor: item.key ?? 'a',
      commit: item.commit ?? source.commit, blobSha: item.blobSha ?? sha(`blob:${item.path}`).slice(0, 40), documentSha256: item.documentSha256 ?? sha(`doc:${item.path}`),
      itemSha256: item.itemSha256 ?? sha(excerpt), parserVersion: 'md-1', chunkerVersion: 'chunk-1', generation: item.generation ?? generation, firstGeneration: 1 },
    knowledge: { status: item.status ?? 'confirmed_policy', confirmed: item.confirmed ?? (item.status ?? 'confirmed_policy') === 'confirmed_policy', reason: 'fixture', basis: null, conflicts: item.conflicts ?? [] },
    selection: { section: item.mandatory && reasons[0] === 'mandatory' ? 'mandatory' : item.section ?? 'policies', rank, score: reasons[0] === 'mandatory' ? 0 : 1, reasons, matchedTerms: terms },
    links: [] };
  return item.override ? { ...base, ...item.override, provenance: { ...base.provenance, ...(item.override.provenance ?? {}) } } : base;
}

/** 형식 2 항목 — 형식 1 항목에 ref(정확한 식별)·segment·질의별 적중을 더한다. item.segment {id, startLine, endLine, text}면 조각 결과(발췌는 조각 내용) */
function renderV2(item, reasons, rank, terms, { generation, indexId, directRank, matchedQueries }) {
  const segment = item.segment ? { id: item.segment.id, sha256: sha(item.segment.text), startLine: item.segment.startLine, endLine: item.segment.endLine } : null;
  const base = render({ ...item, override: undefined }, reasons, rank, terms, generation);
  if (segment) Object.assign(base, { excerpt: item.segment.text, excerptTruncated: false });
  const p = base.provenance;
  base.selection = { ...base.selection, directRank, matchedQueries };
  base.ref = { handle: `ak-${sha(`handle:${item.id}:${segment?.id ?? ''}`).slice(0, 20)}`, indexId, indexGeneration: generation, sourceId: item.sourceId, projectId: item.projectId,
    commit: p.commit, itemId: item.id, itemSha256: p.itemSha256, documentSha256: p.documentSha256, blobSha: p.blobSha, path: p.path, startLine: p.startLine, endLine: p.endLine,
    segmentId: segment?.id ?? null, segmentSha256: segment?.sha256 ?? null, segmentStartLine: segment?.startLine ?? null, segmentEndLine: segment?.endLine ?? null };
  base.segment = segment;
  return item.override ? { ...base, ...item.override, provenance: { ...base.provenance, ...(item.override.provenance ?? {}) } } : base;
}

function capabilities() {
  const versions = v2 ? [1, 2] : [1];
  write({ schema: 'agent-knowledge.capabilities', schemaVersion: 1, ok: true, status: 'ok', package: { name: 'agent-knowledge', version: '0.0.0-fake' },
    commands: { search: { responseVersions: versions, defaultResponseVersion: 1 }, get: { responseVersions: versions, defaultResponseVersion: 1 },
      status: { responseVersions: versions, defaultResponseVersion: 1 }, capabilities: { responseVersions: [1], defaultResponseVersion: 1 },
      ...(v2 ? { lease: { responseVersions: [1], defaultResponseVersion: 1 }, verify: { responseVersions: [1], defaultResponseVersion: 1 } } : {}) },
    index: { schemaVersion: v2?.databaseSchemaVersion ?? 1, minReadableSchemaVersion: 1, ...(v2 ? { v2RequiresSchemaVersion: v2.v2RequiresSchemaVersion } : {}) },
    versions: { parser: 'md-1', chunker: 'chunk-1', tokenizer: 'tok-1', resolver: 'resolve-1', ...(v2 ? { query: v2.queryVersion } : {}) },
    ...(v2 ? { rankers: v2.rankers.map((r, i) => ({ ...r, default: i === 0 })), ...(v2.segments ? { segments: { ...v2.segments, defaultEnabled: false } } : {}),
      queryLimits: v2.queryLimits ?? { maxQueries: 32, maxQueryChars: 4000 }, leases: { ttlSeconds: { default: 86400, min: 60, max: 2592000 }, maxLive: 1024 },
      profiles: { master: { configHash: v2.configHash } } } : {}),
    vector: { implemented: false, state: 'not-implemented' } }, 0);
}

function status() {
  // 형식 1만 아는 생산자는 --response-version을 모른다(사용법 오류)
  if (!v2) return error('usage', 2);
  const state = leases();
  write({ schema: 'agent-knowledge.status', schemaVersion: 2, ok: true, status: 'ok', indexId: v2.indexId, databaseSchemaVersion: v2.databaseSchemaVersion,
    activeGeneration: model.generation, retainedGenerations: [...available].sort((a, b) => a - b), leases: { live: state.length, expired: 0 } }, 0);
}

// ── 임대 ──────────────────────────────────────────────────────────────
const leaseFile = model.leaseFile ?? `${db}.leases.json`;
function leases() { return existsSync(leaseFile) ? JSON.parse(readFileSync(leaseFile, 'utf8')) : []; }
function saveLeases(list) { writeFileSync(leaseFile, JSON.stringify(list)); }
const leaseDoc = (extra) => ({ schema: 'agent-knowledge.lease', schemaVersion: 1, ok: true, status: 'ok', action, indexId: v2.indexId, ...extra });
const publicLease = l => ({ leaseId: l.leaseId, generation: l.generation, holder: l.holder, acquiredAt: l.acquiredAt, renewedAt: l.renewedAt, expiresAt: l.expiresAt });
function lease() {
  // 형식 1만 아는 생산자에는 lease 명령이 없다
  if (!v2) return error('usage', 2);
  const flag = name => { const i = args.indexOf(name); return i > 0 ? args[i + 1] : undefined; };
  const list = leases(), at = new Date(), ttl = Number(flag('--ttl') ?? 86400);
  if (action === 'acquire') {
    const holder = flag('--holder'), generation = flag('--generation') === undefined ? model.generation : Number(flag('--generation'));
    if (!holder) return error('invalid-request', 2, 'invalid-holder');
    if (flag('--index-id') !== undefined && flag('--index-id') !== v2.indexId) return error('index-missing', 5, 'index-id-mismatch');
    if (!available.has(generation)) return error('index-missing', 5, 'generation-not-found');
    const record = { leaseId: randomUUID(), generation, holder, acquiredAt: at.toISOString(), renewedAt: at.toISOString(), expiresAt: new Date(at.getTime() + ttl * 1000).toISOString() };
    saveLeases([...list, record]);
    return write(leaseDoc({ lease: publicLease(record) }), 0);
  }
  if (action === 'renew') {
    const id = flag('--lease-id'), current = list.find(l => l.leaseId === id);
    // 보존 기간이 끝나 지워진 세대의 임대는 함께 사라진다(생산자 GC와 같은 결과)
    if (!current || !available.has(current.generation)) return error('not-found', 3, 'lease-not-found');
    if (model.expireLeases) return error('not-found', 3, 'lease-expired');
    const renewed = { ...current, renewedAt: at.toISOString(), expiresAt: new Date(at.getTime() + ttl * 1000).toISOString() };
    saveLeases(list.map(l => l.leaseId === id ? renewed : l));
    return write(leaseDoc({ lease: publicLease(renewed) }), 0);
  }
  if (action === 'release') {
    const id = flag('--lease-id'), found = list.some(l => l.leaseId === id);
    saveLeases(list.filter(l => l.leaseId !== id));
    return write(leaseDoc({ released: found }), 0);
  }
  if (action === 'list') {
    const holder = flag('--holder');
    return write(leaseDoc({ leases: list.filter(l => !holder || l.holder === holder).map(publicLease) }), 0);
  }
  return error('usage', 2);
}

// ── 검색 ──────────────────────────────────────────────────────────────
function searchV1() {
  const links = request.scope?.allowedLinks ?? [];
  const inScope = item => item.projectId === project || links.some(l => l.project === item.projectId && (!l.kinds || l.kinds.includes(item.kind)));
  const words = request.query.split(/\s+/).filter(Boolean), items = [];
  for (const item of model.items.filter(inScope)) {
    const matched = (item.match ?? []).filter(term => words.some(word => word.includes(term)));
    const mandatory = item.mandatory && item.projectId === project;
    if (!matched.length && !mandatory) continue;
    items.push(render(item, matched.length ? ['keyword-match'] : ['mandatory'], items.length + 1, matched));
  }
  const direct = items.filter(i => i.selection.reasons.includes('keyword-match')).length;
  const sources = model.sources.filter(s => s.projectId === project || links.some(l => l.project === s.projectId));
  write({ schema: 'agent-knowledge.search', schemaVersion: model.schemaVersion ?? 1, ok: true, status: items.length ? 'ok' : 'no-results', notice: 'fixture',
    request: { profile: request.profile, query: request.query, task: { phase: null, paths: [] }, limit: request.limit },
    appliedScope: { projects: [project], allowedLinks: links, kinds: null, statuses: ['confirmed_policy'] },
    index: { generation: model.generation, publishedAt, parserVersion: 'md-1', chunkerVersion: 'chunk-1', tokenizerVersion: 'tok-1', resolverVersion: 'resolve-1', sources },
    retrieval: { mode: 'keyword', vector: { enabled: false, state: 'not-implemented' }, directCount: direct }, sections: [], items, codeLocations: [],
    limitations: [...(direct === 0 && items.length ? [{ code: 'no-query-matches', message: 'm', detail: {} }] : []), ...(model.limitations ?? [])] }, items.length ? 0 : 3);
}

/** 형식 2: 프로젝트 하나·질의 여러 개. 고정 세대(version)·색인 ID를 확인하고 index·retrieval·budget·digests를 낸다 */
function searchV2() {
  if (!v2) return error('invalid-request', 4, 'unsupported-response-version');
  const generation = request.version?.generation ?? model.generation;
  if (!available.has(generation)) return error('index-missing', 5, 'generation-not-found');
  if (request.version?.indexId !== undefined && request.version.indexId !== v2.indexId) return error('index-missing', 5, 'index-id-mismatch');
  if (request.ranker !== undefined && !v2.rankers.some(r => r.name === request.ranker)) return error('invalid-request', 4, 'unknown-ranker');
  const indexId = v2.searchIndexId !== undefined ? v2.searchIndexId : v2.indexId;
  const links = request.scope?.allowedLinks ?? [];
  const inScope = item => item.projectId === project || links.some(l => l.project === item.projectId && (!l.kinds || l.kinds.includes(item.kind)));
  const queries = request.queries ?? [];
  let items = [], directRank = 0;
  for (const item of model.items.filter(inScope)) {
    const hits = queries.map(q => ({ key: q.key, terms: (item.match ?? []).filter(term => q.text.split(/\s+/).filter(Boolean).some(word => word.includes(term))) })).filter(h => h.terms.length);
    const matched = [...new Set(hits.flatMap(h => h.terms))];
    const mandatory = item.mandatory && item.projectId === project;
    if (!matched.length && !mandatory) continue;
    items.push(renderV2(item, matched.length ? ['keyword-match'] : ['mandatory'], items.length + 1, matched,
      { generation, indexId, directRank: matched.length ? ++directRank : null, matchedQueries: hits.map(h => h.key) }));
  }
  const maxItems = request.budget?.maxItems;
  const omitted = Number.isInteger(maxItems) && items.length > maxItems ? items.slice(maxItems).map(i => i.id) : [];
  items = items.slice(0, items.length - omitted.length);
  const direct = items.filter(i => i.selection.reasons.includes('keyword-match')).length;
  const sources = model.sources.filter(s => s.projectId === project || links.some(l => l.project === s.projectId));
  const rankerName = v2.echoRanker ?? request.ranker ?? 'legacy';
  const index = { generation, publishedAt, parserVersion: 'md-1', chunkerVersion: 'chunk-2', tokenizerVersion: 'tok-1', resolverVersion: 'resolve-1', sources, indexId,
    scopeFingerprint: sha(JSON.stringify({ projects: [project], links })) };
  const retrieval = { mode: 'keyword', vector: { enabled: false, state: 'not-implemented' }, directCount: direct, outcome: items.length ? 'ok' : 'no-results',
    ranker: { name: rankerName, version: v2.rankers.find(r => r.name === rankerName)?.version ?? 'unknown' }, queryVersion: v2.queryVersion,
    segments: { requested: v2.echoSegmentsRequested ?? request.segments === true, effective: request.segments === true && Boolean(v2.segments) },
    configHash: v2.searchConfigHash ?? v2.configHash };
  const budget = { limits: request.budget ?? {}, truncated: omitted.length > 0, exceeded: false, omitted, omittedCount: omitted.length };
  const digests = { request: sha(JSON.stringify(request)), items: sha(JSON.stringify(items)), result: sha(JSON.stringify({ index, retrieval, items, budget })) };
  write({ schema: 'agent-knowledge.search', schemaVersion: v2.searchSchemaVersion ?? 2, ok: true, status: items.length ? 'ok' : 'no-results', notice: 'fixture',
    request: { profile: request.profile, queries, limit: request.limit, ranker: rankerName, budget: request.budget ?? null },
    appliedScope: { projects: [project], allowedLinks: links, kinds: null, statuses: ['confirmed_policy'] },
    index, retrieval, budget, digests, sections: [], items, codeLocations: [],
    limitations: [...(direct === 0 && items.length ? [{ code: 'no-query-matches', message: 'm', detail: {} }] : []), ...(model.limitations ?? [])] }, items.length ? 0 : 3);
}

if (behaviour === 'timeout') setTimeout(() => {}, 30000);
else if (behaviour === 'big') write('x'.repeat(3 * 1024 * 1024), 0);
else if (behaviour === 'badjson') write('{not json', 0);
else if (behaviour === 'crash') process.exit(1);
else if (behaviour?.startsWith?.('error:')) { const [, code, exit, reason] = behaviour.split(':'); error(code, Number(exit), reason); }
else if (command === 'capabilities') capabilities();
else if (command === 'status') status();
else if (command === 'lease') lease();
else if (command === 'search' && request?.responseVersion === 2) searchV2();
else if (request?.version?.generation !== undefined && request.version.generation !== model.generation) error('index-missing', 5, 'generation-not-found');
else if (command === 'search' && request) searchV1();
else error('usage', 2);
