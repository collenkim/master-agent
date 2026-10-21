import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { verificationFixture } from './verification-fixture.mjs';
import { answerFor } from './planning-fixture.mjs';
import { acceptRequest, runRequest } from '../packages/orchestrator/requests.mjs';
import { createInteractions } from '../packages/dashboard/interactions.mjs';

async function waiting(t) {
  const f = verificationFixture(t);
  const tasks = [f.tasks[0], { ...f.tasks[2], dependsOn: ['edit-one'] }];
  const request = acceptRequest(f.store, { targetType: 'project', targetId: 'one', goal: '값을 2로 변경', taskNumber: 'NO-TEMPLATES',
    criteria: [{ id: 'value', description: '값이 2다' }] }).request;
  const provider = { name: 'fixture', async generate({ context }) {
    const data = answerFor(context); data.plan.tasks = tasks.map(t => ({ ...t, planAcknowledgements: [], coordination: '',
      references: context.projects[0].sources.map(s => s.id) })); return { data };
  } };
  const inspect = f.host.inspect;
  f.host.inspect = async project => {
    const attempt = f.store.need('mission', request.id).attempts.filter(a => a.projectId === project.id).at(-1);
    if (attempt?.state === 'verified') Object.assign(f.states[project.id], { work: null, request: null, resume: { code: 'no-work' }, stateVersion: `ended-${attempt.id}` });
    return inspect(project);
  };
  const result = await runRequest(f.store, request.id, { host: f.host, provider });
  assert.equal(result.state, 'waiting'); assert.deepEqual(result.blockers, ['edit-one:missing-verification-recipe']);
  const recipes = tasks.map(t => ({ ...structuredClone(f.recipes.find(r => r.taskId === t.id)), checks: structuredClone(f.recipes[0].checks) }));
  let launches = 0;
  const inbox = createInteractions(f.store, { launch: async (store, id) => { launches++; return runRequest(store, id, { host: f.host, provider }); } });
  const item = inbox.snapshot().items.find(i => i.missionId === request.id && i.handler === 'verification');
  const input = { id: item.id, revision: item.revision, context: item.context, contentHash: item.contentHash, commandId: randomUUID(),
    action: 'answer', optionIds: ['configure'], recipes, reviewed: true, resume: true };
  return { ...f, request, inbox, item, input, launches: () => launches };
}
test('request without templates reaches dashboard contract review then real verification and completion on the same TASK', async t => {
  const f = await waiting(t);
  assert.equal(f.item.verificationSetup.tasks.length, 2);
  assert.equal(f.store.need('mission', f.request.id).attempts.length, 0);
  await f.inbox.respond(f.input);
  assert.equal(f.store.need('target-request', f.request.id).state, 'completed');
  assert.equal(f.store.need('mission', f.request.id).taskNumber, 'NO-TEMPLATES');
  assert.equal(f.store.need('mission', f.request.id).attempts.length, 2);
  await f.inbox.respond(f.input); assert.equal(f.launches(), 1);
  await assert.rejects(f.inbox.respond({ ...f.input, reviewed: false }), { code: 'request-conflict' });
});
test('contract confirmation is explicit and invalid later contracts roll back all registrations and receipts', async t => {
  const f = await waiting(t), revision = f.store.need('mission', f.request.id).revision;
  await assert.rejects(f.inbox.respond({ ...f.input, reviewed: false }), { code: 'invalid-input' });
  const broken = structuredClone(f.input); broken.recipes[1].checks = [];
  await assert.rejects(f.inbox.respond(broken), { code: 'invalid-recipe' });
  assert.equal(f.store.need('mission', f.request.id).revision, revision);
  assert.deepEqual(f.store.need('mission', f.request.id).verificationRecipes, {});
  assert.equal(f.store.get('interaction-command', f.input.commandId), undefined); assert.equal(f.launches(), 0);
});
