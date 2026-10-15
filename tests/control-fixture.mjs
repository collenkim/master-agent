import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
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
 */
export function controlFixture(t, { questions = {}, humanOnly = {}, grants, reviewQuestions = {}, rejectContinue = {} } = {}) {
  const root = temporary(t), store = new Store(join(root, 'state.db')); cleanup(t, () => store.close());
  const engine = new Engine(store), verifier = new LiveVerification(store);
  const tasks = [], projects = [], sims = {}, calls = [], events = {};
  const git = (path, args) => execFileSync('git', ['-C', path, ...args], { stdio: 'pipe', encoding: 'utf8' });
  for (const id of ['one', 'two']) {
    const path = join(root, id); mkdirSync(path);
    writeFileSync(join(path, 'source.mjs'), 'export const value = 1;\n');
    writeFileSync(join(path, 'policy.txt'), '검증 범위 밖 파일을 변경하지 않는다.\n');
    writeFileSync(join(path, 'check.mjs'), "import assert from 'node:assert/strict'; import { value } from './source.mjs'; assert.equal(value,2); console.log('실제 입력 검증 통과');\n");
    git(path, ['init', '--quiet']); git(path, ['add', '.']); git(path, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'fixture baseline']);
    let p = engine.catalog.register({ id, name: id, path, domains: ['fixture'], capabilities: ['code-agent:claude'], constraints: [], currentPlans: [], references: ['fixture'] });
    p = new Knowledge(store).collect(id, { schemaVersion: 1, sources: [{ path: 'source.mjs', kind: 'code' }, { path: 'policy.txt', kind: 'policy' }] }, p.revision).project;
    projects.push(p);
    sims[id] = { n: 0, work: null, request: null, approval: null, consents: [], questions: [], verification: null, lease: { state: 'none' }, runs: {}, commands: {} };
    events[id] = { logId: `log-${id}`, list: [] };
    tasks.push({ id: `edit-${id}`, projectId: id, domain: 'fixture', kind: 'implementation', goal: 'value를 2로 변경', rationale: '합성 위임 시나리오',
      references: p.references, dependsOn: [], criteria: ['value'], allowedChanges: ['source.mjs'], exclusions: ['policy.txt'], outputs: ['result'], requiredCapabilities: ['code-agent:claude'], verification: '실제 Node assertion' });
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
  const stateOf = id => {
    const s = sims[id], pending = s.consents.filter(c => c.status === 'pending'), unanswered = s.questions.filter(q => !q.answered);
    // 수정 요청을 받은 확인 요청은 code-agent 처럼 다시 받을 확인 요청을 사람 몫으로 보인다(계획은 이전 승인이 있으면 reapproval-required)
    const revise = s.revise && { code: s.revise === 'plan' && s.approval ? 'reapproval-required' : 'needs-human', next: { action: { request: 'confirm-request', plan: 'plan-consent', deliver: 'deliver-consent' }[s.revise] } };
    const resume = pending.length || unanswered.length ? { code: 'needs-human', next: { action: pending.length ? 'consent' : 'answer' } } : revise || (s.work || s.request?.status === 'confirmed' ? { code: 'ready' } : { code: 'no-work' });
    return { schema: 'code-agent.state', schemaVersion: 1, stateVersion: `${id}-v${s.n}`, work: s.work ? { ...s.work } : null, request: s.request ? { ...s.request } : null,
      approval: s.approval ? { ...s.approval } : null, consents: { readable: true, open: pending.map(c => ({ id: c.id, action: c.action, status: c.status })) },
      questions: { unanswered: unanswered.map(q => q.id), unverified: [] }, ownership: { process: 'unverified', lease: { ...s.lease } }, resume,
      verification: s.verification, findings: { blocking: false } };
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
        s.work.phase = 'review'; emit(project.id, 'phase.changed', { phase: 'review' });
        s.questions.push({ ...reviewQuestions[project.id], answered: false });
      } else {
        s.work.phase = 'deliver'; emit(project.id, 'phase.changed', { phase: 'deliver' });
        prepare(project.id, 'deliver', sessionId);
      }
    } else if (s.work?.phase === 'review') {
      s.work.phase = 'deliver'; emit(project.id, 'phase.changed', { phase: 'deliver' });
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
        case 'submit': {
          if (payload.mode === 'continue' && rejectContinue[project.id]) throw new ControlError({ code: 'invalid-state', message: '지금 재개 판정에서는 실행을 시작하지 않습니다', detail: { resume: stateOf(project.id).resume } });
          const runId = `run-${randomUUID().slice(0, 8)}`, sessionId = payload.sessionId ?? `session-${randomUUID().slice(0, 8)}`;
          emit(project.id, 'run.accepted', { runId });
          session(project, payload, sessionId);
          s.runs[runId] = { runId, state: 'completed', sessionId, final: `회차 끝(${runId})` };
          emit(project.id, 'run.finished', { runId, state: 'completed' });
          result = { runId, sessionId, state: 'accepted', mode: payload.mode, stateVersion: stateOf(project.id).stateVersion }; break;
        }
        case 'result': { const run = s.runs[payload.runId]; result = { run: { runId: run.runId, state: run.state, sessionId: run.sessionId }, result: { sessionId: run.sessionId, host: { finalMessage: run.final, permissionDenials: [], outputHash: 'h' } }, final: true }; break; }
        case 'command': { const seen = Object.entries(s.commands).find(([id]) => id === payload.commandId); result = seen ? { known: true, status: 'accepted', response: { ok: true, result: seen[1].result } } : { known: false }; break; }
        case 'events': {
          const e = events[project.id], after = payload.after ?? 0;
          if (payload.logId && payload.logId !== e.logId) { result = { logId: e.logId, firstSeq: 1, latestSeq: e.list.length, events: [], gap: true, reason: 'log-changed' }; break; }
          const list = e.list.filter(x => x.seq > after).slice(0, 200);
          result = { logId: e.logId, firstSeq: e.list[0]?.seq ?? 0, latestSeq: e.list.length, events: list, gap: e.dropped && after < e.dropped }; break;
        }
        case 'snapshot': result = { events: { logId: events[project.id].logId, latestSeq: events[project.id].list.length }, state: stateOf(project.id), runs: { active: [], recent: [] } }; break;
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
