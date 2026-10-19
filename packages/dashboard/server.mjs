import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { Store } from '../storage/store.mjs';
import { requireThat } from '../domain/contracts.mjs';
import { findCodeAgent } from '../code-agent-adapter/discovery.mjs';
import { Catalog } from '../catalog/catalog.mjs';
import { acceptRequest, launchRequest, continueRequest } from '../orchestrator/requests.mjs';
import { createMonitor } from './monitor.mjs';
import { projectCandidates } from './project-candidates.mjs';
import { createUpdates } from './updates.mjs';

export function validateDashboardOptions({ port = 4310, cliPath, intervalMs = 5000, observe = true } = {}) {
  requireThat(Number.isInteger(port) && port >= 0 && port <= 65535, 'usage', '--port는 0~65535 정수입니다.');
  requireThat(Number.isInteger(intervalMs) && intervalMs >= 1000 && intervalMs <= 3600000, 'usage', '--refresh-ms는 1000~3600000 정수입니다.');
  return observe ? findCodeAgent(cliPath, { required: false }) : null;
}

export async function startDashboard({ dbPath, port = 4310, cliPath, intervalMs = 5000, observe = true, launch = launchRequest, candidateOptions = {}, updateOptions = {}, management } = {}) {
  const updateCliPath = cliPath;
  cliPath = validateDashboardOptions({ port, cliPath, intervalMs, observe });
  const assets = new Map([
    ['/', ['text/html; charset=utf-8', 'index.html']],
    ['/app.mjs', ['text/javascript; charset=utf-8', 'app.mjs']],
    ['/style.css', ['text/css; charset=utf-8', 'style.css']],
  ].map(([path, [type, file]]) => [path, { type, body: readFileSync(new URL(`../../apps/dashboard/${file}`, import.meta.url)) }]));
  const store = new Store(dbPath), monitor = createMonitor(store, { cliPath, intervalMs });
  const updates = createUpdates(store, { cliPath: updateCliPath ?? cliPath, ...updateOptions });
  const token = randomUUID(), catalog = new Catalog(store);
  let candidateScan;
  let origin;
  const server = createServer(async (request, response) => {
    const send = (status, body, type = 'application/json; charset=utf-8') => {
      response.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
        'Referrer-Policy': 'no-referrer' });
      response.end(body);
    };
    // Loopback binding plus exact Host/Origin checks keep other sites from reading local records.
    if (request.headers.host !== new URL(origin).host || request.headers.origin && request.headers.origin !== origin ||
        request.headers['sec-fetch-site'] === 'cross-site') return send(403, '{"error":"forbidden"}');
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
          candidateScan ??= projectCandidates(store.list('project'), { ...candidateOptions, cliPath }).finally(() => { candidateScan = null; });
          return send(200, JSON.stringify(await candidateScan));
        }
        if (path === '/api/projects') return send(201, JSON.stringify(catalog.registerManual(input.project)));
        if (path === '/api/updates/preview') return send(200, JSON.stringify(await updates.preview()));
        if (path === '/api/updates/apply') return send(202, JSON.stringify(updates.apply(input.id)));
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
      if (path === '/api/overview') return send(200, JSON.stringify({ ...monitor.snapshot(), updates: updates.snapshot(), token, codeAgent: cliPath,
        discovery: cliPath ? 'installed' : observe ? 'not-found' : 'saved' }));
      const asset = assets.get(path);
      if (asset) return send(200, asset.body, asset.type);
      send(404, '{"error":"not-found"}');
    } catch (error) {
      const status = error.code === 'forbidden' ? 403 : ['stale-state', 'request-busy', 'request-conflict', 'already-exists', 'duplicate-path'].includes(error.code) ? 409 : error.code === 'not-found' ? 404 : error.code ? 400 : 500;
      send(status, JSON.stringify({ error: error.code ?? 'internal-error', message: error.code ? error.message : '요청 처리 중 오류가 발생했습니다.' }));
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
        await closed;
        await updating;
        store.close();
      })();
      return closing;
    },
  };
}
