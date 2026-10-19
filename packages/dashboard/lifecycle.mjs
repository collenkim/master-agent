import { readFileSync, writeFileSync, mkdirSync, unlinkSync, renameSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { startDashboard, validateDashboardOptions } from './server.mjs';
import { requireThat } from '../domain/contracts.mjs';

const read = path => {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
};
function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}
function removeOwned(path, id) { if (read(path)?.id === id) unlinkSync(path); }
function claim(path, id) {
  const previous = read(path);
  if (previous) {
    requireThat(!alive(previous.pid), 'dashboard-busy', '대시보드가 실행 중이거나 시작·종료 중입니다. dashboard status 또는 restart를 사용하세요.');
    removeOwned(path, previous.id);
  }
  try { writeFileSync(path, JSON.stringify({ id, pid: process.pid }), { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    requireThat(false, 'dashboard-busy', '다른 대시보드 명령이 먼저 실행됐습니다. 상태를 다시 확인하세요.');
  }
}

async function control(record, action) {
  const url = new URL(record.url);
  requireThat(url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.pathname === '/' && !url.username && !url.password,
    'invalid-dashboard-state', '저장된 대시보드 주소가 올바르지 않습니다.');
  const response = await fetch(new URL('/api/dashboard-control', url), { method: 'POST', redirect: 'error',
    signal: AbortSignal.timeout(3000), headers: { Origin: url.origin, 'Content-Type': 'application/json', 'X-Master-Control': record.token },
    body: JSON.stringify({ id: record.id, action }) });
  requireThat(response.ok, 'dashboard-unavailable', '실행 중인 서버의 제어 인증을 확인할 수 없습니다. 기존 터미널에서 종료 후 다시 실행하세요.');
  const result = await response.json();
  requireThat(result.id === record.id, 'dashboard-unavailable', '저장된 서버와 응답한 서버가 다릅니다.');
  return result;
}

/** Foreground lifecycle: authenticated shutdown, never terminate a process based on a saved PID. */
export async function dashboardCommand(action, supplied = {}) {
  requireThat(['start', 'restart', 'stop', 'status'].includes(action), 'usage', 'dashboard [start|restart|stop|status]를 사용하세요.');
  const dbPath = resolve(supplied.dbPath ?? '.master-agent/master.db');
  const statePath = `${dbPath}.dashboard.json`, lockPath = `${dbPath}.dashboard.lock`;
  const previous = read(statePath), lock = read(lockPath);
  const sameRecord = previous && lock?.id === previous.id;
  const locked = lock && alive(lock.pid);
  if (action === 'status') {
    let state = locked ? 'unreachable' : 'stopped';
    if (locked && sameRecord) { try { state = (await control(previous, 'status')).state; } catch { /* Preserve uncertain ownership. */ } }
    return { info: { state, db: dbPath, url: previous?.url ?? null } };
  }
  const overrides = Object.fromEntries(Object.entries(supplied).filter(([, value]) => value !== undefined));
  const options = { port: 4310, intervalMs: 5000, observe: true, cwd: process.cwd(),
    ...(action === 'restart' ? previous?.options : {}), ...overrides, dbPath };
  // Invalid overrides must not stop a healthy server.
  if (action !== 'stop') validateDashboardOptions(options);
  if (['restart', 'stop'].includes(action) && locked) {
    requireThat(sameRecord, 'dashboard-busy', '대시보드 시작·종료가 진행 중입니다. 잠시 후 상태를 확인하세요.');
    await control(previous, 'status');
    await control(previous, 'stop');
    const deadline = Date.now() + 15000;
    while (read(lockPath)?.id === lock.id) {
      requireThat(Date.now() < deadline, 'dashboard-busy', '서버 종료 대기 시간이 초과됐습니다. 기존 터미널과 dashboard status를 확인하세요.');
      await delay(100);
    }
  }
  if (action === 'stop') {
    if (lock && !locked) removeOwned(lockPath, lock.id);
    return { info: { state: 'stopped', db: dbPath, url: previous?.url ?? null } };
  }
  mkdirSync(dirname(dbPath), { recursive: true });
  const id = randomUUID(), token = randomUUID();
  claim(lockPath, id);
  let dashboard, closing;
  const close = () => closing ??= (async () => {
    if (dashboard) await dashboard.close();
    removeOwned(lockPath, id);
  })();
  const tempPath = `${statePath}.${id}.tmp`;
  try {
    dashboard = await startDashboard({ ...options, candidateOptions: { cwd: options.cwd }, management: { id, token,
      stop: () => { close().catch(error => { console.error(error.message); process.exitCode = 1; }); } } });
    options.port = Number(new URL(dashboard.url).port);
    writeFileSync(tempPath, JSON.stringify({ id, token, pid: process.pid, url: dashboard.url, options }), { mode: 0o600 });
    renameSync(tempPath, statePath);
    return { close, info: { state: 'running', url: dashboard.url, db: dbPath,
      mode: dashboard.cliPath ? 'live-observation' : 'saved-observation', codeAgent: dashboard.cliPath } };
  } catch (error) {
    await close();
    try { unlinkSync(tempPath); } catch (cleanupError) { if (cleanupError.code !== 'ENOENT') throw cleanupError; }
    throw error;
  }
}
