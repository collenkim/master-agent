// Real code-agent CLI transport against synthetic, isolated producers and test-only credentials.
// Does not represent a real person's approval or a model completing a development lifecycle.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../packages/storage/store.mjs';
import { Catalog } from '../packages/catalog/catalog.mjs';
import { bindControl } from '../packages/runner/control-host.mjs';
import { createInteractions } from '../packages/dashboard/interactions.mjs';
import { findCodeAgent } from '../packages/code-agent-adapter/discovery.mjs';
import { startDashboard } from '../packages/dashboard/server.mjs';
import { interactionBrowserCheck } from './interaction-browser-check.mjs';

const cliPath = findCodeAgent(process.argv[2]), ca = createRequire(cliPath);
const { setupConsentProject, gitFixture } = ca('../test/consentFixture.js');
const { masterEnable } = ca('./master/admin.js');
const { withInteraction } = ca('./tty.js');
const { readBinding, writeBinding } = ca('./master/store.js');
const { PublishInteraction, INTERACTION_STAGES } = ca('./interactionSchema.js');
const { publishInteraction, interactionContext } = ca('./interactions.js');
const { consumeInteraction, drainInteraction } = ca('./interactionService.js');
const { prepareConsent, loadConsent } = ca('./consent.js');
const root = realpathSync(mkdtempSync(join(tmpdir(), 'master-interactions-live-'))), dbPath = join(root, 'master.db');
const store = new Store(dbPath), catalog = new Catalog(store), keys = new Map(), results = [];
const inbox = createInteractions(store, { cliPath, resolveHumanKey: id => keys.get(id) });
const payload = (item, extra = {}) => ({ id: item.id, revision: item.revision, contentHash: item.contentHash, context: item.context,
  commandId: randomUUID(), action: 'answer', answers: [{ questionId: 'method', optionIds: ['source'], optionInputs: {} }], ...extra });
const question = { questionId: 'method', title: '문서 작성 방식', mode: 'single', minSelections: 1,
  options: [{ optionId: 'source', label: '소스 기준', description: '현재 코드 확인', consequence: '초안 작성' },
    { optionId: 'link', label: '기존 문서', description: '경로 확인', consequence: '문서 연결', input: { required: true, minLength: 1, maxLength: 200, description: '경로' } }],
  recommendedOptionIds: ['source'], recommendationReason: '현재 소스를 확인한 시험 발행자', evidence: [{ path: 'package.json', summary: '합성 발행 근거' }] };
try {
  for (const kind of ['empty', 'existing']) {
    const path = join(root, kind); mkdirSync(path);
    if (kind === 'empty') gitFixture(path, 'init', '-q', '-b', 'master'); else setupConsentProject(path);
    const tokenFile = join(root, `${kind}.token`);
    // The same explicit test fixture boundary as code-agent's own protocol tests; never real enrollment.
    withInteraction({ confirm: () => ({ channel: 'tty', verified: true, detail: 'synthetic test fixture' }), ask: () => 'n' },
      () => masterEnable(path, { controller: 'dashboard', tokenOut: tokenFile }));
    const { publicKey, privateKey } = generateKeyPairSync('ed25519'), channelId = randomUUID(), keyPath = join(root, `${kind}.pem`);
    writeFileSync(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 }); keys.set(channelId, keyPath);
    const binding = readBinding(path);
    binding.humanChannel = { id: channelId, controller: 'dashboard', generation: 1, publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(), createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString() };
    writeBinding(path, binding);
    const project = catalog.register({ id: kind, name: kind, path, domains: ['fixture'], capabilities: ['code-agent:claude'], constraints: [], currentPlans: [], references: ['synthetic fixture'] });
    await bindControl(store, kind, { cliPath, controller: 'dashboard', tokenFile });
    for (const stage of process.argv.includes('--browser-only') ? ['setup'] : INTERACTION_STAGES) {
      const published = publishInteraction(path, PublishInteraction.parse({ key: `${kind}-${stage}`, stage, title: `${stage} 시험 질문`, questions: [question] }), interactionContext(path, 'fixture-session', 'claude'));
      await inbox.refreshProject(project);
      const item = inbox.snapshot().items.find(i => i.requestId === published.requestId);
      assert.ok(item?.respondSupported, JSON.stringify(inbox.snapshot().sources));
      assert.equal(item.workId, null); assert.equal(item.remote.response, undefined);
      const request = payload(item), receipt = await inbox.respond(request);
      assert.equal(receipt.state, 'received', JSON.stringify(receipt.error));
      assert.equal((await inbox.respond(request)).receiptId, receipt.receiptId);
      const consumed = consumeInteraction(path, published.requestId, 'fixture-session');
      assert.equal(consumed.answers[0].optionIds[0], 'source');
      consumeInteraction(path, published.requestId, 'fixture-session', { summary: '합성 호스트의 답 소비·반영 확인' });
      await inbox.refreshProject(project);
      assert.equal(store.need('interaction-command', request.commandId).state, 'applied');
      results.push({ kind, stage, requestId: published.requestId, received: true, consumed: true, applied: true, modelExecuted: false });
    }
    const multiple = publishInteraction(path, PublishInteraction.parse({ key: `${kind}-multiple`, stage: 'planning', title: '다중 선택과 직접 입력',
      questions: [{ ...question, mode: 'multiple', minSelections: 2, maxSelections: 2, defaultOptionIds: ['source', 'link'] },
        { questionId: 'note', title: '설명', mode: 'text', input: { required: true, minLength: 3, maxLength: 100, description: '설명' }, recommendationReason: '사용자 입력 필요' }] }), interactionContext(path, 'fixture-session', 'claude'));
    await inbox.refreshProject(project);
    let item = inbox.snapshot().items.find(i => i.requestId === multiple.requestId);
    const deferred = await inbox.respond(payload(item, { action: 'defer', answers: undefined })); assert.equal(deferred.state, 'deferred');
    item = inbox.snapshot().items.find(i => i.requestId === multiple.requestId);
    assert.equal((await inbox.respond(payload(item, { action: 'reopen', answers: undefined }))).state, 'reopened');
    item = inbox.snapshot().items.find(i => i.requestId === multiple.requestId);
    const submission = payload(item, { answers: [{ questionId: 'method', optionIds: ['source', 'link'], optionInputs: { link: 'doc/architecture.md' } }, { questionId: 'note', optionIds: [], text: '추가 업무 설명', optionInputs: {} }] });
    assert.equal((await inbox.respond(submission)).state, 'received');
    consumeInteraction(path, multiple.requestId, 'fixture-session', { summary: '다중 답 소비' });
    await inbox.refreshProject(project);
    const stale = publishInteraction(path, PublishInteraction.parse({ key: `${kind}-stale`, stage: 'maintenance', title: '오래된 요청', questions: [question] }), interactionContext(path, 'fixture-session', 'claude'));
    await inbox.refreshProject(project); item = inbox.snapshot().items.find(i => i.requestId === stale.requestId);
    gitFixture(path, 'switch', '-q', '--orphan', 'other');
    await assert.rejects(inbox.respond(payload(item)), { code: 'interaction-unavailable' });
    gitFixture(path, 'symbolic-ref', 'HEAD', 'refs/heads/master');
    keys.delete(channelId);
    await assert.rejects(inbox.respond(payload(item)), { code: 'interaction-human-channel' });
    keys.set(channelId, keyPath);
    if (kind === 'existing') {
      const consent = JSON.parse(prepareConsent(path, { action: 'docs' }, { binding: { id: 'fixture-session', host: 'claude' } }));
      await inbox.refreshProject(project);
      item = inbox.snapshot().items.find(i => i.remote?.origin.id === consent.id);
      assert.equal(item.kind, 'approval'); assert.ok(item.body.length > 0);
      await assert.rejects(inbox.respond(payload(item, { action: 'approve', reviewed: false, choices: {} })), { code: 'invalid-input' });
      if (process.argv.includes('--browser')) {
        const browserQuestion = publishInteraction(path, PublishInteraction.parse({ key: 'browser-question', stage: 'review', title: '브라우저 다중 질문',
          questions: [{ ...question, mode: 'multiple', minSelections: 2, maxSelections: 2, defaultOptionIds: ['source', 'link'] },
            { questionId: 'note', title: '설명', mode: 'text', input: { required: true, minLength: 3, maxLength: 100, description: '설명' }, recommendationReason: '사용자 입력 필요' }] }), interactionContext(path, 'fixture-session', 'claude'));
        await inbox.refreshProject(project);
        const questionId = inbox.snapshot().items.find(i => i.requestId === browserQuestion.requestId).id;
        const artifacts = mkdtempSync(resolve('.master-agent/interactions-live-browser-'));
        const dashboard = await startDashboard({ dbPath, port: 0, cliPath, interactionOptions: { resolveHumanKey: id => keys.get(id) } });
        try { await interactionBrowserCheck({ url: dashboard.url, artifacts, questionId, approvalId: item.id }); }
        finally { await dashboard.close(); }
        assert.equal(consumeInteraction(path, browserQuestion.requestId, 'fixture-session').answers[1].text, '브라우저에서 명시적으로 입력');
        consumeInteraction(path, browserQuestion.requestId, 'fixture-session', { summary: '브라우저 답 소비' });
        results.push({ actualBrowserTransport: true, artifacts });
      } else {
        const response = await inbox.respond(payload(item, { action: 'approve', reviewed: true, choices: Object.fromEntries(item.consent.choices.map(c => [String(c.index), '유지'])) }));
        assert.ok(['received', 'applied'].includes(response.state), response.error);
      }
      for (let n = 0; n < 30 && loadConsent(path, consent.id).status !== 'applied'; n++) { drainInteraction(path, item.requestId); await delay(100); }
      assert.equal(loadConsent(path, consent.id).status, 'applied');
      await inbox.refreshProject(project);
      assert.equal(inbox.snapshot().items.find(i => i.id === item.id).state, 'answered');
      results.push({ kind, consent: 'docs', actualApplyHandler: true, syntheticHumanFixture: true });
    }
  }
  // Lose a request before delivery, restart the master service, then retry the exact durable envelope.
  const project = catalog.active('existing');
  const producerRoot = join(root, 'existing');
  const transportMarker = join(root, 'transport-failed-once'), transport = join(root, 'transport.mjs');
  writeFileSync(transport, `import { readFileSync, existsSync, writeFileSync } from 'node:fs'; import { spawnSync } from 'node:child_process';
    const input = readFileSync(0, 'utf8'), request = JSON.parse(input);
    if (request.type === 'interaction.respond' && !existsSync(${JSON.stringify(transportMarker)})) { writeFileSync(${JSON.stringify(transportMarker)}, request.commandId); process.exit(1); }
    const result = spawnSync(process.execPath, [${JSON.stringify(cliPath)}, ...process.argv.slice(2)], { cwd: process.cwd(), input, encoding: 'utf8', windowsHide: true });
    process.stdout.write(result.stdout ?? ''); process.exit(result.status ?? 1);`);
  const outageQuestion = publishInteraction(producerRoot, PublishInteraction.parse({ key: 'outage-restart', stage: 'maintenance', title: '재시작 전송 시험', questions: [question] }), interactionContext(producerRoot, 'fixture-session', 'claude'));
  const outage = createInteractions(store, { cliPath: transport, resolveHumanKey: id => keys.get(id) });
  await outage.refreshProject(project);
  const outageItem = outage.snapshot().items.find(i => i.requestId === outageQuestion.requestId), outgoing = payload(outageItem);
  assert.equal((await outage.respond(outgoing)).state, 'unknown');
  await assert.rejects(outage.respond(payload(outageItem)), { code: 'request-busy' });
  assert.throws(() => catalog.remove(project.id, store.need('project', project.id).revision), { code: 'project-busy' });
  const restartedStore = new Store(dbPath);
  try {
    const restarted = createInteractions(restartedStore, { cliPath: transport, resolveHumanKey: id => keys.get(id) });
    const resumed = await restarted.retry(outgoing.commandId);
    assert.equal(resumed.state, 'received'); assert.equal(resumed.id, outgoing.commandId);
    assert.equal((await restarted.respond(outgoing)).receiptId, resumed.receiptId);
    consumeInteraction(producerRoot, outageQuestion.requestId, 'fixture-session', { summary: '재시작 후 같은 명령 소비' });
    await restarted.refreshProject(project); await restarted.stop();
    assert.equal(restartedStore.need('interaction-command', outgoing.commandId).state, 'applied');
  } finally { restartedStore.close(); }
  results.push({ lostDelivery: true, durableRestartRetry: true, singleCommand: true, deletionBlockedUntilApplied: true });
  const serialized = JSON.stringify(inbox.snapshot());
  assert.equal(serialized.includes('PRIVATE KEY'), false);
  for (const name of ['empty', 'existing']) assert.equal(serialized.includes(readFileSync(join(root, `${name}.token`), 'utf8').trim()), false);
  mkdirSync(resolve('.master-agent'), { recursive: true });
  const evidence = { passed: true, cliPath, isolatedRoot: root, syntheticCredentialsAndProducers: true, realModelLifecycle: false,
    results, checks: ['actual-cli', process.argv.includes('--browser-only') ? 'browser-focused' : 'all-stage-question-contracts', 'same-command-replay', 'multi-input', 'defer-reopen', 'branch-stale', 'missing-key', 'separate-consent', 'actual-docs-apply', 'no-secret-projection'] };
  const evidencePath = resolve(process.argv.includes('--browser') ? '.master-agent/interactions-live-browser.json' : '.master-agent/interactions-live.json');
  writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ ...evidence, results: `${results.length} scenarios`, evidence: evidencePath }));
} finally { await inbox.stop(); store.close(); }
