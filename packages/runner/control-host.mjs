import { setTimeout as delay } from 'node:timers/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ControlClient, ControlError, validCli } from '../code-agent-adapter/control.mjs';
import { hostPrompt, inspectState } from './claude-host.mjs';
import { hash, now, requireThat, string } from '../domain/contracts.mjs';

/** master 기록에 남길 code-agent 이벤트 — 진척·질문·동의·검증·실행·연결. 나머지는 커서만 넘긴다 */
const RECORDED = new Set(['run.accepted', 'run.started', 'run.stop-requested', 'run.finished', 'run.abandoned', 'run.orphaned', 'run.unknown',
  'master.disconnected', 'master.reconnected', 'phase.changed', 'attempt.changed', 'resume.changed', 'question.opened', 'consent.opened', 'consent.closed',
  'verification.recorded', 'decision.applied', 'decision.rejected', 'answer.recorded', 'handover.stopped', 'handover.transferred', 'handover.accepted']);

const small = value => { const text = JSON.stringify(value ?? null); return text.length <= 2000 ? value ?? null : { truncated: true, hash: hash(value) }; };

// The supervisor owns selection, installation/trust validation and the frozen host profile.
export function checkManagedInstallation(project) {
  requireThat(existsSync(join(project.path, '.code-agent/version')), 'host-not-installed', 'code-agent 설치가 필요합니다. code-agent init과 doctor로 확인하세요.');
}
export function checkManagedSupport(hello) {
  requireThat(hello.versions?.includes(1) && hello.hosts?.some(h => ['claude', 'codex'].includes(h.kind) && h.supported),
    'control-unsupported', 'Claude 또는 Codex 관리 실행을 지원하는 code-agent가 필요합니다.');
}

/**
 * 사람이 `code-agent master enable` 로 켠 프로젝트에 제어자를 연결한다. 토큰 파일 경로만 저장한다(토큰 값은 저장하지 않는다).
 * 연결은 권한이 아니다 — 위임 승인은 사람이 code-agent 에서 따로 준 grant 범위에서만 받는다.
 */
export async function bindControl(store, projectId, { cliPath, controller, tokenFile, pairing }) {
  const project = store.need('project', projectId);
  const client = new ControlClient({ cliPath, projectPath: project.path, controller, tokenFile });
  const hello = await client.result('hello');
  requireThat(hello.project?.enabled === true, 'control-not-enabled', '이 프로젝트는 code-agent master 연동이 꺼져 있습니다 — 사람이 code-agent master enable 로 켭니다.');
  checkManagedSupport(hello);
  requireThat(hello.controllers?.includes(controller), 'control-unknown-controller', 'code-agent 에 등록되지 않은 제어자입니다.');
  const owner = hello.ownership?.controller === controller;
  const heartbeat = await client.result('heartbeat'); // 토큰 확인(읽기는 인증이 필요하다)
  return store.transaction(() => {
    const previous = store.get('control-binding', projectId);
    const binding = { id: projectId, controller, tokenFile, generation: owner ? hello.ownership.generation : null, owner,
      codeAgentProjectId: hello.project.projectId, codeAgentVersion: hello.codeAgent?.version, stateSchema: hello.codeAgent?.stateSchema, protocolVersion: 1,
      delegation: { available: hello.approvals?.delegationAvailable === true, actions: hello.approvals?.delegated?.actions ?? [] }, policy: hello.policy, boundAt: now(),
      events: heartbeat.events, ...(pairing ? { pairing } : {}) };
    const saved = store.put('control-binding', binding, previous?.revision ?? 0);
    store.event(projectId, 'control-bound', { controller, generation: binding.generation, owner });
    return saved;
  });
}

/**
 * 제어권 인계 요청 — 지금 소유자만 보낸다. code-agent 가 실행을 협력 정지(pause)로 멈추고 끝난 것을 확인한 뒤 세대를 올려 넘긴다.
 * 넘어가면 이 연결은 소유자가 아니다(이후 상태를 바꾸는 요청은 fenced). heartbeat 만료로 넘기지 않는다 — 정지 확인까지 기다린다.
 */
export async function requestControlHandover(store, projectId, { cliPath, to, commandId, waitMs = 0, pollMs = 2000, sleep = ms => delay(ms) }) {
  string(to, 'to'); string(commandId, 'commandId');
  const binding = store.get('control-binding', projectId), project = store.need('project', projectId);
  requireThat(binding?.owner && Number.isInteger(binding.generation), 'control-not-owner', '지금 소유자인 연결만 인계를 요청합니다.');
  const client = new ControlClient({ cliPath, projectPath: project.path, controller: binding.controller, tokenFile: binding.tokenFile, generation: binding.generation });
  let owner = await client.result('handover', { commandId, payload: { action: 'request', to } });
  store.transaction(() => store.event(projectId, 'control-handover-requested', { to, handover: owner?.handover ?? null }));
  const started = Date.now();
  for (let step = 1; owner?.handover?.state !== 'transferred' && Date.now() - started < waitMs; step++) {
    await sleep(pollMs);
    try { owner = await client.result('handover', { commandId: `${commandId}-advance-${step}`, payload: { action: 'advance' } }); }
    catch (error) {
      if (error.controlCode !== 'fenced') throw error;
      // 앞 요청이 넘긴 뒤 응답을 잃었다 — 공개 소개(hello)로 지금 소유자를 확인한다
      const hello = await client.result('hello');
      owner = { controller: hello.ownership?.controller, generation: hello.ownership?.generation, handover: hello.ownership?.handover };
    }
  }
  const transferred = owner?.handover?.state === 'transferred' || (owner?.controller === to && owner?.generation > binding.generation);
  if (transferred) store.transaction(() => {
    const current = store.need('control-binding', projectId);
    store.put('control-binding', { ...current, owner: false, generation: null, handedOverTo: to, handedOverAt: now() }, current.revision);
    store.event(projectId, 'control-handed-over', { to, generation: owner.generation ?? owner.handover?.generation ?? null });
  });
  return { transferred, owner };
}

/** 인계 인수 — 새 제어자가 새 세대로 accept 한 뒤 연결을 다시 맺는다. 인수 전에는 code-agent 가 새 제어자의 실행·판단도 받지 않는다 */
export async function acceptControl(store, projectId, { cliPath, controller, tokenFile }) {
  const project = store.need('project', projectId);
  const probe = new ControlClient({ cliPath, projectPath: project.path, controller, tokenFile });
  const hello = await probe.result('hello');
  const handover = hello.ownership?.handover;
  requireThat(hello.ownership?.controller === controller && handover?.state === 'transferred', 'control-no-handover', '이 제어자에게 넘어온, 인수를 기다리는 인계가 없습니다.');
  await probe.result('handover', { commandId: `accept-${handover.id}`, generation: hello.ownership.generation, payload: { action: 'accept', handoverId: handover.id } });
  return bindControl(store, projectId, { cliPath, controller, tokenFile });
}

/**
 * code-agent 의 master 통신 계약으로 실행하는 개발 호스트. 실행 접수는 code-agent 가 상태·소유·임대·작업 연결을 한 잠금 안에서 확인하고
 * 받는다(원자적 예약). commandId 는 master 의 invocationId 에서 만들어 같은 호출의 재전송이 실행을 두 번 만들지 않는다.
 * 실행이 끝날 때까지 이벤트를 커서로 받아 기록하고(누락이면 스냅샷으로 다시 맞춘다), 결과 근거를 그대로 돌려준다.
 */
export class ControlHost {
  mode = 'live';
  name = 'code-agent';
  transport = 'code-agent-master';
  constructor(store, { cliPath, pollMs = 2000, followTimeoutMs = 4 * 3600 * 1000, callTimeoutMs = 60000, sleep } = {}) {
    this.store = store; this.cliPath = validCli(cliPath); this.pollMs = pollMs; this.followTimeoutMs = followTimeoutMs; this.callTimeoutMs = callTimeoutMs;
    this.model = 'code-agent-configured'; this.sleep = sleep ?? (ms => delay(ms));
  }
  binding(projectId) {
    const binding = this.store.get('control-binding', projectId);
    requireThat(binding, 'control-not-bound', `프로젝트 ${projectId} 에 master 제어 연결이 없습니다 — project control 로 연결합니다.`);
    return binding;
  }
  client(project) {
    const binding = this.binding(project.id);
    return new ControlClient({ cliPath: this.cliPath, projectPath: project.path, controller: binding.controller, tokenFile: binding.tokenFile,
      generation: binding.generation ?? undefined, timeoutMs: this.callTimeoutMs });
  }
  inspect(project, expectedState, sessionId) { return inspectState(this.cliPath, project, expectedState, sessionId); }
  validateTicket(ticket) {
    const prompt = hostPrompt(ticket, { control: true });
    requireThat(prompt.length <= 20000, 'handoff-context-limit', '배정 입력이 code-agent 접수 한도 20000자를 넘습니다. 계약·범위를 나눠 다시 계획하세요. 계약을 잘라 보내지 않습니다.');
    return prompt;
  }
  checkInstallation(project) {
    checkManagedInstallation(project);
    const binding = this.binding(project.id);
    requireThat(binding.owner && Number.isInteger(binding.generation), 'control-not-owner', '이 제어자는 지금 소유자가 아닙니다 — 인계를 인수(accept)한 뒤 실행합니다.');
  }
  async execute(ticket, { beforeStart = () => {}, wait = true } = {}) {
    const prompt = this.validateTicket(ticket);
    this.checkInstallation(ticket.project);
    await this.inspect(ticket.project, ticket.expectedState, ticket.sessionId);
    beforeStart();
    const client = this.client(ticket.project), commandId = `inv-${ticket.invocationId}`;
    // 요청에서 고른 host 는 새 실행에만 보낸다 — 이어 실행은 code-agent 가 이전 실행의 선택을 그대로 쓴다
    const execution = ticket.sessionId ? null : this.store.get('target-request', ticket.missionId)?.execution ?? null;
    let accepted;
    try {
      accepted = await client.result('submit', { commandId, expect: { stateVersion: ticket.expectedState }, payload: {
        mode: ticket.sessionId ? 'continue' : 'start', ...(ticket.sessionId ? { sessionId: ticket.sessionId } : {}), ...(execution ? { execution } : {}), prompt,
        links: { missionId: ticket.missionId, taskId: ticket.taskId, attemptId: ticket.id, planVersion: String(ticket.planVersion), invocationId: ticket.invocationId } } });
    } catch (error) {
      // code-agent 가 응답으로 거부했다(ok:false) — 실행을 만들지 않았다는 확인이다. 이어 실행이면 같은 세션의 막힘으로 돌려준다(미확인이 아니다).
      // 통신 실패이거나 이어 갈 세션이 없는 첫 실행은 그대로 실패로 둔다
      if (!(error instanceof ControlError) || !ticket.sessionId) throw error;
      return this.rejected(ticket, error, commandId);
    }
    this.recordRun(ticket, accepted, commandId);
    return wait ? this.follow(ticket.project, accepted.runId, ticket) : { status: 'pending', runId: accepted.runId };
  }
  rejected(ticket, error, commandId) {
    this.store.transaction(() => this.store.event(ticket.missionId, 'control-submit-rejected', { attemptId: ticket.id, invocationId: ticket.invocationId, commandId, code: error.controlCode, message: error.message }));
    return { sessionId: ticket.sessionId, summary: `code-agent 가 이어 실행을 접수하지 않았습니다(${error.controlCode}: ${error.message}) — 실행되지 않았습니다.`.slice(0, 16000),
      status: 'blocked', permissionDenials: [], outputHash: hash({ commandId, code: error.controlCode, message: error.message }),
      control: { runId: null, state: 'rejected', rejected: { code: error.controlCode, message: error.message, commandId }, outcome: null, stop: null, stateBefore: null, stateAfter: null,
        resume: error.detail?.resume ?? null, commits: [], files: [], verification: null } };
  }
  /** master 재시작 뒤 — 같은 호출의 실행을 commandId 로 찾아 다시 붙는다. 실행을 새로 만들지 않는다 */
  async reattach(ticket, { wait = true } = {}) {
    const client = this.client(ticket.project), commandId = `inv-${ticket.invocationId}`;
    const known = await client.result('command', { payload: { commandId } });
    requireThat(known.known, 'control-not-submitted', 'code-agent 가 이 호출을 받은 기록이 없습니다 — 실행되지 않았습니다. 다시 배정하려면 상태를 대조한 뒤 새 호출로 합니다.');
    requireThat(known.status === 'accepted' && known.response?.ok && known.response.result?.runId, 'control-not-started',
      `이 호출은 실행되지 않았습니다(${known.status}${known.response?.error ? `: ${known.response.error.code}` : ''}).`);
    const runId = known.response.result.runId;
    if (!this.store.get('control-run', runId)) this.recordRun(ticket, known.response.result, commandId);
    return wait ? this.follow(ticket.project, runId, ticket) : this.poll(ticket.project, runId, ticket);
  }
  /** One observation only: independent projects can run while this invocation is pending. */
  async poll(project, runId, ticket) {
    const client = this.client(project);
    await this.pump(project, client, ticket.missionId);
    const view = await client.result('result', { payload: { runId } });
    this.updateRun(runId, view.run);
    if (view.final) {
      await this.pump(project, client, ticket.missionId);
      return this.outcome(view, runId);
    }
    requireThat(Date.now() - Date.parse(this.store.need('control-run', runId).acceptedAt) < this.followTimeoutMs,
      'control-follow-timeout', '실행 관측 시간이 초과됐습니다. 실행 여부를 대조한 뒤 다시 연결하세요.');
    return { status: 'pending', runId };
  }
  recordRun(ticket, accepted, commandId) {
    this.store.transaction(() => {
      const previous = this.store.get('control-run', accepted.runId);
      this.store.put('control-run', { id: accepted.runId, projectId: ticket.projectId ?? ticket.project.id, missionId: ticket.missionId, attemptId: ticket.id,
        invocationId: ticket.invocationId, commandId, sessionId: accepted.sessionId, mode: accepted.mode, state: accepted.state, acceptedAt: previous?.acceptedAt ?? now(), updatedAt: now() }, previous?.revision ?? 0);
      if (!previous) this.store.event(ticket.missionId, 'control-run-accepted', { runId: accepted.runId, attemptId: ticket.id, invocationId: ticket.invocationId, sessionId: accepted.sessionId });
    });
  }
  /** 실행이 끝 상태가 될 때까지 기다린다. 연결이 끊겨도 실행은 code-agent 에서 계속된다 — 여기서 기다림을 멈추는 것은 실패 판정이 아니다 */
  async follow(project, runId, ticket) {
    const client = this.client(project), started = Date.now();
    for (;;) {
      await this.pump(project, client, ticket?.missionId);
      const view = await client.result('result', { payload: { runId } });
      this.updateRun(runId, view.run);
      // 끝 상태는 실행 기록에 먼저 남고 run.finished 이벤트가 뒤따른다 — 끝을 본 뒤 한 번 더 받아 마지막 이벤트까지 남긴다
      if (view.final) { await this.pump(project, client, ticket?.missionId); return this.outcome(view, runId); }
      requireThat(Date.now() - started < this.followTimeoutMs, 'control-follow-timeout', '실행이 끝나기를 기다리는 시간이 지났습니다 — 실행은 code-agent 에서 계속될 수 있습니다. mission reattach 로 다시 붙습니다.');
      await this.sleep(this.pollMs);
    }
  }
  updateRun(runId, run) {
    if (!run) return;
    this.store.transaction(() => {
      const record = this.store.get('control-run', runId);
      const metadata = { state: run.state, outcome: run.outcome ?? null, sessionId: run.sessionId ?? record?.sessionId,
        hostKind: run.hostKind ?? record?.hostKind ?? null, sessionConfirmed: run.sessionConfirmed ?? record?.sessionConfirmed ?? null,
        sessionAlias: run.sessionAlias ?? record?.sessionAlias ?? null };
      if (!record || Object.entries(metadata).every(([key, value]) => hash(record[key] ?? null) === hash(value ?? null))) return;
      this.store.put('control-run', { ...record, ...metadata, updatedAt: now() }, record.revision);
    });
  }
  /** 이벤트를 커서 다음부터 받아 남긴다. 기록 ID 가 다르거나 구간이 비면 스냅샷으로 다시 맞춘다(누락을 추측으로 채우지 않는다) */
  async pump(project, client, missionId) {
    for (let page = 0; page < 20; page++) {
      const cursor = this.store.get('control-cursor', project.id);
      const read = await client.result('events', { payload: { after: cursor?.seq ?? 0, ...(cursor?.logId ? { logId: cursor.logId } : {}) } });
      if (read.gap) {
        const snapshot = await client.result('snapshot');
        this.store.transaction(() => {
          const current = this.store.get('control-cursor', project.id);
          this.store.put('control-cursor', { id: project.id, logId: snapshot.events.logId, seq: snapshot.events.latestSeq, resyncedAt: now() }, current?.revision ?? 0);
          this.store.event(missionId ?? project.id, 'control-resynced', { projectId: project.id, reason: read.reason ?? 'gap', from: cursor ?? null,
            to: snapshot.events, stateVersion: snapshot.state?.stateVersion, activeRuns: snapshot.runs?.active?.map(r => ({ runId: r.runId, state: r.state })) ?? [] });
        });
        return { resynced: true };
      }
      if (!read.events.length) {
        if (!cursor || cursor.logId !== read.logId) this.store.transaction(() => {
          const current = this.store.get('control-cursor', project.id);
          this.store.put('control-cursor', { id: project.id, logId: read.logId, seq: current?.seq ?? 0 }, current?.revision ?? 0);
        });
        return { resynced: false };
      }
      this.store.transaction(() => {
        const current = this.store.get('control-cursor', project.id);
        for (const event of read.events) {
          if (!RECORDED.has(event.type)) continue;
          this.store.event(missionId ?? project.id, 'control-event', { projectId: project.id, seq: event.seq, eventType: event.type, at: event.at,
            ...(event.runId ? { runId: event.runId } : {}), ...(event.stateVersion ? { stateVersion: event.stateVersion } : {}), data: small(event.data) });
        }
        this.store.put('control-cursor', { id: project.id, logId: read.logId, seq: read.events.at(-1).seq }, current?.revision ?? 0);
      });
      if (read.events.at(-1).seq >= read.latestSeq) return { resynced: false };
    }
    return { resynced: false };
  }
  /** code-agent 결과를 LiveExecution 의 호스트 결과로 옮긴다 — 완료 발언은 요약일 뿐이고 판정은 상태·검증 근거로 한다 */
  outcome(view, runId) {
    const run = view.run, result = view.result;
    requireThat(!['unknown', 'abandoned'].includes(run.state), `control-run-${run.state}`, `실행 ${runId} 의 결과를 확인할 수 없습니다(${run.state}) — 자동으로 다시 실행하지 않습니다.`);
    requireThat(result?.sessionId || run.sessionId, 'invalid-host-result', '실행 세션을 확인할 수 없습니다.');
    return {
      sessionId: result?.sessionId ?? run.sessionId,
      summary: String(result?.host?.finalMessage ?? `code-agent master 실행 ${runId}: ${run.state}`).slice(0, 16000),
      status: run.state === 'completed' && run.sessionConfirmed !== false ? 'returned' : 'blocked',
      permissionDenials: (result?.host?.permissionDenials ?? []).map(d => ({ tool: String(d.tool_name ?? d.tool ?? 'unknown') })).slice(0, 100),
      outputHash: result?.host?.outputHash ?? hash(view),
      control: { runId, state: run.state, hostKind: run.hostKind ?? null, sessionConfirmed: run.sessionConfirmed ?? null, sessionAlias: run.sessionAlias ?? null,
        outcome: run.outcome ?? null, stop: run.stop ?? null, stateBefore: result?.state?.before ?? null, stateAfter: result?.state?.after ?? null,
        resume: result?.state?.resume ?? null, commits: result?.changes?.commits ?? [], files: (result?.changes?.files ?? []).slice(0, 500),
        verification: result?.verification ? { bound: result.verification.bound ?? null, evidence: result.verification.evidence ?? null } : null },
    };
  }
  /** 정지·취소 — 요청 접수와 실제 정지를 가른다(stopped). 대상은 이 시도의 실행 하나다 */
  async stop(project, runId, mode, { force = false, reason, waitMs = 0, commandId } = {}) {
    requireThat(['pause', 'cancel'].includes(mode), 'invalid-input', 'mode는 pause 또는 cancel입니다.');
    string(commandId, 'commandId');
    return this.client(project).result(mode, { commandId, payload: { runId, force, waitMs, ...(reason ? { reason } : {}) } });
  }
  /** 시도의 지금 호출로 만든 실행만 멈춘다 — 다른 시도·프로젝트·세션의 실행은 대상이 아니다. 시도 상태는 결과를 받는 쪽(follow)이 남긴다 */
  async stopAttempt(missionId, attemptId, mode, { force = false, waitMs = 0, reason } = {}) {
    const m = this.store.need('mission', missionId), attempt = m.attempts.find(a => a.id === attemptId);
    requireThat(attempt?.mode === 'live' && attempt.state === 'running', 'invalid-state', '실행 중인 live 시도만 멈춥니다.');
    const run = this.store.list('control-run').find(r => r.attemptId === attemptId && r.invocationId === attempt.invocationId);
    requireThat(run, 'control-run-missing', '이 시도의 지금 호출로 접수된 실행 기록이 없습니다 — mission reattach 로 먼저 확인합니다.');
    const project = this.store.need('project', attempt.projectId);
    const result = await this.stop(project, run.id, mode, { force, waitMs, reason: reason ?? `master ${mode} ${missionId}/${attemptId}`, commandId: `stop-${run.id}-${mode}${force ? '-force' : ''}` });
    this.updateRun(run.id, result.run);
    this.store.transaction(() => this.store.event(missionId, 'control-stop-requested', { attemptId, runId: run.id, mode, force, stopped: result.stopped, state: result.run?.state ?? null }));
    return result;
  }
}
