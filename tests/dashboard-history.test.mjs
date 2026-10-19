import test from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.mjs';
import { Store } from '../packages/storage/store.mjs';
import { recordObservation, recordInteraction, createHistory, historyPage } from '../packages/dashboard/history.mjs';
import { dashboardSnapshot } from '../packages/dashboard/monitor.mjs';
import { startDashboard } from '../packages/dashboard/server.mjs';

function stateFor(project, extra = {}) {
  return { schema: 'code-agent.state', schemaVersion: 1, stateVersion: 'v1', observedAt: new Date().toISOString(),
    repo: { root: project.path, branch: 'fix/TASK-1' }, work: { id: 'TASK-1', phase: 'implement', stage: 'test', task: 'module-a', branch: 'fix/TASK-1' },
    attempt: { id: 'attempt-1', kind: 'test' }, planning: { attempts: [{ task: 'module-a', role: 'tester', phase: 'test', dispatchId: 'dispatch-1', status: 'completed', at: new Date().toISOString(), run: { state: 'completed', observedStart: true, agentSession: 'SECRET-SESSION' } }] },
    verification: { rounds: 1, bound: { valid: true, problems: [] }, phases: { test: { round: 1, runs: 2, passed: true } } }, review: { rounds: 2 },
    resume: { code: 'ready', reasons: [] }, questions: { unanswered: [], unverified: [] }, consents: { open: [] },
    ownership: { lease: { state: 'held' }, process: 'unverified' }, unknown: [], ...extra };
}
function observe(store, project, state, status = 'observed') {
  store.transaction(() => {
    const old = store.get('observation', project.id);
    const saved = store.put('observation', { id: project.id, status, recordedAt: new Date().toISOString(), state, lastSuccessfulState: state ?? old?.lastSuccessfulState }, old?.revision ?? 0);
    recordObservation(store, project.id, saved);
  });
}
const event = (seq, extra = {}) => ({ seq, type: 'phase.changed', at: new Date().toISOString(), data: { workId: 'TASK-1', from: 'implement', to: 'test' }, ...extra });
const response = (events, extra = {}) => ({ events, logId: 'log-1', firstSeq: 1, latestSeq: events.at(-1)?.seq ?? 0, gap: false, ...extra });

test('public stage details preserve stage/task/verification/attempts without exposing session or raw fields', t => {
  const { store, fixture } = setup(t), p = fixture.projects[0];
  observe(store, p, stateFor(p, { token: 'SECRET-TOKEN', files: { credential: 'SECRET-PATH' } }));
  const card = dashboardSnapshot(store).projects.find(x => x.id === p.id);
  assert.equal(card.work.stage, 'test'); assert.equal(card.work.task, 'module-a');
  assert.equal(card.stages.verification.phases[0].passed, true);
  assert.equal(card.stages.planning.attempts[0].dispatchId, 'dispatch-1');
  assert.equal(card.stages.attempt.id, 'attempt-1');
  assert.equal(JSON.stringify([card, historyPage(store)]).includes('SECRET'), false);
});

test('independent state changes survive restart; timestamp-only polls deduplicate but retry, branch, failure and recovery remain', t => {
  const { store, fixture, db } = setup(t), p = fixture.projects[0];
  const first = stateFor(p);
  observe(store, p, first);
  observe(store, p, { ...first, observedAt: '2026-10-19T01:00:00Z', stateVersion: 'v2' });
  assert.equal(historyPage(store).items.length, 1);
  const retry = { ...first, attempt: { id: 'attempt-2', kind: 'test' } };
  observe(store, p, retry);
  const other = { ...retry, repo: { ...first.repo, branch: 'fix/OTHER' }, work: { id: 'TASK-1', phase: 'review' } };
  observe(store, p, other);
  observe(store, p, undefined, 'timeout'); observe(store, p, undefined, 'timeout');
  const reopened = new Store(db);
  try {
    observe(reopened, p, other);
    observe(reopened, p, { ...other, work: null, resume: { code: 'no-work', reasons: [] } });
    const items = historyPage(reopened).items;
    assert.equal(items.length, 6);
    assert.equal(items[0].detail.work, null);
    assert.equal(items[1].detail.work.phase, 'review');
    assert.equal(items[2].type, 'observation.unavailable');
    assert.equal(items[3].before.branch, 'fix/TASK-1');
    assert.equal(items[3].branch, 'fix/OTHER');
    assert.equal(items.every(i => i.missionId === null), true);
  } finally { reopened.close(); }
});

test('event collection uses its own persistent cursor, recovers retained events after gaps and separates replaced ledgers', async t => {
  const { store, fixture, db } = setup(t), p = fixture.projects[0];
  store.put('control-binding', { id: p.id });
  store.put('control-cursor', { id: p.id, logId: 'host-ledger', seq: 99 });
  const calls = [];
  let ledger = [event(1), event(2)], logId = 'log-1';
  const client = { async result(type, { payload }) {
    calls.push(payload);
    if (payload.logId && payload.logId !== logId) return response([], { logId, firstSeq: ledger[0].seq, latestSeq: ledger.at(-1).seq, gap: true, reason: 'replaced' });
    if (payload.after + 1 < ledger[0].seq) return response([], { logId, firstSeq: ledger[0].seq, latestSeq: ledger.at(-1).seq, gap: true, reason: 'retained tail' });
    return response(ledger.filter(e => e.seq > payload.after), { logId, firstSeq: ledger[0].seq, latestSeq: ledger.at(-1).seq });
  } };
  const history = createHistory(store, { clientFor: () => client });
  await history.refreshProject(p); await history.refreshProject(p);
  assert.equal(historyPage(store).items.length, 2);
  assert.equal(store.need('control-cursor', p.id).seq, 99);
  const reopened = new Store(db);
  try {
    ledger = [event(5), event(6)];
    await createHistory(reopened, { clientFor: () => client }).refreshProject(p);
    assert.equal(historyPage(reopened).items.length, 5);
    assert.equal(historyPage(reopened).items.filter(i => i.type === 'history.gap').length, 1);
    logId = 'log-2'; ledger = [event(1)];
    await history.refreshProject(p); await history.refreshProject(p);
    assert.equal(historyPage(reopened).items.length, 7);
    assert.equal(store.need('stage-source', p.id).logId, 'log-2');
    assert.equal(calls.some(p => p.after === 4), true);
  } finally { reopened.close(); }
});

test('overlapping event readers cannot duplicate a page and failures preserve prior history/cursor', async t => {
  const { store, fixture } = setup(t), p = fixture.projects[0];
  store.put('control-binding', { id: p.id });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const history = createHistory(store, { clientFor: () => ({ async result() { await gate; return response([event(1)]); } }) });
  const a = history.refreshProject(p), b = history.refreshProject(p); release(); await Promise.all([a, b]);
  assert.equal(historyPage(store).items.length, 1);
  await createHistory(store, { clientFor: () => ({ async result() { throw new Error('SECRET-TOKEN'); } }) }).refreshProject(p);
  assert.equal(store.need('stage-source', p.id).seq, 1);
  assert.equal(historyPage(store).sources.find(s => s.projectId === p.id).error, 'history-unavailable');
  assert.equal(JSON.stringify(historyPage(store)).includes('SECRET'), false);
});

test('history filters retain group membership at collection and correlate only exact project/run bindings', async t => {
  const { store, fixture, mission } = setup(t), [p, other] = fixture.projects;
  store.put('control-binding', { id: p.id });
  const m = store.need('mission', mission.id);
  store.put('mission', { ...m, taskNumber: 'MASTER-1', attempts: [{ id: 'master-attempt', taskId: 'master-task', projectId: p.id, codeAgentWorkId: 'TASK-1' }] }, m.revision);
  store.put('control-run', { id: 'run-1', projectId: p.id, missionId: m.id, attemptId: 'master-attempt' });
  const collector = createHistory(store, { clientFor: () => ({ async result() { return response([event(1, { runId: 'run-1' })]); } }) });
  await collector.refreshProject(p);
  observe(store, other, stateFor(other, { correlation: { runId: 'run-1' } }));
  const group = store.need('group', fixture.group.id);
  store.put('group', { ...group, projectIds: [] }, group.revision);
  assert.equal(historyPage(store, { task: 'MASTER-1' }).items.length, 1);
  assert.equal(historyPage(store, { task: 'MASTER-1' }).items[0].projectId, p.id);
  assert.equal(historyPage(store, { groupId: group.id }).items.length, 2);
  const page = historyPage(store, { limit: 1 });
  const next = historyPage(store, { limit: 1, before: page.nextBefore });
  assert.notEqual(page.items[0].sequence, next.items[0].sequence); assert.equal(next.nextBefore, null);
  assert.equal(historyPage(store, { projectId: other.id, task: 'MASTER-1' }).items.length, 0);
});

test('inbox transitions are appended without copying answers or repeatedly recording availability changes', t => {
  const { store, fixture } = setup(t), p = fixture.projects[0];
  const item = { id: 'question-1', projectIds: [p.id], groupIds: [fixture.group.id], workId: 'TASK-1', kind: 'question', stage: 'review', title: 'Confirm result', producerState: 'open' };
  for (const value of [item, { ...item, respondSupported: true }, { ...item, producerState: 'answered', remote: { response: { answer: 'SECRET-ANSWER' }, application: { state: 'applied' } } }]) store.transaction(() => recordInteraction(store, value));
  assert.equal(historyPage(store).items.length, 2);
  assert.equal(historyPage(store).items[0].detail.application, 'applied');
  assert.equal(JSON.stringify(historyPage(store)).includes('SECRET'), false);
});

test('history HTTP paginates, validates input and retains same-origin restrictions', async t => {
  const { store, fixture, db } = setup(t), p = fixture.projects[0];
  observe(store, p, stateFor(p));
  const server = await startDashboard({ dbPath: db, port: 0, observe: false });
  try {
    const view = await (await fetch(server.url + '/api/history?limit=1')).json();
    assert.equal(view.items.length, 1);
    assert.equal((await fetch(server.url + '/api/history?limit=-1')).status, 400);
    assert.equal((await fetch(server.url + '/api/history?before=NaN')).status, 400);
    assert.equal((await fetch(server.url + '/api/history?projectId=missing')).status, 404);
    assert.equal((await fetch(server.url + '/api/history', { headers: { Origin: 'https://other.example' } })).status, 403);
    assert.equal((await fetch(server.url + '/history.mjs')).status, 200);
  } finally { await server.close(); }
});
