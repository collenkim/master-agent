import { mkdirSync, mkdtempSync, lstatSync, readFileSync, writeFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { localProcessAlive } from '../packages/orchestrator/lease.mjs';

export const SMOKE_KEEP = 3;
const MARKER = '.master-agent-smoke.json';
const active = new Map();
let exitHook = false;
const fail = message => { throw new Error(message); };
const prefixValid = prefix => typeof prefix === 'string' && /^[a-z][a-z0-9-]*-$/.test(prefix);
const ownerAlive = record => record.state === 'active' && (record.host !== hostname() || localProcessAlive(record.pid, record.host));
const isActive = record => record.protected === true || ownerAlive(record);
let lastStamp = 0;
const stamp = () => new Date(lastStamp = Math.max(Date.now(), lastStamp + 1)).toISOString();

function directory(path) {
  const absolute = resolve(path), stat = lstatSync(absolute);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('smoke 산출물 경로는 일반 디렉터리여야 한다.');
  return realpathSync(absolute);
}

function owned(path, root, prefix) {
  try {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || dirname(realpathSync(path)) !== root || (prefix !== undefined && !basename(path).startsWith(prefix))) return null;
    const markerPath = join(path, MARKER), markerStat = lstatSync(markerPath);
    if (!markerStat.isFile() || markerStat.isSymbolicLink() || markerStat.size > 4096) return null;
    const record = JSON.parse(readFileSync(markerPath, 'utf8'));
    if (record.schemaVersion !== 1 || record.kind !== 'master-agent-smoke' || (prefix !== undefined && record.prefix !== prefix) || !basename(path).startsWith(record.prefix) ||
        !prefixValid(record.prefix) || typeof record.id !== 'string' || !Number.isFinite(Date.parse(record.createdAt)) ||
        !Number.isSafeInteger(record.pid) || record.pid <= 0 || typeof record.host !== 'string' ||
        !['active', 'finished'].includes(record.state) || (record.protected !== undefined && typeof record.protected !== 'boolean') ||
        (record.updatedAt !== undefined && !Number.isFinite(Date.parse(record.updatedAt)))) return null;
    return { path, stat, record };
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes(error.code) || error instanceof SyntaxError) return null;
    throw error;
  }
}

export function pruneSmokeArtifacts(root, prefix, keep = SMOKE_KEEP) {
  if (!prefixValid(prefix) || !Number.isSafeInteger(keep) || keep < 1 || keep > 100) fail('smoke 보존 설정이 잘못됐다.');
  const base = directory(root);
  const entries = readdirSync(base, { withFileTypes: true }).filter(entry => entry.isDirectory() && !entry.isSymbolicLink() && entry.name.startsWith(prefix))
    .map(entry => owned(join(base, entry.name), base, prefix)).filter(Boolean);
  const running = entries.filter(entry => isActive(entry.record)).length;
  const finished = entries.filter(entry => !isActive(entry.record))
    .sort((a, b) => Date.parse(b.record.updatedAt ?? b.record.createdAt) - Date.parse(a.record.updatedAt ?? a.record.createdAt) || b.path.localeCompare(a.path));
  const removed = [];
  for (const entry of finished.slice(Math.max(0, keep - running))) {
    const current = owned(entry.path, base, prefix);
    if (!current || current.record.id !== entry.record.id || current.stat.ino !== entry.stat.ino || isActive(current.record)) continue;
    if (dirname(realpathSync(entry.path)) !== base || lstatSync(entry.path).isSymbolicLink()) fail('smoke 삭제 경계가 바뀌었다.');
    rmSync(entry.path, { recursive: true, force: false, maxRetries: 3, retryDelay: 100 });
    removed.push(entry.path);
  }
  return removed;
}

function remember(path, record, keep) {
  active.set(path, { id: record.id, keep });
  if (!exitHook) {
    exitHook = true;
    process.once('exit', () => {
      for (const path of active.keys()) {
        try { finishSmokeArtifacts(path); }
        catch (error) { console.error('smoke 산출물 종료 기록 실패:', error.code ?? 'artifact-error'); }
      }
    });
  }
  return path;
}

export function createSmokeArtifacts(prefix, { root = process.env.MASTER_AGENT_SMOKE_ROOT ?? '.master-agent', keep = SMOKE_KEEP } = {}) {
  if (!prefixValid(prefix) || !Number.isSafeInteger(keep) || keep < 1 || keep > 100) fail('smoke 보존 설정이 잘못됐다.');
  mkdirSync(resolve(root), { recursive: true });
  const base = directory(root), path = realpathSync(mkdtempSync(join(base, prefix)));
  const createdAt = stamp();
  const record = { schemaVersion: 1, kind: 'master-agent-smoke', id: randomUUID(), prefix,
    createdAt, updatedAt: createdAt, pid: process.pid, host: hostname(), state: 'active', protected: false };
  writeFileSync(join(path, MARKER), JSON.stringify(record) + '\n', { flag: 'wx' });
  remember(path, record, keep);
  pruneSmokeArtifacts(base, prefix, keep);
  return path;
}

export function finishSmokeArtifacts(path) {
  const absolute = resolve(path), tracked = active.get(absolute);
  if (!tracked) return false;
  active.delete(absolute);
  let base;
  try { base = directory(dirname(absolute)); } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  const marker = join(absolute, MARKER);
  const entry = owned(absolute, base);
  if (!entry || entry.record.id !== tracked.id || entry.record.pid !== process.pid || entry.record.host !== hostname()) return false;
  writeFileSync(marker, JSON.stringify({ ...entry.record, state: 'finished', updatedAt: stamp() }) + '\n');
  pruneSmokeArtifacts(base, entry.record.prefix, tracked.keep);
  return true;
}

export function trackSmokeArtifacts(path, { exclusive = false, keep = SMOKE_KEEP } = {}) {
  if (!Number.isSafeInteger(keep) || keep < 1 || keep > 100) fail('smoke 보존 설정이 잘못됐다.');
  const absolute = directory(path), base = directory(dirname(absolute));
  try { lstatSync(join(absolute, MARKER)); }
  catch (error) { if (error.code === 'ENOENT') return absolute; throw error; }
  const entry = owned(absolute, base);
  if (!entry) fail('smoke 산출물 소유 표지가 잘못됐다.');
  if (ownerAlive(entry.record) && (entry.record.pid !== process.pid || entry.record.host !== hostname())) {
    if (exclusive) fail('다른 프로세스가 사용 중인 smoke 산출물이다.');
    return absolute;
  }
  const updated = { ...entry.record, pid: process.pid, host: hostname(), state: 'active', updatedAt: stamp() };
  writeFileSync(join(absolute, MARKER), JSON.stringify(updated) + '\n');
  return remember(absolute, updated, keep);
}

export function protectSmokeArtifacts(path, protect) {
  if (typeof protect !== 'boolean') fail('smoke 산출물 보존 설정이 잘못됐다.');
  const absolute = resolve(path), tracked = active.get(absolute);
  if (!tracked) return false;
  const base = directory(dirname(absolute)), entry = owned(absolute, base);
  if (!entry || entry.record.id !== tracked.id || entry.record.pid !== process.pid || entry.record.host !== hostname()) fail('smoke 산출물 소유권이 바뀌었다.');
  writeFileSync(join(absolute, MARKER), JSON.stringify({ ...entry.record, protected: protect }) + '\n');
  return true;
}
