import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { Store } from '../storage/store.mjs';
import { DomainError, requireThat } from '../domain/contracts.mjs';
import { findCodeAgent } from '../code-agent-adapter/discovery.mjs';
import { Catalog } from '../catalog/catalog.mjs';
import { acceptRequest, launchRequest, continueRequest } from '../orchestrator/requests.mjs';
import { createMonitor } from './monitor.mjs';
import { projectCandidates } from './project-candidates.mjs';
import { createUpdates } from './updates.mjs';
import { createInteractions } from './interactions.mjs';
import { createHistory, historyPage } from './history.mjs';
import { pairControl, pairingPreview, pairingReceipt, retryPairing } from '../runner/control-pairing.mjs';
import { trustDashboard, trustPreview } from '../runner/control-trust.mjs';

export function validateDashboardOptions({ port = 4310, cliPath, intervalMs = 5000, observe = true } = {}) {
  requireThat(Number.isInteger(port) && port >= 0 && port <= 65535, 'usage', '--port는 0~65535 정수입니다.');
  requireThat(Number.isInteger(intervalMs) && intervalMs >= 1000 && intervalMs <= 3600000, 'usage', '--refresh-ms는 1000~3600000 정수입니다.');
  return observe ? findCodeAgent(cliPath, { required: false }) : null;
}

export async function startDashboard({ dbPath, port = 4310, cliPath, intervalMs = 5000, observe = true, launch = launchRequest, candidateOptions = {}, updateOptions = {}, interactionOptions = {}, pairingOptions = {}, management } = {}) {
  const updateCliPath = cliPath;
  cliPath = validateDashboardOptions({ port, cliPath, intervalMs, observe });
  const assets = new Map([
    ['/', ['text/html; charset=utf-8', 'index.html']],
    ['/app.mjs', ['text/javascript; charset=utf-8', 'app.mjs']],
    ['/common.mjs', ['text/javascript; charset=utf-8', 'common.mjs']],
    ['/interactions.mjs', ['text/javascript; charset=utf-8', 'interactions.mjs']],
    ['/verification.mjs', ['text/javascript; charset=utf-8', 'verification.mjs']],
    ['/history.mjs', ['text/javascript; charset=utf-8', 'history.mjs']],
    ['/style.css', ['text/css; charset=utf-8', 'style.css']],
  ].map(([path, [type, file]]) => [path, { type, body: readFileSync(new URL(`../../apps/dashboard/${file}`, import.meta.url)) }]));
  const store = new Store(dbPath);
  const interactions = createInteractions(store, { ...interactionOptions, cliPath, launch, launchOptions: { dbPath, cliPath } });
  const history = createHistory(store, { cliPath });
  // Pairing runs only from the explicit confirmation routes below; the sweep only reads hello.
  const pairing = { cliPath: pairingOptions.cliPath ?? cliPath, ...(pairingOptions.resolveKey ? { resolveKey: pairingOptions.resolveKey } : {}) };
  const pairingCli = () => { requireThat(pairing.cliPath, 'code-agent-unavailable', '설치된 code-agent를 찾아야 제어 연결을 할 수 있습니다.'); return pairing; };
  const monitor = createMonitor(store, { cliPath, intervalMs, trustKey: pairingOptions.resolveKey, onObserved: async project => {
    if (cliPath) {
      await history.refreshProject(project);
      await interactions.refreshProject(project);
    } else interactions.observeMaster();
  } });
  const updates = createUpdates(store, { cliPath: updateCliPath ?? cliPath,
    ...updateOptions });
  const token = randomUUID(), catalog = new Catalog(store);
  let candidateScan;
  let origin;
  const receipt = ({ id, state, receiptId, resume, error, errorMessage }) => ({ id, state, receiptId, resume, error, errorMessage });
  const server = createServer(async (request, response) => {
    const send = (status, body, type = 'application/json; charset=utf-8') => {
      response.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
        'Referrer-Policy': 'no-referrer' });
      response.end(body);
    };
    // Loopback binding plus exact Host/Origin checks keep other sites from reading local records.
    if (request.headers.host !== new URL(origin).host || request.headers.origin && request.headers.origin !== origin ||
        request.headers['sec-fetch-site'] === 'cross-site') return send(403, JSON.stringify({ error: 'forbidden',
      ...(/^localhost(?::\d+)?$/i.test(request.headers.host ?? '') ? { message: `${origin}로 접속하세요.` } : {}) }));
    try {
      const path = new URL(request.url, origin).pathname;
      if (request.method === 'POST') {
        const control = path === '/api/dashboard-control';
        requireThat(request.headers.origin === origin && (control
          ? management && request.headers['x-master-control'] === management.token
          : request.headers['x-master-token'] === token), 'forbidden', '이 대시보드에서 보낸 요청만 처리합니다.');
        requireThat(request.headers['content-type']?.split(';')[0] === 'application/json', 'invalid-input', 'JSON 요청이 필요합니다.');
        let body = '';
        request.setEncoding('utf8');
        for await (const chunk of request) { body += chunk; requireThat(Buffer.byteLength(body) <= 256 * 1024, 'invalid-input', '요청은 256KiB 이하로 보내세요.'); }
        let input;
        try { input = JSON.parse(body); } catch { requireThat(false, 'invalid-input', 'JSON을 읽을 수 없습니다.'); }
        requireThat(input && typeof input === 'object' && !Array.isArray(input), 'invalid-input', '객체가 필요합니다.');
        if (control) {
          requireThat(input.id === management.id && ['status', 'stop'].includes(input.action), 'invalid-input', '서버 식별자와 제어 동작을 확인하세요.');
          send(input.action === 'stop' ? 202 : 200, JSON.stringify({ id: management.id, state: input.action === 'stop' ? 'stopping' : 'running' }));
          if (input.action === 'stop') setImmediate(management.stop);
          return;
        }
        if (path === '/api/project-candidates') {
          candidateScan ??= projectCandidates(catalog.projects(), { ...candidateOptions, cliPath }).finally(() => { candidateScan = null; });
          return send(200, JSON.stringify(await candidateScan));
        }
        if (path === '/api/projects') return send(201, JSON.stringify(catalog.registerManual(input.project)));
        if (path === '/api/interactions/respond') return send(200, JSON.stringify(receipt(await interactions.respond(input))));
        if (path === '/api/interactions/retry') return send(200, JSON.stringify(receipt(await interactions.retry(input.commandId))));
        if (path === '/api/trust/preview') return send(200, JSON.stringify(await trustPreview(pairingCli())));
        if (path === '/api/trust') {
          const result = await trustDashboard({ ...pairingCli(), shownHash: input.shownHash, word: input.word });
          // 카드의 연결 상태는 hello 의 신뢰 목록을 다시 읽어야 바뀐다 — 다음 순회를 기다리지 않는다
          void monitor.refresh();
          return send(200, JSON.stringify(result));
        }
        if (path === '/api/projects/pair/preview') return send(200, JSON.stringify(await pairingPreview(store, input.projectId, pairingCli())));
        if (path === '/api/projects/pair' || path === '/api/projects/pair/retry') {
          let record;
          if (path === '/api/projects/pair') {
            requireThat(input.confirmed === true, 'invalid-input', '확인 내용을 읽고 확인 체크를 해야 연결합니다.');
            requireThat(Number.isInteger(input.projectRevision) && typeof input.shownHash === 'string', 'invalid-input', '확인한 프로젝트 버전과 내용 해시가 필요합니다.');
            record = await pairControl(store, input.projectId, { ...pairingCli(), commandId: input.commandId, projectRevision: input.projectRevision,
              approval: { actor: 'human:dashboard', approvedAt: new Date().toISOString(), shownHash: input.shownHash } });
          } else record = await retryPairing(store, input.commandId, pairingCli());
          if (record.state === 'paired') await interactions.refreshProject(store.need('project', record.projectId));
          return send(200, JSON.stringify(pairingReceipt(record)));
        }
        if (path === '/api/projects/delete') return send(200, JSON.stringify(catalog.remove(input.id, input.revision)));
        if (path === '/api/groups/delete') return send(200, JSON.stringify(catalog.removeGroup(input.id, input.revision)));
        if (path === '/api/updates/preview') return send(200, JSON.stringify(await updates.preview(input)));
        if (path === '/api/updates/install') return send(202, JSON.stringify(await updates.install(input.id)));
        if (path === '/api/updates/apply-preview') return send(200, JSON.stringify(await updates.previewApply(input.id)));
        if (path === '/api/updates/apply') return send(202, JSON.stringify(await updates.apply(input.id, input.previewId)));
        if (path === '/api/updates/recover') return send(200, JSON.stringify(await updates.recover(input.id)));
        if (path === '/api/groups') return send(200, JSON.stringify(catalog.group(input.group, input.revision ?? 0, { newProjects: input.newProjects })));
        if (path === '/api/requests') {
          const accepted = acceptRequest(store, input);
          const result = accepted.created ? await launch(store, accepted.request.id, { dbPath, cliPath }) : accepted.request;
          return send(202, JSON.stringify(result));
        }
        if (path === '/api/requests/continue') {
          continueRequest(store, input.id, input.revision);
          return send(202, JSON.stringify(await launch(store, input.id, { dbPath, cliPath })));
        }
        return send(404, '{"error":"not-found"}');
      }
      if (request.method !== 'GET') return send(405, '{"error":"method-not-allowed"}');
      if (path === '/api/history') {
        const query = new URL(request.url, origin).searchParams;
        return send(200, JSON.stringify(historyPage(store, { projectId: query.get('projectId') ?? '', groupId: query.get('groupId') ?? '',
          task: query.get('task') ?? '', before: query.get('before') ?? '', limit: Number(query.get('limit') ?? 50) })));
      }
      if (path === '/api/interactions') {
        const query = new URL(request.url, origin).searchParams;
        return send(200, JSON.stringify(interactions.snapshot({ box: query.get('box') ?? 'waiting', page: Number(query.get('page') ?? 1),
          pageSize: Number(query.get('pageSize') ?? 25), source: query.get('source') ?? '', state: query.get('state') ?? '',
          groupId: query.get('groupId') ?? '', projectId: query.get('projectId') ?? '', stage: query.get('stage') ?? '', search: query.get('search') ?? '', itemId: query.get('itemId') ?? '' })));
      }
      if (path === '/api/overview') return send(200, JSON.stringify({ ...monitor.snapshot(), updates: updates.snapshot(), token, codeAgent: cliPath,
        discovery: cliPath ? 'installed' : observe ? 'not-found' : 'saved' }));
      const asset = assets.get(path);
      if (asset) return send(200, asset.body, asset.type);
      send(404, '{"error":"not-found"}');
    } catch (error) {
      if (!(error instanceof DomainError)) {
        console.error(error?.code ?? 'internal-error', String(error?.stack ?? error?.name ?? 'Error').split('\n')[0]);
        return send(500, JSON.stringify({ error: 'internal-error', message: '요청 처리 중 오류가 발생했습니다.' }));
      }
      const status = error.code === 'forbidden' ? 403 : ['stale-state', 'stale-question', 'request-busy', 'request-conflict', 'project-busy', 'project-in-use', 'already-exists', 'duplicate-path'].includes(error.code) ? 409 : error.code === 'not-found' ? 404 : 400;
      send(status, JSON.stringify({ error: error.code, message: error.message }));
    }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  try {
    server.listen(port, '127.0.0.1');
    await once(server, 'listening');
    origin = `http://127.0.0.1:${server.address().port}`;
    monitor.start();
  } catch (error) { await monitor.stop(); store.close(); throw error; }
  let closing;
  return { url: origin, cliPath, monitor,
    close() {
      closing ??= (async () => {
        const closed = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        server.closeIdleConnections();
        const updating = updates.stop();
        await monitor.stop();
        await interactions.stop();
        await closed;
        await updating;
        store.close();
      })();
      return closing;
    },
  };
}
