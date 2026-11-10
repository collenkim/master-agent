import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { temporary, cleanup } from './helpers.mjs';
import { Store } from '../packages/storage/store.mjs';
import { Engine } from '../packages/orchestrator/engine.mjs';
import { LiveVerification } from '../packages/verification/live-verification.mjs';
import { Knowledge } from '../packages/knowledge/sources.mjs';
import { ControlHost } from '../packages/runner/control-host.mjs';
import { ControlError } from '../packages/code-agent-adapter/control.mjs';

/**
 * code-agent master 통신 계약을 흉내 내는 모의 전송(실제 code-agent·모델 실행이 아니다).
 * 세션 한 회차는 code-agent 절차의 자리만 흉내 낸다 — 접수(요구 동의 준비) → 계획(계획 동의 준비) → 구현·검증 기록(반영 동의 준비).
 * 동의는 위임 판단(decide)으로만 닫히고, 반영 승인은 영수증(master-delegation)을 남기는 단일 커밋을 만든다.
 * reviewQuestions 의 프로젝트는 구현 회차가 check·test 를 통과한 뒤 리뷰 자리에서 질문을 남기고 멈춘다 — 다음 회차가 반영 자리로 간다.
 * rejectContinue 의 프로젝트는 이어 실행 접수를 응답으로 거부한다(invalid-state — 실행을 만들지 않는다).
 * knowledge 는 프로젝트별 hello 지식 인계 공지다(code-agent master/control.ts 와 같은 꼴). 없으면 지식 인계 이전 빌드(공지 없음),
 * 'unreachable' 이면 hello 통신 실패. submit 의 knowledge 는 code-agent protocol.ts knowledgeHandoffOf 와 같은 규칙으로 검사하고
 * 처음 연 실행의 작업에 고정한다(다른 knowledge 로 start 하면 conflict). receipt 는 접수 응답의 참조 수를 바꿔 영수증 불일치를 흉내 낸다.
 * knowledge[id].gate 는 진행 게이트 빌드(knowledgeGate.ts)다 — hello 에 versions(지금 받는 형식, 기본 [1, 2] = 색인 대조 등록)·supportedVersions·maxBytes·
 * requiredGate·gate 를 공지하고, 공지하지 않은 형식은 knowledge-version 으로 거절하며, 접수 영수증에 정본 해시(digest)를 싣고,
 * 상태 조회에 작업의 게이트 판정(state.knowledge)과 재개 코드 knowledge-blocked 를 내며, knowledge verify 명령을 받는다.
 * gate[id] = { initial, afterVerify } 는 작업이 열린 뒤 판정('verified' | 'reverify' | 'replan', 기본 verified)과 verify 명령 뒤 판정이다.
 */
export function controlFixture(t, { questions = {}, humanOnly = {}, grants, reviewQuestions = {}, rejectContinue = {}, contractDocuments = {}, capability = 'code-agent:claude',
  knowledge = {}, receipt = {}, gate = {} } = {}) {
  const root = temporary(t), store = new Store(join(root, 'state.db')); cleanup(t, () => store.close());
  const engine = new Engine(store), verifier = new LiveVerification(store);
  const tasks = [], projects = [], sims = {}, calls = [], events = {};
  const git = (path, args) => execFileSync('git', ['-C', path, ...args], { stdio: 'pipe', encoding: 'utf8' });
  for (const id of ['one', 'two']) {
    const path = join(root, id); mkdirSync(path);
    writeFileSync(join(path, 'source.mjs'), 'export const value = 1;\n');
    writeFileSync(join(path, 'policy.txt'), '검증 범위 밖 파일을 변경하지 않는다.\n');
    for (const [file, text] of Object.entries(contractDocuments[id] ?? {})) {
      mkdirSync(dirname(join(path, file)), { recursive: true }); writeFileSync(join(path, file), text);
    }
    writeFileSync(join(path, 'check.mjs'), "import assert from 'node:assert/strict'; import { value } from './source.mjs'; assert.equal(value,2); console.log('실제 입력 검증 통과');\n");
    git(path, ['init', '--quiet']);
    // 실제 code-agent 설치처럼 진단 기록(.code-agent/log/)은 작업 트리 변경이 아니다
    mkdirSync(join(path, '.git', 'info'), { recursive: true }); writeFileSync(join(path, '.git', 'info', 'exclude'), '.code-agent/log/\n', { flag: 'a' });
    git(path, ['add', '.']); git(path, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'fixture baseline']);
    let p = engine.catalog.register({ id, name: id, path, domains: ['fixture'], capabilities: [capability], constraints: [], currentPlans: [], references: ['fixture'] });
    p = new Knowledge(store).collect(id, { schemaVersion: 1, sources: [{ path: 'source.mjs', kind: 'code' }, { path: 'policy.txt', kind: 'policy' }] }, p.revision).project;
    projects.push(p);
    sims[id] = { n: 0, work: null, request: null, approval: null, consents: [], questions: [], verification: null, lease: { state: 'none' }, runs: {}, commands: {}, works: {} };
    events[id] = { logId: `log-${id}`, list: [] };
    tasks.push({ id: `edit-${id}`, projectId: id, domain: 'fixture', kind: 'implementation', goal: 'value를 2로 변경', rationale: '합성 위임 시나리오',
      references: p.references, dependsOn: [], criteria: ['value'], allowedChanges: ['source.mjs'], exclusions: ['policy.txt'], outputs: ['result'], requiredCapabilities: [capability], verification: '실제 Node assertion' });
  }
  tasks.push({ ...tasks[0], id: 'integrate', kind: 'integration', dependsOn: ['edit-one', 'edit-two'], allowedChanges: [], goal: '두 프로젝트 실제 값 검증' });
  let mission = engine.create({ mode: 'live', goal: '두 프로젝트를 위임 판단과 실제 검증으로 완료', requestKey: 'control', scope: { projectIds: ['one', 'two'], groupIds: [] }, criteria: [{ id: 'value', description: '두 값이 2다.' }] });
  mission = engine.plan(mission.id, { schemaVersion: 1, summary: '통신 계약 시험 계획', unresolved: [], tasks }, mission.revision);
  const recipes = tasks.map(task => ({ schemaVersion: 1, taskId: task.id, allowedPaths: task.allowedChanges, codeAgentRecords: true, delivery: { mode: 'code-agent-commit', metadataPaths: [] },
    checks: (task.kind === 'integration' ? projects : projects.filter(p => p.id === task.projectId)).map(p => ({ id: `check-${p.id}`, executable: process.execPath, args: [join(p.path, 'check.mjs')], criterionIds: ['value'], timeoutMs: 5000 })),
    artifacts: [{ name: 'result', checkId: `check-${task.projectId}` }] }));
  for (const recipe of recipes) mission = verifier.configure(mission.id, recipe, mission.revision);
  const grantList = grants ?? [{ id: 'g1', actions: ['request', 'plan', 'deliver', 'answer'], missions: [mission.id], works: [], revoked: null, expired: false, exhausted: false }];

  const bump = id => { sims[id].n++; };
  const emit = (id, type, data = {}) => { const e = events[id]; e.list.push({ seq: e.list.length + 1, type, at: new Date().toISOString(), data }); };
  /** code-agent protocol.ts knowledgeDigest — 키 정렬 정본 JSON, 참조는 항목·조각 열쇠 순 */
  const canonicalJson = v => Array.isArray(v) ? `[${v.map(canonicalJson).join(',')}]` : v !== null && typeof v === 'object'
    ? `{${Object.entries(v).filter(([, x]) => x !== undefined).sort(([a], [b]) => a < b ? -1 : 1).map(([k, x]) => `${JSON.stringify(k)}:${canonicalJson(x)}`).join(',')}}` : JSON.stringify(v);
  const refKey = r => `${r.itemId}\u0000${r.segmentId ?? ''}`;
  const digestOf = k => `sha256:${createHash('sha256').update(canonicalJson({ version: k.version, refs: [...k.refs].sort((a, b) => refKey(a) < refKey(b) ? -1 : refKey(a) > refKey(b) ? 1 : 0) })).digest('hex')}`;
  /** 작업의 게이트 판정(knowledgeGate.ts knowledgeView 꼴) — 게이트 빌드이고 지금 작업에 인계가 있을 때만 */
  const gateView = id => {
    const s = sims[id], work = s.work && s.works[s.work.id];
    if (!knowledge[id]?.gate || !work?.knowledge) return null;
    const verdict = s.gateVerdict ?? gate[id]?.initial ?? 'verified', k = work.knowledge, required = k.refs.filter(r => r.required !== false);
    const base = { workId: s.work.id, digest: digestOf(k), version: k.version, refs: k.refs.length, required: required.length, optional: [] };
    if (verdict === 'verified') return { ...base, state: 'verified', verifiedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86400000).toISOString(), by: 'context', blocked: [] };
    const [reason, cause, recovery] = verdict === 'replan' ? ['content-changed', 'source-changed', 'replan'] : ['not-verified', 'unverified', 'reverify'];
    return { ...base, state: 'blocked', blocked: required.map(r => ({ itemId: r.itemId, required: true, reason, cause, recovery })), action: `knowledge-${recovery}` };
  };
  const stateOf = id => {
    const s = sims[id], pending = s.consents.filter(c => c.status === 'pending'), unanswered = s.questions.filter(q => !q.answered);
    // 수정 요청을 받은 확인 요청은 code-agent 처럼 다시 받을 확인 요청을 사람 몫으로 보인다(계획은 이전 승인이 있으면 reapproval-required)
    const revise = s.revise && { code: s.revise === 'plan' && s.approval ? 'reapproval-required' : 'needs-human', next: { action: { request: 'confirm-request', plan: 'plan-consent', deliver: 'deliver-consent' }[s.revise] } };
    const view = gateView(id);
    const blocked = view?.state === 'blocked' ? { code: 'knowledge-blocked', reasons: view.blocked.map(b => ({ code: `knowledge-${b.cause}`, detail: `${b.itemId}: ${b.reason}` })), next: { action: view.action, by: view.action === 'knowledge-replan' ? 'human' : 'model' } } : null;
    const resume = pending.length || unanswered.length ? { code: 'needs-human', next: { action: pending.length ? 'consent' : 'answer' } } : revise || blocked || (s.work || s.request?.status === 'confirmed' ? { code: 'ready' } : { code: 'no-work' });
    return { schema: 'code-agent.state', schemaVersion: 1, stateVersion: `${id}-v${s.n}`, work: s.work ? { ...s.work } : null, request: s.request ? { ...s.request } : null,
      approval: s.approval ? { ...s.approval } : null, consents: { readable: true, open: pending.map(c => ({ id: c.id, action: c.action, status: c.status })) },
      questions: { unanswered: unanswered.map(q => q.id), unverified: [] }, ownership: { process: 'unverified', lease: { ...s.lease } }, resume,
      verification: s.verification, findings: { blocking: false }, ...(view ? { knowledge: view } : {}) };
  };
  const deliverChoices = {};
  const prepare = (id, action, session) => {
    const consent = { id: `c-${action}-${randomUUID().slice(0, 8)}`, action, decision: 'yes', status: 'pending', summary: `${action} 확인`, choices: action === 'deliver' ? (deliverChoices[id] ?? []).map((c, i) => ({ index: i + 1, ...c })) : [], shownHash: `sha256:${action}`,
      preparedByMasterRun: true, humanOnly: humanOnly[id]?.includes(action) ?? false, preparedSession: { host: 'claude', id: session }, createdAt: new Date().toISOString() };
    sims[id].consents.push(consent); sims[id].revise = null; emit(id, 'consent.opened', { id: consent.id, action });
  };
  /** 세션 한 회차 — code-agent 절차의 다음 자리까지 가고 동의를 준비한 뒤 멈춘다(질문 도구를 쓰지 않는다) */
  const session = (project, runPayload, sessionId) => {
    const s = sims[project.id], workId = /"codeAgentWorkId": "([^"]+)"/.exec(runPayload.prompt)?.[1], kind = /"kind": "(implementation|integration)"/.exec(runPayload.prompt)?.[1];
    s.lease = { state: 'held', host: 'claude', session: sessionId };
    if (!s.request) {
      s.request = { status: 'pending' }; s.pendingWork = workId;
      prepare(project.id, 'request', sessionId);
      for (const q of questions[project.id] ?? []) s.questions.push({ ...q, answered: false });
    } else if (s.request.status !== 'confirmed') prepare(project.id, 'request', sessionId);
    else if (s.work?.phase === 'plan') prepare(project.id, 'plan', sessionId);
    else if (s.work?.phase === 'implement') {
      if (kind === 'integration') { mkdirSync(join(project.path, 'doc/work', s.work.id), { recursive: true }); writeFileSync(join(project.path, 'doc/work', s.work.id, 'summary.md'), '통합 확인\n'); }
      else writeFileSync(join(project.path, 'source.mjs'), 'export const value = 2;\n');
      s.verification = { bound: { valid: true }, phases: { check: { passed: true }, test: { passed: true } } };
      if (reviewQuestions[project.id] && kind !== 'integration') {
        s.work.phase = 'review'; emit(project.id, 'phase.changed', { workId: s.work.id, from: 'implement', to: 'review' });
        s.questions.push({ ...reviewQuestions[project.id], answered: false });
      } else {
        s.work.phase = 'deliver'; emit(project.id, 'phase.changed', { workId: s.work.id, from: 'implement', to: 'deliver' });
        prepare(project.id, 'deliver', sessionId);
      }
    } else if (s.work?.phase === 'review') {
      s.work.phase = 'deliver'; emit(project.id, 'phase.changed', { workId: s.work.id, from: 'review', to: 'deliver' });
      prepare(project.id, 'deliver', sessionId);
    } else if (s.work?.phase === 'deliver') prepare(project.id, 'deliver', sessionId);
    s.lease = { state: 'idle', host: 'claude', session: sessionId };
    bump(project.id);
  };
  const decide = (project, payload) => {
    const s = sims[project.id], consent = s.consents.find(c => c.id === payload.consentId);
    if (!consent || consent.status !== 'pending') throw new ControlError({ code: 'invalid-state', message: '응답을 기다리는 동의가 아닙니다' });
    if (!grantList.some(g => g.id === payload.grantId && g.actions.includes(consent.action))) throw new ControlError({ code: 'grant-missing', message: '권한 없음' });
    consent.delegation = { decisionId: payload.decisionId, grantId: payload.grantId, verdict: payload.verdict, category: payload.category };
    if (payload.verdict !== 'approve') { consent.status = 'changes-requested'; s.revise = consent.action; consent.comment = payload.reason; bump(project.id); return { status: 'changes-requested' }; }
    consent.status = 'applied';
    if (consent.action === 'request') { s.request = { status: 'confirmed' }; s.work = { id: s.pendingWork, phase: 'plan' }; }
    if (consent.action === 'plan') { s.approval = { status: 'approved' }; s.work.phase = 'implement'; }
    if (consent.action === 'deliver') {
      const dir = join(project.path, '.code-agent/approvals', s.work.id); mkdirSync(dir, { recursive: true });
      const receipt = { id: consent.id, workId: s.work.id, action: 'deliver', status: 'this-commit', createdAt: consent.createdAt, channel: 'master-delegation',
        preparedSession: consent.preparedSession, observed: [], delegation: { ...consent.delegation, controller: 'm1', generation: 1, at: new Date().toISOString() } };
      writeFileSync(join(dir, 'consents.jsonl'), `${JSON.stringify(receipt)}\n`);
      git(project.path, ['add', '-A']); git(project.path, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', `deliver ${s.work.id}`]);
      s.work = null; s.request = null; s.approval = null; s.verification = null; s.consents = []; s.questions = [];
      s.lease = { ...s.lease, state: 'other-work' };
    }
    emit(project.id, 'decision.applied', { consentId: consent.id }); bump(project.id);
    return { status: 'applied' };
  };
  /** code-agent protocol.ts knowledgeHandoffOf 의 형식 1 규칙 */
  const knowledgeOf = (value, max, accepted = [1]) => {
    const bad = message => { throw new ControlError({ code: 'invalid-request', message: `knowledge: ${message}` }); };
    if (!value || typeof value !== 'object' || Object.keys(value).some(k => !['version', 'refs'].includes(k))) bad('모르는 knowledge 키');
    if (value.version === 2 && accepted.includes(2)) {
      if (!Array.isArray(value.refs) || value.refs.length < 1 || value.refs.length > max) bad('refs 개수');
      for (const r of value.refs) if (['indexId', 'indexGeneration', 'itemId', 'itemSha256', 'commit', 'sourceId', 'path', 'startLine', 'endLine'].some(k => r[k] === undefined || r[k] === null)) bad('형식 2 필수 필드');
      return { version: 2, refs: value.refs.map(r => ({ ...r, required: r.required ?? true })) };
    }
    if (!accepted.includes(value.version)) throw new ControlError({ code: 'invalid-request', message: `knowledge: 형식 ${value.version} 은 받지 않습니다`, detail: { reason: 'knowledge-version' } });
    if (value.version !== 1) bad('version 1 만 받습니다');
    if (!Array.isArray(value.refs) || value.refs.length < 1 || value.refs.length > max) bad('refs 개수');
    const seen = new Set();
    for (const r of value.refs) {
      if (Object.keys(r).some(k => !['itemId', 'generation', 'commit', 'itemSha256', 'required'].includes(k))) bad('모르는 ref 키');
      if (typeof r.itemId !== 'string' || !r.itemId.includes(':') || !r.itemId.includes('#') || !Number.isSafeInteger(r.generation) || r.generation < 1 ||
        !/^[0-9a-f]{40}$/.test(r.commit) || !/^[0-9a-f]{64}$/.test(r.itemSha256) || !(r.required === undefined || typeof r.required === 'boolean')) bad('ref 형식');
      if (seen.has(r.itemId)) bad('itemId 가 겹칩니다'); seen.add(r.itemId);
    }
    return { version: 1, refs: value.refs.map(r => ({ ...r, required: r.required ?? true })) };
  };
  const canonical = k => JSON.stringify(k ? [...k.refs].sort((a, b) => a.itemId < b.itemId ? -1 : 1) : null);
  const helloOf = id => {
    const k = knowledge[id];
    return { versions: [1], hosts: [{ kind: 'claude', supported: true }], project: { enabled: true, projectId: id }, ownership: { controller: 'm1', generation: 1 },
      ...(k && k !== 'unreachable' ? { knowledge: { schemaVersion: 1, mode: k.mode ?? 'enabled', refs: { supported: true, accepted: k.accepted !== false, max: k.max ?? 20, ...(k.versions ? { versions: k.versions } : {}),
        ...(k.gate ? { versions: k.versions ?? [1, 2], supportedVersions: [1, 2], maxBytes: 32768, requiredGate: true, requiredDefault: true, scope: 'registered-docs' } : {}) },
      ...(k.gate ? { gate: { resume: 'knowledge-blocked', actions: ['knowledge-reverify', 'knowledge-replan'], causes: ['unverified', 'source-changed'], ttlSeconds: 86400, command: { type: 'knowledge', actions: ['verify', 'replace'] } } } : {}) } } : {}) };
  };
  const transport = project => ({
    async result(type, options = {}) {
      const s = sims[project.id], payload = options.payload ?? {};
      calls.push({ project: project.id, type, commandId: options.commandId, payload, delegationState: payload.decisionId ? store.get('delegation', payload.decisionId)?.state : undefined });
      if (options.commandId && s.commands[options.commandId]) {
        const seen = s.commands[options.commandId];
        if (JSON.stringify(seen.payload) !== JSON.stringify(payload)) throw new ControlError({ code: 'conflict', message: '같은 commandId 다른 내용' });
        return seen.result;
      }
      let result;
      switch (type) {
        case 'hello': {
          if (knowledge[project.id] === 'unreachable') throw Object.assign(new Error('hello 응답 없음'), { code: 'control-unavailable' });
          result = helloOf(project.id); break;
        }
        case 'submit': {
          if (payload.mode === 'continue' && rejectContinue[project.id]) throw new ControlError({ code: 'invalid-state', message: '지금 재개 판정에서는 실행을 시작하지 않습니다', detail: { resume: stateOf(project.id).resume } });
          const announced = helloOf(project.id).knowledge;
          let handoff;
          if (Object.hasOwn(payload, 'knowledge')) {
            // 지식 인계 이전 빌드가 모르는 payload 키를 무시한다고 가정하지 않는다 — 공지가 없으면 거부한다
            if (!announced) throw new ControlError({ code: 'invalid-request', message: '모르는 payload 키: knowledge' });
            handoff = knowledgeOf(payload.knowledge, announced.refs.max, announced.refs.versions ?? [1]);
            if (payload.mode === 'continue') throw new ControlError({ code: 'invalid-request', message: '이어 실행은 이전 실행의 인계 근거를 씁니다 — knowledge 는 start 에만 보냅니다' });
            if (!announced.refs.accepted) throw new ControlError({ code: 'invalid-state', message: '이 프로젝트는 지식 항목 참조를 받지 않습니다', detail: { reason: 'knowledge-refs-not-accepted', mode: announced.mode } });
          }
          const workId = /"codeAgentWorkId": "([^"]+)"/.exec(payload.prompt)?.[1];
          const bound = payload.mode === 'start' && workId ? s.works[workId] : null;
          if (bound && canonical(bound.knowledge) !== canonical(handoff)) throw new ControlError({ code: 'conflict', message: `작업 ${workId} 는 처음 연 실행의 인계 근거에 고정돼 있습니다`, detail: { workId, refs: bound.knowledge?.refs.length ?? 0 } });
          const runId = `run-${randomUUID().slice(0, 8)}`, sessionId = payload.sessionId ?? `session-${randomUUID().slice(0, 8)}`;
          const previous = payload.mode === 'continue' ? Object.values(s.runs).find(r => r.sessionId === payload.sessionId) : null;
          const used = handoff ?? previous?.knowledge;
          if (workId && !s.works[workId]) s.works[workId] = { workId, links: payload.links ?? {}, boundAt: new Date().toISOString(), runId, controller: 'm1', runs: [], ...(used ? { knowledge: used } : {}) };
          if (workId) s.works[workId].runs.push(runId);
          emit(project.id, 'run.accepted', { runId });
          session(project, payload, sessionId);
          s.runs[runId] = { runId, state: 'completed', sessionId, final: `회차 끝(${runId})`, ...(used ? { knowledge: used } : {}) };
          emit(project.id, 'run.finished', { runId, state: 'completed' });
          result = { runId, sessionId, state: 'accepted', mode: payload.mode, stateVersion: stateOf(project.id).stateVersion,
            ...(handoff ? { knowledge: { refs: receipt[project.id] ?? handoff.refs.length,
              ...(announced.gate ? { version: handoff.version, digest: digestOf(handoff), receipt: 'stored', verification: gateView(project.id)?.state ?? 'pending' } : {}) } } : {}) }; break;
        }
        case 'knowledge': {
          // code-agent control.ts knowledgeCommand verify — 지금 작업의 같은 참조만 다시 검증한다
          if (!helloOf(project.id).knowledge?.gate) throw new ControlError({ code: 'unsupported', message: type });
          if (payload.action !== 'verify') throw new ControlError({ code: 'invalid-request', message: 'knowledge action 은 verify·replace 입니다' });
          if (!s.work || s.work.id !== payload.workId) throw new ControlError({ code: 'invalid-state', message: '지금 작업만 다시 검증합니다', detail: { workId: payload.workId } });
          s.gateVerdict = gate[project.id]?.afterVerify ?? 'verified'; bump(project.id);
          emit(project.id, gateView(project.id)?.state === 'blocked' ? 'knowledge.blocked' : 'knowledge.verified', { workId: s.work.id });
          const state = stateOf(project.id);
          result = { workId: s.work.id, knowledge: gateView(project.id) ?? { state: 'none' }, resume: state.resume, stateVersion: state.stateVersion }; break;
        }
        case 'result': { const run = s.runs[payload.runId]; result = { run: { runId: run.runId, state: run.state, sessionId: run.sessionId }, result: { sessionId: run.sessionId, host: { finalMessage: run.final, permissionDenials: [], outputHash: 'h' } }, final: true }; break; }
        case 'command': { const seen = Object.entries(s.commands).find(([id]) => id === payload.commandId); result = seen ? { known: true, status: 'accepted', response: { ok: true, result: seen[1].result } } : { known: false }; break; }
        case 'events': {
          const e = events[project.id], after = payload.after ?? 0;
          if (payload.logId && payload.logId !== e.logId) { result = { logId: e.logId, firstSeq: 1, latestSeq: e.list.length, events: [], gap: true, reason: 'log-changed' }; break; }
          const list = e.list.filter(x => x.seq > after).slice(0, 200);
          result = { logId: e.logId, firstSeq: e.list[0]?.seq ?? 0, latestSeq: e.list.length, events: list, gap: e.dropped && after < e.dropped }; break;
        }
        case 'snapshot': result = { events: { logId: events[project.id].logId, latestSeq: events[project.id].list.length }, state: stateOf(project.id), runs: { active: [], recent: [] },
          works: Object.values(s.works).map(w => structuredClone(w)) }; break;
        case 'consents': result = { consents: s.consents.filter(c => c.status === 'pending').map(c => ({ ...c })) }; break;
        case 'questions': result = { questions: s.questions.map(q => ({ ...q })), questionsHash: `q-${s.n}` }; break;
        case 'grants': result = { grants: grantList }; break;
        case 'decide': result = decide(project, payload); break;
        case 'answer': {
          for (const a of payload.answers) { const q = s.questions.find(x => x.id === a.q); q.answered = true; q.answer = a.answer; q.actor = payload.actor; }
          bump(project.id); emit(project.id, 'answer.recorded', { actor: payload.actor }); result = { recorded: payload.answers.length }; break;
        }
        case 'pause': case 'cancel': { const run = s.runs[payload.runId]; result = { run: { runId: run.runId, state: run.state }, stopped: true, requested: true }; break; }
        default: throw new ControlError({ code: 'unsupported', message: type });
      }
      if (options.commandId) s.commands[options.commandId] = { payload, result };
      return result;
    },
  });
  class FakeControlHost extends ControlHost {
    client(project) { return transport(project); }
    inspect(project) { return Promise.resolve(stateOf(project.id)); }
    checkInstallation() {}
  }
  const host = new FakeControlHost(store, { cliPath: fileURLToPath(import.meta.url), pollMs: 0, sleep: async () => {} });
  const provider = { name: 'fake-judge', verdicts: [], prompts: [], async generate({ prompt, schema }) {
    provider.prompts.push(prompt);
    const answer = schema.required.includes('answer');
    const next = provider.verdicts.shift();
    return { data: next ?? (answer ? { category: 'routine', answer: '예', reason: '목표·완료 조건과 일치', evidence: ['task.goal'] }
      : { category: 'routine', verdict: 'approve', reason: '배정 범위 안의 일상 판단', evidence: ['task.allowedChanges', 'masterVerification'] }) };
  } };
  return { root, store, engine, verifier, mission, projects, tasks, recipes, sims, events, calls, host, provider, stateOf, grants: grantList, deliverChoices };
}
