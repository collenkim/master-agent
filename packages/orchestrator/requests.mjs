import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { spawn } from 'node:child_process';
import { mkdirSync, openSync, closeSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Engine } from './engine.mjs';
import { LiveWorkflow } from './drive.mjs';
import { ControlHost } from '../runner/control-host.mjs';
import { CliProvider } from '../reasoning/cli-provider.mjs';
import { Planner } from '../reasoning/planner.mjs';
import { VerificationTemplates } from '../verification/templates.mjs';
import { findCodeAgent } from '../code-agent-adapter/discovery.mjs';
import { observeProject } from '../code-agent-adapter/observe.mjs';
import { requireThat, string, now } from '../domain/contracts.mjs';

function alive(pid, host) {
  if (!pid) return false;
  if (host !== hostname()) return true;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}

export function requestStatus(record) {
  if (['running', 'queued'].includes(record.state) && record.pid && !alive(record.pid, record.host)) return { ...record, state: 'interrupted' };
  return record;
}

export function acceptRequest(store, { targetType, targetId, goal, criteria, requestKey = randomUUID(), groupRevision, provider = 'claude', model, templates = [] }) {
  requireThat(['project', 'group'].includes(targetType), 'invalid-input', '프로젝트 또는 그룹을 선택하세요.');
  string(targetId, 'targetId'); string(goal, 'goal');
  requireThat(['claude', 'codex'].includes(provider), 'invalid-provider', '계획·판단 provider는 claude 또는 codex입니다.');
  requireThat(Array.isArray(templates), 'invalid-input', '검증 템플릿은 배열이어야 합니다.');
  requireThat(model === undefined || typeof model === 'string', 'invalid-input', '모델 이름은 문자열이어야 합니다.');
  const input = { mode: 'live', goal, requestKey, criteria: criteria ?? [{ id: 'request', description: goal }],
    scope: { projectIds: targetType === 'project' ? [targetId] : [], groupIds: targetType === 'group' ? [targetId] : [] },
    requestOptions: { provider, model: model ?? null, templates, groupRevision: groupRevision ?? null } };
  return store.transaction(() => {
    const duplicate = store.db.prepare('SELECT mission_id FROM requests WHERE key=?').get(requestKey);
    if (!duplicate && targetType === 'group' && groupRevision !== undefined) {
      requireThat(store.need('group', targetId).revision === groupRevision, 'stale-state', '그룹 구성이 변경되었습니다. 대상을 다시 확인하세요.');
    }
    const mission = new Engine(store).create(input, { inTransaction: true });
    const previous = store.get('target-request', mission.id);
    if (previous) return { request: requestStatus(previous), created: false };
    const request = store.put('target-request', { id: mission.id, targetType, targetId, goal, provider, model: model ?? null,
      templates: structuredClone(templates), templatesRegistered: false, projectIds: mission.scope.projectIds,
      groupRevision: mission.scope.groups[0]?.revision ?? null, state: 'queued', createdAt: now(), updatedAt: now(), blockers: [] });
    return { request, created: true };
  });
}

export function continueRequest(store, id, expectedRevision) {
  return store.transaction(() => {
    const record = store.need('target-request', id);
    requireThat(record.revision === expectedRevision, 'stale-state', '요청 상태가 변경되었습니다. 다시 조회하세요.');
    requireThat(!['succeeded', 'cancelled'].includes(store.need('mission', id).state), 'invalid-state', '종료된 목표입니다.');
    requireThat(!['queued', 'running'].includes(record.state) || !alive(record.pid, record.host), 'request-busy', '요청 실행기가 이미 실행 중입니다.');
    return store.put('target-request', { ...record, state: 'queued', pid: null, host: null, owner: null, error: null, updatedAt: now() }, record.revision);
  });
}

/** A durable worker survives the dashboard closing. It uses the existing LangGraph and gates. */
export async function runRequest(store, id, { cliPath, host, provider, workflow } = {}) {
  const owner = randomUUID();
  const record = store.transaction(() => {
    const current = store.need('target-request', id);
    requireThat(current.state === 'queued', 'request-busy', '대기 중인 요청만 실행할 수 있습니다.');
    return store.put('target-request', { ...current, state: 'running', owner, pid: process.pid, host: hostname(), updatedAt: now() }, current.revision);
  });
  const finish = patch => store.transaction(() => {
    const current = store.need('target-request', id);
    requireThat(current.owner === owner, 'request-busy', '요청 실행 소유자가 변경되었습니다.');
    return store.put('target-request', { ...current, ...patch, updatedAt: now() }, current.revision);
  });
  try {
    if (!record.templatesRegistered) {
      for (const template of record.templates) new VerificationTemplates(store).register(id, template, store.need('mission', id).revision);
      finish({ templatesRegistered: true });
    }
    const executionHost = host ?? new ControlHost(store, { cliPath: findCodeAgent(cliPath) });
    if (!host && !store.need('mission', id).plans.length) {
      for (const projectId of record.projectIds) {
        const observation = await observeProject(store, projectId, { cliPath: executionHost.cliPath });
        requireThat(observation.status === 'observed', observation.status, `${projectId}: ${observation.error ?? 'code-agent 상태를 확인할 수 없습니다.'}`);
      }
    }
    const reasoning = provider ?? new CliProvider({ provider: record.provider, model: record.model ?? undefined });
    const before = store.need('mission', id);
    if (before.planningHold && ['blocked', 'waiting-decision'].includes(before.state)) {
      await new Planner(store).analyze(id, reasoning, { expectedRevision: before.revision });
    }
    const result = await (workflow ?? new LiveWorkflow(store)).run(id, executionHost, reasoning);
    const mission = store.need('mission', id);
    return finish({ state: mission.state === 'succeeded' ? 'completed' : mission.state === 'cancelled' ? 'cancelled' : 'waiting',
      blockers: result.blockers ?? [], error: null });
  } catch (error) {
    return finish({ state: 'failed', error: { code: error.code ?? 'internal-error', message: error.message }, blockers: [error.code ?? 'internal-error'] });
  }
}

export async function launchRequest(store, id, { dbPath, cliPath } = {}) {
  const record = store.need('target-request', id);
  requireThat(record.state === 'queued', 'request-busy', '대기 중인 요청만 시작할 수 있습니다.');
  requireThat(!alive(record.pid, record.host), 'request-busy', '요청 실행기가 이미 시작되었습니다.');
  const args = [fileURLToPath(new URL('../../apps/cli/main.mjs', import.meta.url)), 'request', 'run', id, '--db', resolve(dbPath)];
  if (cliPath) args.push('--cli', cliPath);
  const logDir = join(dirname(resolve(dbPath)), 'request-logs');
  mkdirSync(logDir, { recursive: true });
  // IDs are created by Engine; never use a caller-supplied path as a log name.
  requireThat(/^[0-9a-f-]{36}$/.test(id), 'invalid-input', '요청 ID 형식이 잘못됐습니다.');
  const fd = openSync(join(logDir, `${id}.log`), 'a');
  try {
    const child = spawn(process.execPath, args, { cwd: dirname(resolve(dbPath)), detached: true, windowsHide: true, stdio: ['ignore', fd, fd] });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.unref();
    store.transaction(() => {
      const current = store.need('target-request', id);
      if (current.state === 'queued') store.put('target-request', { ...current, pid: child.pid, host: hostname(), updatedAt: now() }, current.revision);
    });
    return requestStatus(store.need('target-request', id));
  } catch (error) {
    store.transaction(() => {
      const current = store.need('target-request', id);
      if (current.state === 'queued') store.put('target-request', { ...current, state: 'failed', error: { code: 'worker-start-failed', message: error.message }, updatedAt: now() }, current.revision);
    });
    throw error;
  } finally { closeSync(fd); }
}
