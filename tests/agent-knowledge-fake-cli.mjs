#!/usr/bin/env node
// agent-knowledge search·get v1 계약을 흉내 내는 대역 CLI(실제 색인·검색이 아니다).
// --db 경로의 JSON 모형을 읽고, 요청마다 모형의 log 파일에 한 줄씩 남긴다.
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const argv = process.argv.slice(2), command = argv[0];
const option = name => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const model = JSON.parse(readFileSync(option('--db'), 'utf8'));
const request = JSON.parse(readFileSync(option('--request'), 'utf8'));
const calls = model.log && existsSync(model.log) ? readFileSync(model.log, 'utf8').split('\n').filter(Boolean).length : 0;
if (model.log) appendFileSync(model.log, `${JSON.stringify({ command, request, retrievalConfig: option('--retrieval-config'), config: option('--config') ?? null })}\n`);
const sha = text => createHash('sha256').update(text).digest('hex');
const write = (doc, code) => { process.stdout.write(`${typeof doc === 'string' ? doc : JSON.stringify(doc)}\n`); process.exitCode = code; };
const error = (code, exit, reason) => write({ schema: 'agent-knowledge.error', schemaVersion: 1, ok: false, error: { code, message: `${code} C:\\secret\\path`, detail: reason ? { reason } : {} } }, exit);
const project = request.scope?.projects?.[0];
const behaviour = model.behaviour?.[project] ?? model.behaviour?.['*'];
const publishedAt = model.publishedAtAfter && calls >= model.publishedAtAfter.calls ? model.publishedAtAfter.value : model.publishedAt;

function render(item, reasons, rank, terms) {
  const source = model.sources.find(s => s.sourceId === item.sourceId);
  const excerpt = item.excerpt;
  const lines = excerpt.split('\n').length;
  const base = { id: item.id, key: item.key ?? null, projectId: item.projectId, sourceId: item.sourceId, kind: item.kind, unit: item.unit ?? 'entry',
    title: item.title ?? item.id, headingPath: item.headingPath ?? [item.title ?? item.id], excerpt, excerptTruncated: item.excerptTruncated ?? false,
    provenance: { path: item.path, startLine: item.startLine ?? 1, endLine: item.endLine ?? (item.startLine ?? 1) + lines - 1,
      excerptStartLine: item.startLine ?? 1, excerptEndLine: item.endLine ?? (item.startLine ?? 1) + lines - 1, anchor: item.key ?? 'a',
      commit: item.commit ?? source.commit, blobSha: item.blobSha ?? sha(`blob:${item.path}`).slice(0, 40), documentSha256: item.documentSha256 ?? sha(`doc:${item.path}`),
      itemSha256: item.itemSha256 ?? sha(excerpt), parserVersion: 'md-1', chunkerVersion: 'chunk-1', generation: item.generation ?? model.generation, firstGeneration: 1 },
    knowledge: { status: item.status ?? 'confirmed_policy', confirmed: item.confirmed ?? (item.status ?? 'confirmed_policy') === 'confirmed_policy', reason: 'fixture', basis: null, conflicts: item.conflicts ?? [] },
    selection: { section: item.mandatory && reasons[0] === 'mandatory' ? 'mandatory' : item.section ?? 'policies', rank, score: reasons[0] === 'mandatory' ? 0 : 1, reasons, matchedTerms: terms },
    links: [] };
  return item.override ? { ...base, ...item.override, provenance: { ...base.provenance, ...(item.override.provenance ?? {}) } } : base;
}

if (behaviour === 'timeout') setTimeout(() => {}, 30000);
else if (behaviour === 'big') write('x'.repeat(3 * 1024 * 1024), 0);
else if (behaviour === 'badjson') write('{not json', 0);
else if (behaviour === 'crash') process.exit(1);
else if (behaviour?.startsWith?.('error:')) { const [, code, exit, reason] = behaviour.split(':'); error(code, Number(exit), reason); }
else if (request.version?.generation !== undefined && request.version.generation !== model.generation) error('index-missing', 5, 'generation-not-found');
else if (command === 'search') {
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
} else error('usage', 2);
