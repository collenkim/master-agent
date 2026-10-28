import { hostname } from 'node:os';
import { alive } from '../runner/process.mjs';

export const LEASE_TTL_MS = 10 * 60 * 1000;
export const HEARTBEAT_MS = 30 * 1000;

export function localProcessAlive(pid, host) {
  return host === hostname() && alive(pid);
}

export function leaseActive({ pid, host, heartbeatAt, startedAt }, time = Date.now()) {
  if (localProcessAlive(pid, host)) return true;
  const heartbeat = Date.parse(heartbeatAt ?? startedAt);
  return Number.isFinite(heartbeat) && time - heartbeat < LEASE_TTL_MS;
}
