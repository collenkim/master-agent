// Real browser and dashboard API; isolated catalog, no managed projects or model calls.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setup } from '../tests/helpers.mjs';
import { startDashboard } from '../packages/dashboard/server.mjs';
import { openBrowser } from './browser.mjs';

const artifactRoot = resolve(process.env.MASTER_AGENT_SMOKE_ROOT ?? '.master-agent');
mkdirSync(artifactRoot, { recursive: true });
const artifacts = mkdtempSync(join(artifactRoot, 'group-delete-browser-')), cleanup = [];
const f = setup({ after(fn) { cleanup.push(fn); } });
const groupId = f.fixture.group.id;
mkdirSync(join(f.fixture.projects[0].path, '.code-agent'));
writeFileSync(join(f.fixture.projects[0].path, '.code-agent/version'), 'fixture');
f.engine.catalog.group({ id: 'empty-delete', name: '<img src=x onerror="window.injected=true"> 빈 그룹', projectIds: [] });
const originalScope = f.store.need('mission', f.mission.id).scope;
let dashboard, browser;
try {
  dashboard = await startDashboard({ dbPath: f.db, port: 0, observe: false, candidateOptions: { cwd: join(f.root, 'workspace'), home: f.root } });
  browser = await openBrowser(dashboard.url, artifacts);
  const { send, evaluate, waitFor, errors } = browser;
  const click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const screenshot = async name => writeFileSync(join(artifacts, name), Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  await waitFor('document.querySelectorAll(".delete-group").length === 2');
  assert.equal(await evaluate('Boolean(window.injected || document.querySelector("#groups img"))'), false);
  for (const width of [1440, 390, 320]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: width < 800 });
    const alignment = await evaluate(`Array.from(document.querySelectorAll('#projects .card-actions, #groups .card-actions')).map(row => {
      const boxes = Array.from(row.querySelectorAll('button')).map(b => b.getBoundingClientRect());
      return { aligned: boxes.every(b => Math.abs(b.y-boxes[0].y)<1 && Math.abs(b.height-boxes[0].height)<1), fits: row.scrollWidth <= row.clientWidth };
    })`);
    assert.ok(alignment.every(row => row.aligned && row.fits), `Button alignment at ${width}: ${JSON.stringify(alignment)}`);
    await evaluate('document.getElementById("groups").scrollIntoView({block:"start"})');
    await screenshot(`group-actions-${width}.png`);
    await evaluate('document.getElementById("projects").scrollIntoView({block:"start"})');
    await screenshot(`project-actions-${width}.png`);
  }
  await evaluate(`window.candidateReads=0;const baseFetch=window.fetch.bind(window);window.fetch=(url,options)=>{
    if(String(url).startsWith('/api/project-candidates'))window.candidateReads++;return baseFetch(url,options);
  }`);
  await click('#new-project');
  await waitFor("window.candidateReads === 1 && !document.getElementById('candidate-refresh').disabled");
  await click('#refresh');
  await waitFor("!document.getElementById('refresh').disabled");
  assert.equal(await evaluate('window.candidateReads'), 1);
  assert.equal(await evaluate("getComputedStyle(document.querySelector('.candidate-pick:disabled')).cursor"), 'default');
  await click('#candidate-refresh');
  await waitFor("window.candidateReads === 2 && !document.getElementById('candidate-refresh').disabled");
  await click('[data-close="project-dialog"]');
  await click(`.delete-group[data-id="${groupId}"]`);
  assert.equal(await evaluate('document.getElementById("delete-group-dialog").open'), true);
  await click('[data-close="delete-group-dialog"]');
  assert.equal(f.store.need('group', groupId).deletedAt, undefined);

  // A different tab changes the group after the confirmation opened.
  await click(`.delete-group[data-id="${groupId}"]`);
  const group = f.store.need('group', groupId);
  f.engine.catalog.group({ ...group, description: '다른 탭에서 수정한 서비스 범위' }, group.revision);
  await evaluate('document.getElementById("delete-group-form").requestSubmit(document.querySelector("#delete-group-form button[type=submit]"))');
  await waitFor('document.getElementById("delete-group-error").textContent.length > 0');
  assert.equal(f.store.need('group', groupId).deletedAt, undefined);
  await click('[data-close="delete-group-dialog"]');
  await click('#refresh');
  await waitFor('document.getElementById("groups").textContent.includes("다른 탭에서 수정한 서비스 범위")');
  await click(`.delete-group[data-id="${groupId}"]`);
  assert.ok((await evaluate('document.getElementById("delete-group-members").textContent')).includes(f.fixture.projects[0].name));
  assert.equal(await evaluate('document.getElementById("delete-group-dialog").scrollWidth <= document.getElementById("delete-group-dialog").clientWidth'), true);
  await screenshot('mobile-group-confirmation.png');
  await evaluate('document.getElementById("delete-group-form").requestSubmit(document.querySelector("#delete-group-form button[type=submit]"))');
  await waitFor(`!document.getElementById('delete-group-dialog').open && !document.querySelector('.delete-group[data-id="${groupId}"]')`);
  assert.equal(f.engine.catalog.projects().length, 3);
  assert.deepEqual(f.store.need('mission', f.mission.id).scope, originalScope);

  // Empty groups can also be deleted and stay absent after a full page reload.
  await click('.delete-group[data-id="empty-delete"]');
  await evaluate('document.getElementById("delete-group-form").requestSubmit(document.querySelector("#delete-group-form button[type=submit]"))');
  await waitFor('!document.getElementById("delete-group-dialog").open && !document.querySelector(".delete-group")');
  await send('Page.reload');
  await waitFor('document.querySelectorAll(".delete-project").length === 3 && document.querySelector("#groups .empty")');
  assert.equal(await evaluate('document.querySelectorAll(".delete-group").length'), 0);
  await click('#new-request');
  assert.equal(await evaluate('document.getElementById("request-target").options.length'), 0);
  await evaluate('document.getElementById("request-type").value="project"; document.getElementById("request-type").dispatchEvent(new Event("change"))');
  assert.equal(await evaluate('document.getElementById("request-target").options.length'), 3);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, artifacts, checks: ['button-alignment-1440-390-320', 'candidate-open-once-and-manual-refresh', 'disabled-cursor', 'cancel', 'stale-confirmation', 'populated-group-delete', 'empty-group-delete', 'project-and-scope-preserved', 'reload', 'request-targets', 'XSS'] }));
} finally {
  await browser?.close();
  await dashboard?.close();
  for (const fn of cleanup.reverse()) fn();
}
