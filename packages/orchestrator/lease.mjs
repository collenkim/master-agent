import { hostname } from 'node:os';

export const LEASE_TTL_MS = 10 * 60 * 1000;
export const HEARTBEAT_MS = 30 * 1000;

export function localProcessAlive(pid, host) {
  if (host !== hostname() || !Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}

export function leaseActive({ pid, host, heartbeatAt, startedAt }, time = Date.now()) {
  if (localProcessAlive(pid, host)) return true;
  const heartbeat = Date.parse(heartbeatAt ?? startedAt);
  return Number.isFinite(heartbeat) && time - heartbeat < LEASE_TTL_MS;
}
