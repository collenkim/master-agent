import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { spawn } from 'node:child_process';
import { mkdirSync, openSync, closeSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Engine } from './engine.mjs';
import { LiveWorkflow } from './drive.mjs';
import { ControlHost } from '../runner/control-host.mjs';
import { hostSelection, mainHost, reasoningFor } from '../reasoning/hosts.mjs';
import { Planner } from '../reasoning/planner.mjs';
import { Recovery } from './recovery.mjs';
import { VerificationTemplates } from '../verification/templates.mjs';
import { findCodeAgent } from '../code-agent-adapter/discovery.mjs';
import { prepareRequest, preparationCodes } from './preparation.mjs';
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

/**
 * host 를 고르면 이번 요청의 code-agent 개발 host와 master 계획·판단 AI가 같은 선택을 따른다(both 는 주 host + 교차 검증).
 * host 없이 접수한 요청은 개발에 프로젝트 실행 방식을, 계획·판단에 provider(기본 claude)를 쓴다.
 */
export function acceptRequest(store, { targetType, targetId, goal, taskNumber, criteria, requestKey = randomUUID(), groupRevision, host, provider, model, templates = [] }) {
  requireThat(['project', 'group'].includes(targetType), 'invalid-input', '프로젝트 또는 그룹을 선택하세요.');
  string(targetId, 'targetId'); string(goal, 'goal');
  requireThat(host === undefined || provider === undefined, 'invalid-input', 'host를 고르면 계획·판단도 그 host가 맡습니다. provider를 함께 지정하지 마세요.');
  const execution = host === undefined ? null : hostSelection(host);
  provider = execution ? mainHost(execution) : provider ?? 'claude';
  requireThat(['claude', 'codex'].includes(provider), 'invalid-provider', '계획·판단 provider는 claude 또는 codex입니다.');
  requireThat(Array.isArray(templates), 'invalid-input', '검증 템플릿은 배열이어야 합니다.');
  requireThat(model === undefined || typeof model === 'string', 'invalid-input', '모델 이름은 문자열이어야 합니다.');
  const input = { mode: 'live', goal, requestKey, criteria: criteria ?? [{ id: 'request', description: goal }],
    ...(taskNumber === undefined ? {} : { taskNumber }),
    scope: { projectIds: targetType === 'project' ? [targetId] : [], groupIds: targetType === 'group' ? [targetId] : [] },
    requestOptions: { ...(execution ? { host: execution } : { provider }), model: model ?? null, templates, groupRevision: groupRevision ?? null } };
  return store.transaction(() => {
    const duplicate = store.db.prepare('SELECT mission_id FROM requests WHERE key=?').get(requestKey);
    if (!duplicate && targetType === 'group' && groupRevision !== undefined) {
      requireThat(new Engine(store).catalog.activeGroup(targetId).revision === groupRevision, 'stale-state', '그룹 구성이 변경되었습니다. 대상을 다시 확인하세요.');
    }
    const mission = new Engine(store).create(input, { inTransaction: true });
    const previous = store.get('target-request', mission.id);
    if (previous) return { request: requestStatus(previous), created: false };
    const request = store.put('target-request', { id: mission.id, targetType, targetId, goal, execution, provider, model: model ?? null,
      ...(taskNumber === undefined ? {} : { taskNumber }),
      templates: structuredClone(templates), templatesRegistered: false, projectIds: mission.scope.projectIds,
      groupRevision: mission.scope.groups[0]?.revision ?? null, state: 'queued', createdAt: now(), updatedAt: now(), blockers: [] });
    return { request, created: true };
  });
}

export function continueRequest(store, id, expectedRevision, { inTransaction = false } = {}) {
  const apply = () => {
    const record = store.need('target-request', id);
    requireThat(record.revision === expectedRevision, 'stale-state', '요청 상태가 변경되었습니다. 다시 조회하세요.');
    requireThat(!store.list('interaction-command').some(c => c.missionId === id && c.resume?.state === 'launching'), 'request-busy', '답변 제출에서 기존 요청의 재개를 접수 중입니다. 중복 재개할 수 없습니다.');
    requireThat(!['succeeded', 'cancelled'].includes(store.need('mission', id).state), 'invalid-state', '종료된 목표입니다.');
    requireThat(!['queued', 'running'].includes(record.state) || !alive(record.pid, record.host), 'request-busy', '요청 실행기가 이미 실행 중입니다.');
    return store.put('target-request', { ...record, state: 'queued', pid: null, host: null, owner: null, error: null, updatedAt: now() }, record.revision);
  };
  return inTransaction ? apply() : store.transaction(apply);
}

/** A durable worker survives the dashboard closing. It uses the existing LangGraph and gates. */
export async function runRequest(store, id, { cliPath, host, provider, workflow, prepare = prepareRequest } = {}) {
  const owner = randomUUID();
  const record = store.transaction(() => {
    const current = store.need('target-request', id);
    requireThat(current.state === 'queued', 'request-busy', '대기 중인 요청만 실행할 수 있습니다.');
    return store.put('target-request', { ...current, state: 'running', owner, pid: process.pid, host: hostname(), updatedAt: now() }, current.revision);
  });
  const finish = patch => store.transaction(() => {
    const current = store.need('target-request', id);
    requireThat(current.owner === owner, 'request-busy', '요청 실행 소유자가 변경되었습니다.');
    if (current.state === 'cancelled') return current;
    return store.put('target-request', { ...current, ...patch, updatedAt: now() }, current.revision);
  });
  const recordPreparation = preparation => {
    store.transaction(() => {
      const engine = new Engine(store), m = store.need('mission', id);
      if (m.state === 'cancelled') return;
      m.preparation = preparation;
      if (preparation.state === 'waiting') m.reason = preparation.issues.map(i => `${i.projectName ?? i.projectId}: ${i.message}`).join('\n');
      else if (!m.plans.length && !m.planningHold) m.reason = '준비 점검을 마쳤습니다. 실행 계획을 생성합니다.';
      engine.save(m, 'request-preparation-checked', { state: preparation.state, codes: preparation.issues.map(i => i.code) });
    });
    return finish({ preparation, ...(preparation.state === 'waiting' ? { state: 'waiting', blockers: preparation.blockers ?? preparation.issues.map(i => `${i.projectId}:${i.code}`), error: null } : { error: null, blockers: [] }) });
  };
  try {
    if (!record.templatesRegistered) {
      for (const template of record.templates) new VerificationTemplates(store).register(id, template, store.need('mission', id).revision);
      finish({ templatesRegistered: true });
    }
    const executionHost = host ?? new ControlHost(store, { cliPath: findCodeAgent(cliPath) });
    if (!host) {
      const preparation = await prepare(store, record, { cliPath: executionHost.cliPath });
      const saved = recordPreparation(preparation);
      if (preparation.state === 'waiting') return saved;
    }
    const reasoning = provider ?? reasoningFor(record);
    for (const answer of store.need('mission', id).recoveryAnswers ?? []) {
      if (answer.state !== 'queued') continue;
      const engine = new Engine(store);
      store.transaction(() => {
        const m = store.need('mission', id), a = m.attempts.find(a => a.id === answer.attemptId);
        requireThat(a?.recoveryRunId === answer.runId && a.verificationRunId === answer.verificationRunId && !a.recoveryBusy, 'stale-question', '복구 답변의 대상이 변경되었습니다.');
        m.recoveryAnswers.find(r => r.commandId === answer.commandId).state = 'reviewing';
        engine.save(m, 'recovery-answer-reviewing', { commandId: answer.commandId });
      });
      try {
        const m = store.need('mission', id), a = m.attempts.find(a => a.id === answer.attemptId);
        const project = store.need('project', a.projectId);
        const remote = await executionHost.inspect(project, undefined, a.turns.at(-1)?.result?.sessionId);
        await new Recovery(store).recover(id, a.id, executionHost, reasoning, { expectedRevision: m.revision, expectedState: remote.stateVersion, context: answer.answer });
        store.transaction(() => {
          const current = store.need('mission', id);
          current.recoveryAnswers.find(r => r.commandId === answer.commandId).state = 'reviewed';
          engine.save(current, 'recovery-answer-reviewed', { commandId: answer.commandId });
        });
      } catch (error) {
        store.transaction(() => {
          const current = store.need('mission', id), item = current.recoveryAnswers.find(r => r.commandId === answer.commandId);
          item.state = 'failed'; item.error = error.code ?? 'recovery-error';
          engine.save(current, 'recovery-answer-failed', { commandId: answer.commandId });
        });
        throw error;
      }
    }
    const before = store.need('mission', id);
    if (before.planningHold && ['blocked', 'waiting-decision'].includes(before.state)) {
      const planner = new Planner(store);
      if (planner.repairClassification(id, before.revision)) return finish({ state: 'waiting', blockers: ['human-input'], error: null });
      const analysis = store.get('analysis-run', before.analysisRunId);
      if (['needs-context', 'needs-human'].includes(analysis?.status) && analysis.result.issues.some(i =>
        !(before.clarifications ?? []).some(a => a.analysisId === analysis.id && a.issueId === i.id))) {
        return finish({ state: 'waiting', blockers: ['human-input'], error: null });
      }
      await planner.analyze(id, reasoning, { expectedRevision: before.revision });
    }
    const result = await (workflow ?? new LiveWorkflow(store)).run(id, executionHost, reasoning);
    const mission = store.need('mission', id);
    const verificationIssues = (result.blockers ?? []).filter(code => code.endsWith(':missing-verification-recipe')).map(code => {
      const taskId = code.slice(0, -':missing-verification-recipe'.length);
      const task = mission.plans.at(-1)?.proposal.tasks.find(t => t.id === taskId);
      return { projectId: task?.projectId ?? record.projectIds[0], code: 'missing-verification-recipe', message: `${taskId}: 독립 검증 계약이 필요합니다.`,
        guidance: `완료 조건·파일 범위·검사 명령을 지정한 검증 계약을 등록하세요.\nmaster-agent mission verification ${id} <검증 계약 JSON 파일> --revision <최신 목표 버전> --db <현재 대시보드 DB>\n기존 템플릿은 mission verification-template으로 등록할 수 있습니다. 등록 후 같은 요청을 재점검하세요.` };
    });
    if (verificationIssues.length) return recordPreparation({ state: 'waiting', checkedAt: now(), checks: [], issues: verificationIssues, blockers: result.blockers });
    return finish({ state: mission.state === 'succeeded' ? 'completed' : mission.state === 'cancelled' ? 'cancelled' : 'waiting',
      blockers: result.blockers ?? [], error: null });
  } catch (error) {
    if (!host && preparationCodes.has(error.code)) return recordPreparation({ checkedAt: now(), state: 'waiting', checks: [], issues: [{
      projectId: record.projectIds[0], code: error.code, message: error.message, guidance: '설치·근거·제어 연결을 확인한 뒤 같은 요청에서 준비 상태를 다시 확인하세요.' }] });
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
