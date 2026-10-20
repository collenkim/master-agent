import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setup, temporary } from './helpers.mjs';
import { connectionState, controlProbe, findTrustKey, trustStoreDir } from '../packages/code-agent-adapter/pairing.mjs';
import { pairControl, pairingPreview, retryPairing } from '../packages/runner/control-pairing.mjs';
import { dashboardSnapshot } from '../packages/dashboard/monitor.mjs';
import { startDashboard } from '../packages/dashboard/server.mjs';

const fakeCli = fileURLToPath(new URL('./pairing-fake-cli.mjs', import.meta.url));

/** 신뢰 키 한 쌍과 code-agent 페어링 시험 대역 상태를 준비한다 — 실제 사용자 홈의 키는 읽지 않는다 */
function pairingSetup(t, state = {}) {
  const f = setup(t, { plan: false }), project = f.store.need('project', f.fixture.projects[0].id);
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const trustDir = join(f.root, 'home', 'master-trust'); mkdirSync(trustDir, { recursive: true });
  const keyPath = join(trustDir, 'dashboard.pem'); writeFileSync(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }));
  const stateFile = join(dirname(project.path), `${basename(project.path)}.fake-code-agent.json`);
  const read = () => existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : {};
  const write = patch => writeFileSync(stateFile, JSON.stringify({ ...read(), ...patch }));
  write({ enabled: false, trusted: { dashboard: publicKey.export({ type: 'spki', format: 'pem' }) }, tokenDir: join(f.root, 'tokens'), ...state });
  return { ...f, project, keyPath, read, write, options: { cliPath: fakeCli, resolveKey: controller => controller === 'dashboard' ? keyPath : null } };
}
const approve = preview => ({ actor: 'human:test', shownHash: preview.shownHash });
const events = (f, type) => f.store.db.prepare('SELECT body FROM events WHERE type=?').all(type);

test('connection state names the cause and next action without pairing', () => {
  const probe = patch => ({ enabled: false, owner: null, generation: null, handover: false, pairing: { supported: true, version: 1, trustedControllers: ['dashboard'] }, managedHost: null, ...patch });
  const state = args => connectionState({ projectId: 'p', keyAvailable: true, ...args });
  assert.equal(state({ probe: probe() }).state, 'pairing-available');
  assert.equal(state({ probe: probe() }).canPair, true);
  assert.equal(state({ probe: probe(), keyAvailable: false }).state, 'trust-missing');
  assert.match(state({ probe: probe(), keyAvailable: false }).command, /master trust --controller dashboard/);
  assert.equal(state({ probe: probe({ pairing: { supported: true, version: 1, trustedControllers: [] } }) }).state, 'trust-missing');
  const legacy = state({ probe: probe({ pairing: { supported: false } }) });
  assert.equal(legacy.state, 'legacy'); assert.equal(legacy.code, 'control-not-bound'); assert.match(legacy.guidance, /project control p/);
  assert.equal(state({ probe: probe({ enabled: true, owner: 'other', generation: 3 }) }).state, 'owned-by-other');
  assert.equal(state({ probe: probe({ enabled: true, owner: 'other', generation: 3 }) }).canPair, false);
  assert.equal(state({ probe: probe({ enabled: true, owner: 'dashboard', generation: 3 }) }).state, 'enabled-unbound');
  assert.equal(state({ probe: null }).state, 'unknown');
  assert.equal(state({ probe: probe(), installed: false }).state, 'not-installed');
  const binding = { controller: 'dashboard', owner: true, generation: 3, pairing: { humanChannel: { expiresAt: new Date(Date.now() + 3 * 86400000).toISOString() } } };
  const current = probe({ enabled: true, owner: 'dashboard', generation: 3 });
  const renewal = state({ probe: current, binding });
  assert.deepEqual([renewal.state, renewal.renewal, renewal.canPair, renewal.outcome], ['connected', true, true, 'rotated']);
  assert.equal(state({ probe: current, binding: { ...binding, pairing: { humanChannel: { expiresAt: new Date(Date.now() + 20 * 86400000).toISOString() } } } }).canPair, false);
  assert.equal(state({ probe: probe({ enabled: true, owner: 'dashboard', generation: 4 }), binding }).state, 'stale');
  assert.equal(state({ probe: probe({ enabled: true, owner: 'other', generation: 4 }), binding }).canPair, false);
  assert.equal(state({ probe: current, binding: { ...binding, owner: false } }).state, 'observer');
  const probed = controlProbe({ project: { enabled: true }, ownership: { controller: '../x', generation: 1 }, pairing: { supported: true, version: 2 }, token: 'SECRET' });
  assert.equal(probed.owner, null); assert.equal(probed.pairing.supported, false); assert.equal(JSON.stringify(probed).includes('SECRET'), false);
});

test('the trust key is a regular file in the code-agent store named by a valid controller', t => {
  const root = temporary(t), dir = join(root, 'master-trust'); mkdirSync(dir);
  writeFileSync(join(dir, 'dashboard.pem'), 'key');
  writeFileSync(join(dir, 'big.pem'), 'x'.repeat(20000));
  assert.equal(findTrustKey('dashboard', dir), join(dir, 'dashboard.pem'));
  for (const name of ['../dashboard', 'other', 'big', '']) assert.equal(findTrustKey(name, dir), null);
  assert.equal(findTrustKey('dashboard', 'relative'), null);
  assert.equal(trustStoreDir({ env: { CODE_AGENT_HOME: join(root, 'home') }, home: 'unused' }), join(root, 'home'));
  assert.equal(trustStoreDir({ env: {}, home: root }), join(root, '.code-agent'));
});

test('an explicit confirmation pairs once and stores only the token path with the human channel expiry', async t => {
  const f = pairingSetup(t);
  const preview = await pairingPreview(f.store, f.project.id, f.options);
  assert.deepEqual([preview.state, preview.canPair, preview.outcome], ['pairing-available', true, 'enabled']);
  assert.ok(preview.lines.some(line => line.includes('승인 권한이 아닙니다')));
  assert.ok(preview.lines.some(line => line.includes('claude') && line.includes('준비됨')));
  const record = await pairControl(f.store, f.project.id, { ...f.options, commandId: 'pair-1', projectRevision: preview.projectRevision, approval: approve(preview) });
  assert.equal(record.state, 'paired');
  const binding = f.store.need('control-binding', f.project.id), fake = f.read();
  assert.deepEqual([binding.controller, binding.owner, binding.generation], ['dashboard', true, 1]);
  assert.equal(binding.tokenFile, join(f.root, 'tokens', 'dashboard.token'));
  assert.ok(Date.parse(binding.pairing.humanChannel.expiresAt) > Date.now());
  assert.equal(fake.applied, 1); assert.equal(events(f, 'control-paired').length, 1);
  const stored = JSON.stringify([f.store.db.prepare('SELECT body FROM records').all(), f.store.db.prepare('SELECT body FROM events').all()]);
  assert.equal(stored.includes(fake.token), false); assert.equal(stored.includes('PRIVATE KEY'), false);
  assert.equal((await pairControl(f.store, f.project.id, { ...f.options, commandId: 'pair-1', approval: approve(preview) })).state, 'paired');
  assert.equal(f.read().applied, 1);
  await assert.rejects(pairControl(f.store, f.project.id, { ...f.options, commandId: 'pair-1', approval: { ...approve(preview), shownHash: 'other' } }), { code: 'request-conflict' });
  const snapshot = dashboardSnapshot(f.store, { trustKey: f.options.resolveKey }), card = snapshot.projects.find(p => p.id === f.project.id);
  assert.deepEqual([card.connection.state, card.pairing.state, card.connection.canPair], ['connected', 'paired', false]);
  assert.equal(JSON.stringify(snapshot).includes(binding.tokenFile), false);
});

test('renewal near expiry rotates the token on the same connection', async t => {
  const f = pairingSetup(t);
  let preview = await pairingPreview(f.store, f.project.id, f.options);
  await pairControl(f.store, f.project.id, { ...f.options, commandId: 'pair-1', approval: approve(preview) });
  assert.equal((await pairingPreview(f.store, f.project.id, f.options)).canPair, false);
  const binding = f.store.need('control-binding', f.project.id);
  f.store.put('control-binding', { ...binding, pairing: { ...binding.pairing, humanChannel: { ...binding.pairing.humanChannel, expiresAt: new Date(Date.now() + 86400000).toISOString() } } }, binding.revision);
  preview = await pairingPreview(f.store, f.project.id, f.options);
  assert.deepEqual([preview.state, preview.canPair, preview.outcome], ['connected', true, 'rotated']);
  const record = await pairControl(f.store, f.project.id, { ...f.options, commandId: 'pair-2', approval: approve(preview) });
  assert.deepEqual([record.state, record.result.outcome, f.store.need('control-binding', f.project.id).generation], ['paired', 'rotated', 2]);
});

test('changed content, other owners and busy projects are rejected before anything is signed', async t => {
  const f = pairingSetup(t);
  const preview = await pairingPreview(f.store, f.project.id, f.options);
  await assert.rejects(pairControl(f.store, f.project.id, { ...f.options, commandId: 'stale', approval: { ...approve(preview), shownHash: 'different' } }), { code: 'stale-state' });
  await assert.rejects(pairControl(f.store, f.project.id, { ...f.options, commandId: 'revision', projectRevision: preview.projectRevision + 1, approval: approve(preview) }), { code: 'stale-state' });
  await assert.rejects(pairControl(f.store, f.project.id, { ...f.options, commandId: 'no-key', approval: approve(preview), resolveKey: () => null }), { code: 'control-trust-missing' });
  const maintenance = f.store.put('project-maintenance', { id: f.project.id, active: true });
  await assert.rejects(pairControl(f.store, f.project.id, { ...f.options, commandId: 'busy', approval: approve(preview) }), { code: 'project-busy' });
  f.store.put('project-maintenance', { ...maintenance, active: false }, maintenance.revision);
  f.write({ enabled: true, owner: 'other', generation: 5 });
  const owned = await pairingPreview(f.store, f.project.id, f.options);
  assert.deepEqual([owned.state, owned.canPair], ['owned-by-other', false]);
  await assert.rejects(pairControl(f.store, f.project.id, { ...f.options, commandId: 'owned', approval: approve(owned) }), { code: 'control-owned-by-other' });
  assert.equal(f.read().calls.includes('pair.challenge'), false);
  assert.equal(f.store.list('control-pairing').length, 0); assert.equal(f.store.list('control-binding').length, 0);
});

test('a lost pair response stays unknown, blocks a second pairing and settles with the same commandId', async t => {
  const f = pairingSetup(t, { drop: 3 });
  const preview = await pairingPreview(f.store, f.project.id, f.options);
  const lost = await pairControl(f.store, f.project.id, { ...f.options, commandId: 'pair-lost', approval: approve(preview) });
  assert.equal(lost.state, 'unknown'); assert.equal(f.store.get('control-binding', f.project.id), undefined);
  await assert.rejects(pairControl(f.store, f.project.id, { ...f.options, commandId: 'pair-other', approval: approve(preview) }), { code: 'request-busy' });
  const settled = await retryPairing(f.store, 'pair-lost', f.options);
  assert.equal(settled.state, 'paired'); assert.equal(f.read().applied, 1);
  assert.equal(f.store.need('control-binding', f.project.id).generation, 1);
  await assert.rejects(retryPairing(f.store, 'pair-lost', f.options), { code: 'invalid-input' });
});

test('a token file inside the repository is refused and nothing is bound', async t => {
  const f = pairingSetup(t);
  f.write({ tokenFileOverride: join(f.project.path, 'token.txt') });
  const preview = await pairingPreview(f.store, f.project.id, f.options);
  const record = await pairControl(f.store, f.project.id, { ...f.options, commandId: 'inside', approval: approve(preview) });
  assert.equal(record.state, 'failed'); assert.equal(record.error.code, 'control-pairing-invalid');
  assert.equal(f.store.get('control-binding', f.project.id), undefined);
});

test('dashboard pairing routes need the page token, the confirmation checkbox and the shown content hash', async t => {
  const f = pairingSetup(t); f.close();
  const dashboard = await startDashboard({ dbPath: f.db, port: 0, observe: false, pairingOptions: f.options });
  try {
    const overview = await (await fetch(`${dashboard.url}/api/overview`)).json();
    assert.equal(overview.projects.find(p => p.id === f.project.id).connection.state, 'unknown');
    const post = (path, body, headers = {}) => fetch(dashboard.url + path, { method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: dashboard.url, 'X-Master-Token': overview.token, ...headers }, body: JSON.stringify(body) });
    assert.equal((await post('/api/projects/pair/preview', { projectId: f.project.id }, { 'X-Master-Token': 'wrong' })).status, 403);
    const preview = await (await post('/api/projects/pair/preview', { projectId: f.project.id })).json();
    assert.equal(preview.canPair, true);
    const body = { projectId: f.project.id, projectRevision: preview.projectRevision, commandId: 'web-1', shownHash: preview.shownHash };
    assert.equal((await post('/api/projects/pair', body)).status, 400);
    assert.equal((await post('/api/projects/pair', { ...body, confirmed: true, shownHash: 'other' })).status, 409);
    const receipt = await (await post('/api/projects/pair', { ...body, confirmed: true })).json();
    assert.deepEqual([receipt.state, receipt.outcome, 'tokenFile' in receipt], ['paired', 'enabled', false]);
    const after = await (await fetch(`${dashboard.url}/api/overview`)).json(), card = after.projects.find(p => p.id === f.project.id);
    assert.equal(card.connection.state, 'connected'); assert.ok(card.control.expiresAt);
    assert.equal(JSON.stringify(after).includes('dashboard.token'), false);
  } finally { await dashboard.close(); }
});
