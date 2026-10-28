import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { temporary } from './helpers.mjs';
import { verificationFixture } from './verification-fixture.mjs';
import { answerFor } from './planning-fixture.mjs';
import { acceptRequest, runRequest } from '../packages/orchestrator/requests.mjs';
import { createInteractions } from '../packages/dashboard/interactions.mjs';
import { gradlePresets, artifactSuggestions, verificationPaths } from '../packages/dashboard/verification.mjs';
import { validateRecipe } from '../packages/verification/live-verification.mjs';
import { runProcess } from '../packages/reasoning/cli-provider.mjs';

// Allow cold PowerShell startup while the Windows CI runner executes other tests.
const launcherTimeoutMs = process.platform === 'win32' ? 30000 : 10000;

test('Gradle configuration recommends test without assuming extra plugin tasks or an installed launcher', t => {
  const root = temporary(t);
  assert.deepEqual(gradlePresets(root), []);
  writeFileSync(join(root, 'build.gradle.kts'), 'plugins { java }\n');
  const [preset] = gradlePresets(root);
  assert.equal(preset.label, 'Gradle test'); assert.equal(preset.recommended, true);
  assert.match(preset.reason, /build.gradle.kts/); assert.match(preset.reason, /실행 파일과 인자를 지정/);
  assert.equal(preset.executable, ''); assert.deepEqual(preset.args, []);
  assert.deepEqual(gradlePresets(root).map(p => p.label), ['Gradle test']);
  assert.deepEqual(gradlePresets(root, 'test·spotbugsMain 통과').map(p => p.label), ['Gradle test', 'Gradle spotbugsMain']);
});

test('standard Gradle wrapper suggestions run in the project folder and preserve nonzero exit status', async t => {
  const root = temporary(t), project = join(root, 'Gradle project with spaces'); mkdirSync(project);
  writeFileSync(join(project, 'build.gradle'), 'plugins { id "java" }\n');
  const windows = process.platform === 'win32';
  writeFileSync(join(project, windows ? 'gradlew.bat' : 'gradlew'), windows
    ? '@echo off\r\necho wrapper-task=%1\r\nexit /b 7\r\n' : 'echo wrapper-task="$1"\nexit 7\n');
  const [preset] = gradlePresets(project);
  assert.match(preset.command, /gradlew/); assert.ok(preset.executable);
  validateRecipe({ schemaVersion: 1, taskId: 'test', allowedPaths: [], artifacts: [], checks: [
    { ...preset, id: 'check-1', criterionIds: ['tests'], timeoutMs: launcherTimeoutMs },
  ] }, { id: 'test', criteria: ['tests'], outputs: [] });
  const output = await runProcess(preset.executable, preset.args, { cwd: project, input: '', timeoutMs: launcherTimeoutMs, captureExit: true });
  assert.equal(output.exitCode, 7, output.stderr); assert.match(output.stdout, /wrapper-task=test/);
});

test('project Gradle script takes precedence over the standard wrapper', async t => {
  const root = temporary(t), windows = process.platform === 'win32'; mkdirSync(join(root, 'scripts'));
  writeFileSync(join(root, windows ? 'gradlew.bat' : 'gradlew'), 'wrapper must not run');
  writeFileSync(join(root, 'scripts', windows ? 'gradle.ps1' : 'gradle.sh'), windows
    ? "Write-Output ('script-task=' + $args[0]); exit 0\n" : 'echo script-task="$1"\nexit 0\n');
  const [preset] = gradlePresets(root);
  assert.match(preset.command, /^scripts\/gradle/);
  const output = await runProcess(preset.executable, preset.args, { cwd: root, input: '', timeoutMs: launcherTimeoutMs, captureExit: true });
  assert.equal(output.exitCode, 0, output.stderr); assert.match(output.stdout, /script-task=test/);
});

test('artifact choices distinguish planned files, test output and static-analysis output', () => {
  const presets = [{ label: 'Gradle test' }, { label: 'Gradle spotbugsMain' }];
  const task = { allowedChanges: ['README.md', 'src/test/**'], outputs: ['README.md 설정 문서', 'src/test/NewTest.java',
    'build/test-results/test 보고서', 'build/reports/spotbugs 보고서', '../outside.txt', '구현 결과'] };
  assert.deepEqual(artifactSuggestions(task, presets), [
    { name: task.outputs[0], path: 'README.md' }, { name: task.outputs[1], path: 'src/test/NewTest.java' },
    { name: task.outputs[2], presetLabel: 'Gradle test' }, { name: task.outputs[3], presetLabel: 'Gradle spotbugsMain' },
    { name: task.outputs[4] }, { name: task.outputs[5] },
  ]);
  assert.deepEqual(artifactSuggestions(task, [presets[0]])[3], { name: task.outputs[3] });
});

test('planned file patterns become exact existing and declared future paths without widening the change scope', t => {
  const root = temporary(t); mkdirSync(join(root, 'src/test'), { recursive: true }); mkdirSync(join(root, 'src/main'));
  writeFileSync(join(root, 'src/test/ExistingTest.java'), 'existing test'); writeFileSync(join(root, 'src/main/App.java'), 'outside');
  const task = { allowedChanges: ['README.md', 'src/test/**'], outputs: ['src/test/NewTest.java', 'src/main/App.java'] };
  assert.deepEqual(verificationPaths(root, task, artifactSuggestions(task, [])), ['README.md', 'src/test/ExistingTest.java', 'src/test/NewTest.java']);
});

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
