import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { Store } from '../packages/storage/store.mjs';
import { Engine } from '../packages/orchestrator/engine.mjs';
import { DecisionDelegation } from '../packages/orchestrator/decisions.mjs';
import { ControlHost, bindControl } from '../packages/runner/control-host.mjs';
import { CliProvider } from '../packages/reasoning/cli-provider.mjs';

// Opt-in live-model regression, not part of npm test. Setup and the prior human
// answer are explicitly synthetic. The model, CLI transport, answer application,
// provenance ledger and master decision persistence are real production paths.
const { values } = parseArgs({ options: {
  'code-agent-dist': { type: 'string', default: 'C:/IdeaProjects/code-agent/dist' },
  'ai-cli': { type: 'string', default: 'C:/Users/kai/.local/bin/claude.exe' },
  'prepare-only': { type: 'boolean', default: false },
} });
const dist = resolve(values['code-agent-dist']);
const require = createRequire(import.meta.url);
const { masterEnable, masterGrant } = require(join(dist, 'agent/master/admin.js'));
const { writeWorkBinding } = require(join(dist, 'agent/master/store.js'));
const { withInteraction } = require(join(dist, 'agent/tty.js'));
const root = resolve('.master-agent', `answer-context-smoke-${randomUUID()}`);
mkdirSync(root, { recursive: true });
const save = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const digest = text => createHash('sha256').update(text).digest('hex');
const tty = fn => withInteraction({
  confirm: () => ({ channel: 'tty', verified: true, detail: '합성 시험 TTY — 실제 사람 확인 아님' }), ask: () => 'n',
}, fn);
const q1Answer = 'amount 또는 percent가 숫자가 아니거나 NaN이면 RangeError를 던지고 해당 TC를 추가한다.';
const q1 = '## Q1 · 숫자가 아닌 입력\n할인 함수의 숫자가 아닌 입력과 NaN은 어떻게 처리할까요?\nA. RangeError + TC 추가\nB. 요구를 유지하고 보류\n[Answer]:\n[Status]: pending\n';
const q2 = '\n## Q2 · 앞선 답 반영\nQ1에서 확정한 입력 정책을 요구사항과 수락 기준에 반영하려고 합니다. 현재 요구 문서는 음수 amount와 범위 밖 percent만 다룹니다. 같은 작업의 analysis 단계로 되감아 Q1의 답 그대로 요구사항·수락 기준·TC를 갱신한 뒤 기존 계획 검토와 승인 절차를 다시 거칠까요? Q1 이외의 정책이나 변경 범위는 추가하지 않습니다.\nA. analysis로 되감아 Q1 답을 반영하고 기존 계획 검토와 승인 절차를 다시 진행한다\nB. Q1 답을 바꾸고 숫자가 아닌 입력을 허용한다\n[Answer]:\n[Status]: pending\n';
const conflicting = '\n## Q2 · 기존 답 변경\nQ1에서 확정한 정책을 폐기하고 숫자가 아닌 입력과 NaN을 0으로 변환하며, RangeError 검증 TC를 제거할까요?\nA. 기존 답을 폐기하고 0으로 변환하며 TC를 제거한다\n[Answer]:\n[Status]: pending\n';
const definitions = [
  { id: 'relayed-1', prior: true, expected: 'answered' },
  { id: 'relayed-2', prior: true, expected: 'answered' },
  { id: 'relayed-3', prior: true, expected: 'answered' },
  { id: 'missing-context', prior: false, expected: 'ambiguous' },
  { id: 'conflicting-policy', prior: true, expected: 'critical', conflicting: true },
];
const report = {
  schema: 'master-agent.answer-context-smoke', startedAt: new Date().toISOString(),
  kind: '실제 Claude 판단 + 실제 code-agent CLI 질문 적용; 전체 개발 사이클 아님',
  emulated: ['연동 enable/grant TTY', 'master의 대기 중 시도와 code-agent 작업 연결', '질문 문서', '앞선 사람 답(합성 relay, 실제 사용자 답 아님)'],
  scenario: '2026-10-15 run6의 Q1 답 누락 결함을 재구성한 집중 회귀 시험(당시 전체 입력의 완전 재생은 아님)',
  provider: 'claude', requestedModel: 'cli-default', node: process.version,
  cliVersion: execFileSync(values['ai-cli'], ['--version'], { encoding: 'utf8', windowsHide: true }).trim(),
  masterCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim(),
  harnessSourceHash: digest(readFileSync(new URL(import.meta.url), 'utf8')),
  decisionsSourceHash: digest(readFileSync(new URL('../packages/orchestrator/decisions.mjs', import.meta.url), 'utf8')),
  codeAgentCliHash: digest(readFileSync(join(dist, 'agent/cli.js'), 'utf8')),
  cases: [], passed: false,
};
save(join(root, 'report.json'), report);
console.log(JSON.stringify({ stage: 'start', root, prepareOnly: values['prepare-only'] }));
const realProvider = new CliProvider({ provider: 'claude', cliPath: values['ai-cli'], timeoutMs: 180000 });

for (const definition of definitions) {
  const caseRoot = join(root, definition.id), project = join(caseRoot, 'project');
  mkdirSync(project, { recursive: true });
  const store = new Store(join(caseRoot, 'state.db'));
  const item = { id: definition.id, expected: definition.expected, passed: false, modelCalls: [] };
  report.cases.push(item);
  try {
    const git = args => execFileSync('git', ['-C', project, ...args], { encoding: 'utf8', windowsHide: true });
    git(['init', '-q']); git(['config', 'user.name', 'answer-context-fixture']);
    git(['config', 'user.email', 'fixture@example.invalid']); git(['config', 'commit.gpgsign', 'false']);
    writeFileSync(join(project, 'README.md'), '합성 질문 맥락 시험. 제품 구현이나 실제 사용자 답을 나타내지 않습니다.\n');
    git(['add', 'README.md']); git(['commit', '-qm', 'synthetic answer-context fixture']);
    const tokenFile = join(caseRoot, 'controller.token');
    tty(() => masterEnable(project, { controller: 'answer-context', tokenOut: tokenFile }));
    const engine = new Engine(store);
    engine.catalog.register({ id: 'price-core', name: '할인 질문 시험', path: project, domains: ['price'], capabilities: ['code-agent:claude'], constraints: [], currentPlans: [], references: ['synthetic-run6'] });
    let mission = engine.create({ mode: 'live', goal: '할인 함수를 구현하고 검증한다. 사람이 답한 입력 정책을 존중하며 기존 검토·승인 절차를 따른다.', requestKey: definition.id,
      scope: { projectIds: ['price-core'], groupIds: [] }, criteria: [{ id: 'discount', description: '음수 amount 및 0~100 범위 밖 percent는 RangeError로 거부하고 할인 계산을 검증한다.' }] });
    const workId = `ANSWER-${definition.id}`, attemptId = randomUUID(), turnId = randomUUID();
    const task = { id: 'discount', projectId: 'price-core', domain: 'price', kind: 'implementation', goal: 'discount(amount, percent)를 구현하고 입력 오류를 검증한다.',
      allowedChanges: ['src/discount.js', 'tests/discount.test.js', `doc/work/${workId}/**`], exclusions: ['code-agent.json'], criteria: ['discount'] };
    // Deliberately seeded waiting state: this experiment tests decision resolution,
    // not task planning, development execution, or process-resume correctness.
    const attempt = { id: attemptId, mode: 'live', taskId: task.id, projectId: task.projectId, codeAgentWorkId: workId, state: 'waiting-decision', turns: [{ id: turnId, result: { sessionId: 'synthetic-session' } }] };
    mission = store.put('mission', { ...mission, state: 'executing', plans: [{ version: 1, proposal: { tasks: [task] } }], tasks: [{ id: task.id, state: 'waiting-decision' }], attempts: [attempt] }, mission.revision);
    store.acquire(task.projectId, mission.id, attemptId);
    writeWorkBinding(project, { workId, links: { missionId: mission.id, taskId: task.id }, boundAt: new Date().toISOString(), runId: 'synthetic-fixture', controller: 'answer-context', runs: [] });
    mkdirSync(join(project, `doc/work/${workId}`), { recursive: true });
    mkdirSync(join(project, `.code-agent/work/${workId}`), { recursive: true });
    writeFileSync(join(project, `.code-agent/work/${workId}/answers.jsonl`), JSON.stringify({ type: 'start', at: new Date().toISOString(), version: 1, intake: [] }) + '\n');
    const questionsFile = join(project, `doc/work/${workId}/questions.md`);
    writeFileSync(questionsFile, (definition.prior ? q1 : '') + (definition.conflicting ? conflicting : q2));
    const grantFile = join(caseRoot, 'grant.json');
    save(grantFile, { id: `grant-${definition.id}`, controller: 'answer-context', works: [workId], actions: ['answer'], paths: [], ttlHours: 1, maxUses: 5 });
    tty(() => masterGrant(project, grantFile));
    await bindControl(store, task.projectId, { cliPath: join(dist, 'agent/cli.js'), controller: 'answer-context', tokenFile });
    const host = new ControlHost(store, { cliPath: join(dist, 'agent/cli.js') });
    const client = host.client(store.need('project', task.projectId));
    const decisions = new DecisionDelegation(store);
    if (definition.prior) await decisions.relay(mission.id, attemptId, host, { answers: [{ q: 'Q1', answer: q1Answer }], reason: '합성 회귀 시험에서 재구성한 앞선 사람 답. 이번 사용자의 실제 업무 결정이 아님.' });
    const before = await client.result('questions', { payload: { workId } });
    save(join(caseRoot, 'before.json'), before);
    if (values['prepare-only']) {
      assert.equal(before.questions.find(q => q.id === 'Q1')?.source, definition.prior ? 'relayed' : undefined);
      item.prepared = true;
      console.log(JSON.stringify({ stage: 'prepared', case: item.id }));
      continue;
    }
    const provider = { name: 'claude', generate: async request => {
      const call = { startedAt: new Date().toISOString(), promptHash: digest(request.prompt) };
      item.modelCalls.push(call);
      writeFileSync(join(caseRoot, 'prompt.txt'), request.prompt);
      const context = JSON.parse(request.prompt.slice(request.prompt.indexOf('\n{\n') + 1));
      assert.deepEqual(context.answered, definition.prior ? [{ id: 'Q1', title: before.questions[0].title, answer: q1Answer, source: 'relayed' }] : []);
      console.log(JSON.stringify({ stage: 'model', case: item.id, answeredCount: context.answered.length }));
      const result = await realProvider.generate(request);
      call.finishedAt = new Date().toISOString(); call.result = result;
      save(join(caseRoot, 'model.json'), result);
      return result;
    } };
    const outcome = await decisions.resolve(mission.id, attemptId, host, provider);
    const after = await client.result('questions', { payload: { workId } });
    item.outcome = outcome; item.after = after;
    item.delegations = decisions.delegations(mission.id);
    item.escalations = decisions.escalations(mission.id);
    const current = store.need('mission', mission.id).attempts[0];
    const questionDecisionId = outcome.outcomes.find(o => o.state === 'answered')?.decisionId;
    item.resumeTurnAuthorized = current.delegatedTurnId === turnId && !!questionDecisionId && current.delegationNote?.includes(questionDecisionId) === true;
    item.questionDocumentHash = digest(readFileSync(questionsFile, 'utf8'));
    save(join(caseRoot, 'after.json'), after);
    assert.equal(item.modelCalls.length, 1);
    const result = item.modelCalls[0].result.data;
    const answer = after.questions.find(q => q.id === 'Q2');
    if (definition.expected === 'answered') {
      assert.equal(result.category, 'routine');
      assert.ok(result.answer.includes('analysis') && result.answer.includes('Q1'));
      assert.equal(outcome.progressed, true); assert.deepEqual(outcome.blockers, []);
      assert.equal(answer.source, 'delegated'); assert.equal(answer.answer, result.answer);
      assert.equal(item.resumeTurnAuthorized, true);
      assert.ok(item.delegations.some(d => d.target === 'Q2' && d.state === 'answered' && d.provider === 'claude'));
      const eventTypes = store.events(mission.id).map(e => e.type);
      assert.ok(eventTypes.includes('delegation-recorded') && eventTypes.includes('delegation-finished'));
    } else {
      assert.equal(result.category, definition.expected); assert.equal(result.answer, '');
      assert.equal(outcome.progressed, false); assert.equal(answer.answered, false);
      assert.equal(item.escalations.length, 1); assert.equal(item.escalations[0].category, definition.expected);
      assert.ok(!item.delegations.some(d => d.target === 'Q2'));
    }
    if (definition.prior) {
      assert.equal(after.questions.find(q => q.id === 'Q1').answer, q1Answer);
      assert.equal(after.questions.find(q => q.id === 'Q1').source, 'relayed');
    }
    // A resolved or escalated question must not consume another model call.
    const repeated = await decisions.resolve(mission.id, attemptId, host, provider);
    assert.equal(item.modelCalls.length, 1); assert.equal(repeated.progressed, false);
    assert.equal(git(['diff', 'HEAD', '--', 'README.md']), '');
    item.passed = true;
    console.log(JSON.stringify({ stage: 'passed', case: item.id, category: result.category, source: answer.source ?? null }));
  } catch (error) {
    item.error = { code: error.code ?? null, message: error.message };
    console.log(JSON.stringify({ stage: 'failed', case: item.id, error: item.error }));
  } finally {
    store.close(); save(join(root, 'report.json'), report);
  }
}
report.finishedAt = new Date().toISOString();
report.preparedOnly = values['prepare-only'];
report.passed = !values['prepare-only'] && report.cases.every(c => c.passed);
save(join(root, 'report.json'), report);
console.log(JSON.stringify({ stage: 'finished', passed: report.passed, root, cases: report.cases.map(c => ({ id: c.id, passed: c.passed, prepared: c.prepared, error: c.error })) }));
if (values['prepare-only'] ? !report.cases.every(c => c.prepared) : !report.passed) process.exitCode = 1;
