import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { once } from 'node:events';
import { Store } from '../storage/store.mjs';
import { requireThat } from '../domain/contracts.mjs';
import { validCli } from '../code-agent-adapter/control.mjs';
import { createMonitor } from './monitor.mjs';

export async function startDashboard({ dbPath, port = 4310, cliPath, intervalMs = 5000 } = {}) {
  requireThat(Number.isInteger(port) && port >= 0 && port <= 65535, 'usage', '--port는 0~65535 정수입니다.');
  requireThat(Number.isInteger(intervalMs) && intervalMs >= 1000 && intervalMs <= 3600000, 'usage', '--refresh-ms는 1000~3600000 정수입니다.');
  if (cliPath) validCli(cliPath);
  const assets = new Map([
    ['/', ['text/html; charset=utf-8', 'index.html']],
    ['/app.mjs', ['text/javascript; charset=utf-8', 'app.mjs']],
    ['/style.css', ['text/css; charset=utf-8', 'style.css']],
  ].map(([path, [type, file]]) => [path, { type, body: readFileSync(new URL(`../../apps/dashboard/${file}`, import.meta.url)) }]));
  const store = new Store(dbPath), monitor = createMonitor(store, { cliPath, intervalMs });
  let origin;
  const server = createServer((request, response) => {
    const send = (status, body, type = 'application/json; charset=utf-8') => {
      response.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
        'Referrer-Policy': 'no-referrer' });
      response.end(body);
    };
    // Loopback binding plus exact Host/Origin checks keep other sites from reading local records.
    if (request.headers.host !== new URL(origin).host || request.headers.origin && request.headers.origin !== origin ||
        request.headers['sec-fetch-site'] === 'cross-site') return send(403, '{"error":"forbidden"}');
    if (request.method !== 'GET') return send(405, '{"error":"read-only"}');
    try {
      const path = new URL(request.url, origin).pathname;
      if (path === '/api/overview') return send(200, JSON.stringify(monitor.snapshot()));
      const asset = assets.get(path);
      if (asset) return send(200, asset.body, asset.type);
      send(404, '{"error":"not-found"}');
    } catch { send(500, '{"error":"snapshot-failed"}'); }
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
  return { url: origin, monitor,
    close() {
      closing ??= (async () => {
        const closed = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        server.closeIdleConnections();
        await monitor.stop();
        await closed;
        store.close();
      })();
      return closing;
    },
  };
}
