// Real browser, dashboard API and code-agent build; isolated CODE_AGENT_HOME/CODEX_HOME and project, no request runner or model calls.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../packages/storage/store.mjs';
import { Engine } from '../packages/orchestrator/engine.mjs';
import { startDashboard } from '../packages/dashboard/server.mjs';
import { openBrowser } from './browser.mjs';

const DIST = resolve(process.env.CODE_AGENT_DIST ?? join(dirname(fileURLToPath(import.meta.url)), '../../code-agent/dist'));
const CLI = join(DIST, 'agent/cli.js');
assert.ok(existsSync(CLI) && readFileSync(join(DIST, 'agent/master/trust.js'), 'utf8').includes('masterTrustConfirmed'), `화면 신뢰를 지원하는 code-agent 빌드가 필요합니다: ${DIST}`);
mkdirSync(resolve('.master-agent'), { recursive: true });
const artifacts = mkdtempSync(resolve('.master-agent/trust-browser-'));
const home = join(artifacts, 'home'), codex = join(artifacts, 'codex'), path = join(artifacts, 'project');
for (const dir of [home, codex, path]) mkdirSync(dir);
// The user's real trust store is never touched. CLAUDECODE stays set like a dashboard started from a host session.
Object.assign(process.env, { CODE_AGENT_HOME: home, CODEX_HOME: codex, CLAUDECODE: '1' });
const git = args => execFileSync('git', ['-C', path, ...args], { stdio: 'pipe' });
git(['init', '-q']); git(['config', 'user.name', 't']); git(['config', 'user.email', 't@t']);
writeFileSync(join(path, 'README.md'), 'x\n'); git(['add', '-A']); git(['commit', '-qm', 'init']);
writeFileSync(join(artifacts, 'init.cjs'), `const [dist, root] = process.argv.slice(2);\nrequire(dist + '/agent/init.js').init(root, { host: 'claude' });\n`);
execFileSync(process.execPath, [join(artifacts, 'init.cjs'), DIST, path], { stdio: 'pipe' });
const dbPath = join(artifacts, 'master.db'), store = new Store(dbPath);
new Engine(store).catalog.register({ id: 'trust-p', name: 'trust-project', path, domains: ['fixture'], capabilities: ['code-agent:claude'], constraints: [], currentPlans: [], references: ['fixture'] });
store.close();

let dashboard, browser;
try {
  dashboard = await startDashboard({ dbPath, port: 0, cliPath: CLI, intervalMs: 1000 });
  browser = await openBrowser(dashboard.url, artifacts);
  const { send, evaluate, waitFor, errors } = browser;
  const text = id => evaluate(`document.getElementById(${JSON.stringify(id)}).textContent`);
  const disabled = id => evaluate(`document.getElementById(${JSON.stringify(id)}).disabled`);
  const type = value => evaluate(`document.getElementById('trust-word').value=${JSON.stringify(value)}; document.getElementById('trust-word').dispatchEvent(new Event('input'))`);
  const screenshot = async name => writeFileSync(join(artifacts, name), Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  const cardShot = async name => (await evaluate(`document.querySelector('#projects .connection').scrollIntoView({ block: 'center' })`), screenshot(name));

  await waitFor(`document.querySelector('#projects .trust-pc') && document.getElementById('projects').textContent.includes('PC 신뢰 필요')`);
  assert.match(await text('projects'), /또는 터미널\(PC당 1회\)/);
  await cardShot('card-trust-missing.png');
  await evaluate(`document.querySelector('#projects .trust-pc').click()`);
  await waitFor(`document.getElementById('trust-dialog').open && document.getElementById('trust-lines').textContent.includes('master-trust')`);
  const lines = await text('trust-lines');
  assert.ok(lines.includes(join(home, 'master-trust')), lines);
  assert.match(lines, /대시보드를 부를 수 있는 프로세스도/);
  assert.equal(await disabled('trust-submit'), true, '확인 단어 전에는 신뢰하지 않는다');
  await type('Trust'); assert.equal(await disabled('trust-submit'), true, '확인 단어는 그대로 입력한다');
  await type('trust'); assert.equal(await disabled('trust-submit'), false);
  for (const width of [1440, 390, 320]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: width < 800 });
    assert.equal(await evaluate(`document.getElementById('trust-dialog').scrollWidth <= document.getElementById('trust-dialog').clientWidth`), true, `dialog fits ${width}`);
    await screenshot(`trust-dialog-${width}.png`);
  }
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await evaluate(`document.getElementById('trust-form').requestSubmit(document.getElementById('trust-submit'))`);
  await waitFor(`!document.getElementById('trust-dialog').open && document.getElementById('action-status').textContent.includes('신뢰합니다')`);
  const entry = JSON.parse(readFileSync(join(home, 'master-trust.json'), 'utf8')).controllers.dashboard;
  assert.equal(entry.createdBy.channel, 'dashboard');
  assert.ok(existsSync(join(home, 'master-trust', 'dashboard.pem')));

  await waitFor(`document.querySelector('#projects .pair-project') && document.getElementById('projects').textContent.includes('제어 연결 가능')`);
  assert.equal(await evaluate(`Boolean(document.querySelector('#projects .trust-pc'))`), false, '신뢰한 뒤에는 PC 신뢰 버튼이 없다');
  await cardShot('card-pairing-available.png');
  await evaluate(`document.querySelector('#projects .pair-project').click()`);
  await waitFor(`document.getElementById('pair-dialog').open && document.getElementById('pair-lines').textContent.includes('trust-project')`);
  await evaluate(`document.getElementById('pair-confirm').click()`);
  await evaluate(`document.getElementById('pair-form').requestSubmit(document.getElementById('pair-submit'))`);
  await waitFor(`!document.getElementById('pair-dialog').open && document.getElementById('action-status').textContent.includes('제어 연결을 등록했습니다')`);
  await waitFor(`document.getElementById('projects').textContent.includes('제어 연결됨')`);
  await cardShot('card-connected.png');
  const records = new Store(dbPath); const stored = JSON.stringify(records.db.prepare('SELECT body FROM records').all()); records.close();
  assert.equal(stored.includes('PRIVATE KEY'), false, '개인 키는 DB에 남기지 않는다');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, artifacts, codeAgent: DIST, fingerprint: entry.fingerprint, checks: ['card-trust-button', 'code-agent-text', 'typed-word-required',
    'dialog-1440-390-320', 'host-marker-not-passed', 'trust-record-dashboard', 'card-pairing-available', 'pair-after-trust', 'card-connected', 'no-private-key-in-db'] }));
} finally {
  await browser?.close();
  await dashboard?.close();
}
