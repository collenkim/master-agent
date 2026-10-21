import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { planningSetup, blockedAnswer } from './planning-fixture.mjs';
import { createInteractions } from '../packages/dashboard/interactions.mjs';
import { continueRequest, runRequest } from '../packages/orchestrator/requests.mjs';

async function mixed(t) {
  const f = planningSetup(t);
  const result = await f.planner.analyze(f.mission.id, { name: 'fixture', async generate({ context }) {
    const data = blockedAnswer(context, true); data.status = 'needs-context';
    data.issues.push({ ...data.issues[0], id: 'info', kind: 'information' });
    return { data, review: { verdict: 'approve' } };
  } }, { expectedRevision: f.mission.revision, maxPasses: 1 });
  return { ...f, result };
}
function legacy(f) {
  const r = f.store.need('analysis-run', f.result.analysis.id);
  const data = { ...r.result, status: 'needs-context' };
  f.store.put('analysis-run', { ...r, status: 'invalid', result: null, error: { code: 'issue-classification', message: '분류 오류' },
    passes: [{ ...r.passes[0], data }] }, r.revision);
}
test('mixed critical questions become human review without losing choices or activating a plan', async t => {
  const f = await mixed(t);
  assert.equal(f.result.analysis.status, 'needs-human');
  assert.equal(f.result.analysis.passes[0].originalStatus, 'needs-context');
  assert.equal(f.result.mission.plans.length, 0);
  const items = createInteractions(f.store).snapshot().items;
  assert.equal(items.length, 2); assert.ok(items.every(i => i.options.length === 2));
});
test('old classification failures are repaired as a new audited analysis and require actual answers', async t => {
  const f = await mixed(t); legacy(f);
  const m = f.store.need('mission', f.mission.id);
  const repaired = f.planner.repairClassification(m.id, m.revision);
  assert.notEqual(repaired.analysisRunId, m.analysisRunId);
  assert.equal(f.store.need('analysis-run', m.analysisRunId).status, 'invalid');
  assert.equal(repaired.state, 'waiting-decision'); assert.equal(repaired.attempts.length, 0);
  assert.equal(createInteractions(f.store).snapshot().items.filter(i => i.handler === 'analysis').length, 2);
});
test('stale evidence prevents classification repair', async t => {
  const f = await mixed(t); legacy(f);
  writeFileSync(join(f.fixture.projects[0].path, 'POLICY.md'), 'changed');
  const m = f.store.need('mission', f.mission.id);
  assert.equal(f.planner.repairClassification(m.id, m.revision), null);
  assert.equal(f.store.need('mission', m.id).analysisRunId, m.analysisRunId);
});

test('a rejected or missing cross-review cannot be repaired into questions', async t => {
  const f = await mixed(t); legacy(f);
  const m = f.store.need('mission', f.mission.id);
  for (const review of [{ verdict: 'reject' }, undefined]) {
    const run = f.store.need('analysis-run', m.analysisRunId);
    f.store.put('analysis-run', { ...run, provider: 'claude+codex', passes: [{ ...run.passes[0], review }] }, run.revision);
    assert.equal(f.planner.repairClassification(m.id, m.revision), null);
  }
});

test('a changed mission cannot reuse an old classification failure', async t => {
  const f = await mixed(t); legacy(f);
  const m = f.store.need('mission', f.mission.id);
  const changed = f.store.put('mission', { ...m, goal: 'changed request' }, m.revision);
  assert.equal(f.planner.repairClassification(changed.id, changed.revision), null);
});
test('invalid analysis has an actionable retry item, never unvalidated business options', async t => {
  const f = await mixed(t); legacy(f);
  const id = f.mission.id;
  f.store.put('target-request', { id, state: 'waiting', projectIds: f.fixture.projects.map(p => p.id), createdAt: new Date().toISOString() });
  let launches = 0;
  const inbox = createInteractions(f.store, { launch: async (store, id) => { launches++; return store.need('target-request', id); } });
  const item = inbox.snapshot().items.find(i => i.handler === 'analysis-error');
  assert.deepEqual(item.options.map(o => o.id), ['reanalyze']);
  await inbox.respond({ id: item.id, revision: item.revision, contentHash: item.contentHash, context: item.context,
    commandId: randomUUID(), action: 'answer', optionIds: ['reanalyze'], resume: true });
  assert.equal(launches, 1); assert.equal(f.store.need('mission', id).clarifications, undefined);
});

test('public interaction IDs remain visible without a binding and are replaced by the authenticated feed', async t => {
  const f = planningSetup(t), project = f.fixture.projects[0];
  f.store.put('observation', { id: project.id, status: 'observed', state: { repo: {}, work: null,
    interactions: { pending: ['unseen-1', 'unseen-2'], deferred: ['unseen-1'], responded: [] }, questions: null } });
  let records;
  const inbox = createInteractions(f.store, { readRemote: async () => ({ capability: { responseSupported: Boolean(records) }, records }) });
  await inbox.refreshProject(project);
  let items = inbox.snapshot().items;
  assert.equal(items.length, 2); assert.ok(items.every(i => i.connectionRequired && !i.respondSupported && !i.options.length));
  records = [{ schemaVersion: 1, source: 'code-agent', sourceInstanceId: 'connected', requestId: 'unseen-1',
    revision: 1, contentHash: 'hash', context: { workId: null }, questions: [], title: 'original', stage: 'setup',
    kind: 'question', status: 'pending', canRespond: false }];
  await inbox.refreshProject(project);
  items = inbox.snapshot().items;
  assert.equal(items.filter(i => i.state === 'open').length, 1);
  assert.ok(items.filter(i => i.handler === 'legacy').every(i => i.state === 'expired'));
});

test('earlier answers show the current blocker after all answers are submitted', async t => {
  const f = await mixed(t), id = f.mission.id;
  f.store.put('target-request', { id, state: 'waiting', projectIds: f.fixture.projects.map(p => p.id), createdAt: new Date().toISOString() });
  const inbox = createInteractions(f.store, { launch: async (store, id) => store.need('target-request', id) });
  const respond = item => inbox.respond({ id: item.id, revision: item.revision, contentHash: item.contentHash, context: item.context,
    commandId: randomUUID(), action: 'answer', optionIds: ['1'], resume: true });
  const first = inbox.snapshot().items[0]; await respond(first);
  assert.equal(inbox.snapshot().items.find(i => i.id === first.id).history[0].resume.state, 'waiting-answers');
  await respond(inbox.snapshot().items.find(i => i.state === 'open'));
  const request = f.store.need('target-request', id);
  f.store.put('target-request', { ...request, state: 'waiting', preparation: { issues: [{ projectId: f.fixture.projects[0].id,
    code: 'missing-verification-recipe', message: '검증 계약 필요', guidance: '계약 등록' }] } }, request.revision);
  const history = inbox.snapshot().items.flatMap(i => i.history);
  assert.ok(history.every(h => h.resume.state === 'blocked' && h.resume.reason === '검증 계약 필요'));
  const waiting = f.store.need('target-request', id);
  f.store.put('target-request', { ...waiting, state: 'completed' }, waiting.revision);
  assert.ok(inbox.snapshot().items.flatMap(i => i.history).every(h => h.resume.state === 'completed'));
});

test('continuing an unanswered analysis keeps its questions without invoking the model or execution host', async t => {
  const f = await mixed(t), id = f.mission.id;
  const request = f.store.put('target-request', { id, state: 'waiting', templatesRegistered: true, templates: [],
    projectIds: f.fixture.projects.map(p => p.id), createdAt: new Date().toISOString() });
  continueRequest(f.store, id, request.revision);
  const result = await runRequest(f.store, id, { host: {}, provider: { name: 'never', generate() { assert.fail('regenerated pending questions'); } },
    workflow: { run() { assert.fail('executed before answers'); } } });
  assert.equal(result.state, 'waiting'); assert.deepEqual(result.blockers, ['human-input']);
  assert.equal(f.store.need('mission', id).analysisRunId, f.result.analysis.id);
});
