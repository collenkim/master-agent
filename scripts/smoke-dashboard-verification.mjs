// Isolated browser exercise: synthetic project/launcher, no managed project or model calls.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { verificationFixture } from '../tests/verification-fixture.mjs';
import { startDashboard } from '../packages/dashboard/server.mjs';
import { openBrowser } from './browser.mjs';

const cleanup = [], f = verificationFixture({ after(fn) { cleanup.push(fn); } });
writeFileSync(join(f.projects[0].path, 'build.gradle.kts'), 'plugins { java }\n');
writeFileSync(join(f.projects[0].path, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew'), 'browser fixture: never executed\n');
let mission = f.engine.create({ mode: 'live', goal: '검증 화면 확인', requestKey: 'browser-verification', taskNumber: 'BROWSER-1',
  scope: { projectIds: ['one'], groupIds: [] }, criteria: [{ id: 'value', description: '실제 값 검사' }] });
mission = f.engine.plan(mission.id, { schemaVersion: 1, summary: '검증 계약 없는 계획', unresolved: [],
  tasks: [f.tasks[0], { ...f.tasks[2], dependsOn: ['edit-one'] }].map(task => ({ ...task,
    verification: 'Gradle test·spotbugsMain 실행 결과와 파일을 확인합니다.',
    outputs: ['source.mjs', 'build/test-results/test 보고서', 'build/reports/spotbugs 보고서'],
    goal: `${task.goal} · ${'JWT 검증과 테넌트 처리를 유지하고 환경변수·설정·테스트로 완료 조건을 확인합니다. '.repeat(8)}`,
    allowedChanges: [...task.allowedChanges, 'src/test/java/com/example/platform/gateway/verification/GatewayAuthenticationAuthorizationIntegrationTest.java'] })) }, mission.revision);
f.store.put('target-request', { id: mission.id, state: 'waiting', targetType: 'project', targetId: 'one', taskNumber: 'BROWSER-1',
  goal: mission.goal, blockers: ['edit-one:missing-verification-recipe'], provider: 'fixture',
  projectIds: ['one'], templatesRegistered: true, templates: [], createdAt: new Date().toISOString() });
const artifactRoot = resolve(process.env.MASTER_AGENT_SMOKE_ROOT ?? '.master-agent');
mkdirSync(artifactRoot, { recursive: true });
const artifacts = mkdtempSync(join(artifactRoot, 'verification-browser-'));
let launches = 0, browser;
const dashboard = await startDashboard({ dbPath: join(f.root, 'state.db'), port: 0, observe: false,
  launch: async (store, id) => { launches++; return store.need('target-request', id); } });
try {
  const response = await fetch(`${dashboard.url}/api/overview`), overview = await response.json();
  assert.equal(response.status, 200, JSON.stringify(overview));
  const inbox = await (await fetch(`${dashboard.url}/api/interactions`)).json();
  assert.equal(inbox.items.filter(i => i.handler === 'verification').length, 1);
  browser = await openBrowser(dashboard.url, artifacts);
  const { evaluate, waitFor, send, errors } = browser;
  await waitFor(`document.querySelector('[data-interaction]')`);
  await evaluate(`document.querySelector('[data-interaction]').click()`);
  assert.equal(await evaluate(`document.querySelectorAll('[data-verification-task]').length`), 2);
  const recommendations = inbox.items.find(i => i.handler === 'verification').verificationSetup.tasks.map(t => t.presets.find(p => p.recommended));
  assert.equal(await evaluate(`document.querySelectorAll('[data-verification-recommendation]').length`), 2);
  assert.ok((await evaluate(`document.querySelector('[data-verification-recommendation]').textContent`)).includes('Gradle test'));
  assert.equal(await evaluate(`document.getElementById('interaction-recommendation').hidden`), true);
  assert.equal(await evaluate(`document.querySelector('[data-executable]').value`), recommendations[0].executable);
  assert.equal(await evaluate(`document.querySelector('[data-args]').value`), recommendations[0].args.join('\n'));
  assert.equal(await evaluate(`document.getElementById('verification-reviewed').checked`), false);
  assert.equal(await evaluate(`document.getElementById('interaction-submit').disabled`), true);
  assert.equal(await evaluate(`document.getElementById('interaction-form').checkValidity()`), true, 'defaults need no manual file paths or check numbers');
  assert.equal(await evaluate(`document.querySelectorAll('[data-check-details][open]').length`), 0);
  assert.equal(await evaluate(`document.querySelector('[data-artifact-selection]').value`), 'file:source.mjs');
  assert.equal(await evaluate(`document.querySelectorAll('[data-verification-task]')[0].querySelectorAll('[data-artifact-selection]')[1].value`), 'check:check-1');
  assert.equal(await evaluate(`document.querySelectorAll('[data-verification-task]')[0].querySelectorAll('[data-artifact-selection]')[2].value`), 'check:check-2');
  await evaluate(`document.getElementById('verification-reviewed').click()`);
  assert.equal(await evaluate(`document.getElementById('interaction-submit').disabled`), false, 'selection defaults are submittable after review');
  assert.equal(launches, 0);
  for (const [width, height] of [[1440, 900], [768, 600], [390, 844], [320, 640]]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 500 });
    await evaluate(`document.getElementById('interaction-close').click()`);
    await waitFor(`!document.getElementById('interaction-dialog').open`);
    await evaluate(`document.querySelector('[data-interaction]').click()`);
    assert.equal(await evaluate(`(() => { const dialog = document.getElementById('interaction-dialog'), title = document.getElementById('interaction-title');
      const d = dialog.getBoundingClientRect(), t = title.getBoundingClientRect();
      return dialog.scrollWidth <= dialog.clientWidth && dialog.scrollTop === 0 && t.top >= d.top && t.bottom <= d.bottom && d.left >= 0 && d.right <= innerWidth;
    })()`), true, `layout at ${width}x${height}`);
  }
  // Removing a check only invalidates outputs bound to it; surviving check IDs must never be renumbered.
  await evaluate(`document.querySelector('[data-remove-check]').click()`);
  assert.equal(await evaluate(`document.querySelector('[data-verification-task]').querySelectorAll('[data-artifact-selection]')[1].value`), '');
  assert.equal(await evaluate(`document.querySelector('[data-verification-task]').querySelectorAll('[data-artifact-selection]')[2].value`), 'check:check-2');
  await evaluate(`{ const selected = document.querySelector('[data-verification-task]').querySelectorAll('[data-artifact-selection]')[1]; selected.value='add:0'; selected.dispatchEvent(new Event('change',{bubbles:true})); }`);
  assert.equal(await evaluate(`document.querySelector('[data-verification-task]').querySelectorAll('[data-artifact-selection]')[1].value`), 'check:check-3');
  assert.equal(await evaluate(`document.querySelector('[data-verification-task]').querySelectorAll('[data-artifact-selection]')[2].value`), 'check:check-2');
  await evaluate(`{ const selected = document.querySelector('[data-artifact-selection]'); selected.value='custom'; selected.dispatchEvent(new Event('change',{bubbles:true})); }`);
  assert.equal(await evaluate(`document.querySelector('[data-artifact-custom-label]').hidden`), false);
  assert.equal(await evaluate(`document.getElementById('interaction-form').checkValidity()`), false);
  await evaluate(`{ const selected = document.querySelector('[data-artifact-selection]'); selected.value='file:source.mjs'; selected.dispatchEvent(new Event('change',{bubbles:true})); }`);
  assert.equal(await evaluate(`document.querySelector('[data-artifact-custom-label]').hidden`), true);
  await evaluate(`document.querySelectorAll('[data-verification-task]').forEach(section => {
    const selected = section.querySelector('[data-check-preset]'); selected.value='custom'; selected.dispatchEvent(new Event('change',{bubbles:true}));
    section.querySelector('[data-executable]').value = ${JSON.stringify(process.execPath)};
    section.querySelector('[data-args]').value = ${JSON.stringify(join(f.projects[0].path, 'check.mjs'))};
    section.querySelector('[data-work-records]').click();
    section.querySelector('[data-args]').dispatchEvent(new Event('input', {bubbles:true}));
  }); document.getElementById('verification-reviewed').click()`);
  assert.equal(await evaluate(`document.getElementById('interaction-submit').disabled`), false);
  await evaluate(`document.querySelector('[data-timeout]').value = '30'; document.querySelector('[data-timeout]').dispatchEvent(new Event('input', {bubbles:true}))`);
  assert.equal(await evaluate(`document.getElementById('interaction-submit').disabled`), true);
  await evaluate(`document.getElementById('interaction-close').click()`);
  await waitFor(`!document.getElementById('interaction-dialog').open`);
  await evaluate(`document.querySelector('[data-interaction]').click()`);
  assert.equal(await evaluate(`document.querySelector('[data-executable]').value`), process.execPath);
  assert.equal(await evaluate(`document.querySelector('[data-work-records]').checked`), true);
  assert.equal(await evaluate(`document.querySelector('[data-verification-task]').querySelectorAll('[data-artifact-selection]')[1].value`), 'check:check-3');
  assert.equal(await evaluate(`document.querySelector('[data-verification-task]').querySelectorAll('[data-artifact-selection]')[2].value`), 'check:check-2');
  assert.equal(await evaluate(`document.getElementById('verification-reviewed').checked`), false);
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  assert.equal(await evaluate(`document.getElementById('interaction-dialog').scrollWidth <= document.getElementById('interaction-dialog').clientWidth`), true);
  writeFileSync(join(artifacts, 'verification-mobile.png'), Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  await evaluate(`document.getElementById('verification-reviewed').click(); document.getElementById('interaction-form').requestSubmit()`);
  await waitFor(`document.getElementById('interaction-error').textContent.includes('적용')`);
  const saved = f.store.need('mission', mission.id);
  assert.equal(Object.keys(saved.verificationRecipes).length, 2);
  assert.equal(saved.verificationRecipes['edit-one'].codeAgentRecords, true);
  assert.deepEqual(saved.verificationRecipes['edit-one'].artifacts, [
    { name: 'source.mjs', path: 'source.mjs' }, { name: 'build/test-results/test 보고서', checkId: 'check-3' },
    { name: 'build/reports/spotbugs 보고서', checkId: 'check-2' },
  ]);
  assert.equal(saved.taskNumber, 'BROWSER-1'); assert.equal(launches, 1);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, synthetic: true, checks: ['selection-without-manual-input', 'stable-output-binding-after-check-removal', 'artifact-select-adds-check', 'custom-input-only-on-request', 'gradle-recommendation-visible', 'recommended-command-prefilled', 'no-automatic-approval', 'all-task-contracts', 'explicit-review', 'edit-resets-review',
    'draft-restored', 'work-records-option', 'long-content-1440-768-390-320', 'open-at-title', 'mobile', 'atomic-submit', 'same-task-single-launch'], artifacts }));
} finally {
  await browser?.close(); await dashboard.close();
  for (const fn of cleanup.reverse()) fn();
}
