import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { temporary, cleanup } from './helpers.mjs';
import { answerFor } from './planning-fixture.mjs';
import { Store } from '../packages/storage/store.mjs';
import { Engine } from '../packages/orchestrator/engine.mjs';
import { Knowledge } from '../packages/knowledge/sources.mjs';
import { Planner } from '../packages/reasoning/planner.mjs';
import { KnowledgeRetrieval, bindingOf, leaseHolder, setBinding } from '../packages/knowledge/retrieval.mjs';
import { callKnowledge, knowledgeConnection } from '../packages/knowledge/agent-knowledge.mjs';
import { BUNDLE_KIND, deliveryBlock } from '../packages/knowledge/evidence.mjs';
import { gateVerification, knowledgeDigest } from '../packages/knowledge/handoff.mjs';
import { settleLeases } from '../packages/knowledge/lease.mjs';
import { LiveExecution } from '../packages/orchestrator/live.mjs';
import { ControlHost, bindControl } from '../packages/runner/control-host.mjs';
import { ControlClient } from '../packages/code-agent-adapter/control.mjs';
import { childEnv } from '../packages/runner/process.mjs';

/**
 * 세 프로젝트 실제 연동 시험 — master-agent(호스트)가 실제 agent-knowledge CLI(생산자: 형식 2 검색·세대 임대)로 계획 근거를 봉인하고,
 * 실제 code-agent CLI(수신자: hello 공지·submit 접수·작업 고정·진행 게이트)에 인계한다. 모두 빌드 산출물(dist)을 쓴다.
 * - 개발 호스트는 code-agent 의 가짜 호스트(masterFakeHost.js)뿐이다. 실제 claude·codex·모델·네트워크를 부르지 않는다:
 *   host.json 이 가짜 호스트를 가리키고 CODE_AGENT_CLAUDE_BIN·CODE_AGENT_CODEX_BIN 도 가짜 호스트로 덮는다.
 * - 사용자 ~/.code-agent·~/.codex 를 건드리지 않는다: CODE_AGENT_HOME·CODEX_HOME 을 시험 임시 폴더로 바꾼 뒤에만 code-agent 를 부른다.
 * - master 쪽 생산자 호출은 실제 CLI 앞의 기록용 대역(spy.mjs)을 거친다 — 인자만 남기고 그대로 실제 CLI 에 넘긴다(배정 때 생산자를 불렀는지 확인용).
 * - 사람의 TTY 확인(문서 확정·요구 확정·연동 켜기·플러그인 등록)은 code-agent 시험과 같은 방식(in-process 기록 함수·withInteraction)으로 흉내 낸다.
 * CODE_AGENT_DIST(기본 ../code-agent/dist)·AGENT_KNOWLEDGE_DIST(기본 ../agent-knowledge/dist)가 없으면 건너뛴다.
 */
const here = dirname(fileURLToPath(import.meta.url));
const slash = path => path.replace(/\\/g, '/');
const CA_DIST = resolve(process.env.CODE_AGENT_DIST ?? join(here, '../../code-agent/dist'));
const CA_CLI = join(CA_DIST, 'agent/cli.js'), FAKE = join(CA_DIST, 'test/masterFakeHost.js');
const AK_CLI = join(resolve(process.env.AGENT_KNOWLEDGE_DIST ?? join(here, '../../agent-knowledge/dist')), 'src/cli/main.js');
const AK_RETRIEVAL = resolve(dirname(AK_CLI), '..', '..', '..', 'config', 'retrieval.yaml');
const NODE = slash(process.execPath);
const missing = [[CA_CLI, 'code-agent dist'], [FAKE, 'code-agent 가짜 호스트'], [join(CA_DIST, 'agent/knowledgeGate.js'), 'code-agent 지식 진행 게이트 빌드'],
  [AK_CLI, 'agent-knowledge dist'], [AK_RETRIEVAL, 'agent-knowledge config/retrieval.yaml']].filter(([path]) => !existsSync(path)).map(([, name]) => name);
const skip = missing.length ? `실제 산출물 없음: ${missing.join(', ')}` : false;
const requireDist = createRequire(import.meta.url);
const ca = rel => requireDist(join(CA_DIST, rel));

const PRESENCE = { channel: 'tty', verified: true, detail: '모의 TTY(시험)' };
const POLICY = { heartbeatMs: 200, progressMs: 300, startTimeoutMs: 30000, stopGraceMs: 5000, masterTimeoutMs: 600000 };
const ACTIVE_RUN = ['accepted', 'starting', 'running', 'stopping', 'orphaned'];
const GIT = ['-c', 'core.autocrlf=false', '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false'];
// 호스트 세션 표지·사용자 연결 설정은 시험 동안 지운다 — code-agent 는 in-process 로도 불리므로 자식 env 만 고치면 모자란다
const HOST_MARKERS = /^(CLAUDE|CODEX_|CODE_AGENT_|AGENT_KNOWLEDGE_|MASTER_AGENT_KNOWLEDGE_|AI_AGENT$)/;

const RULES = ['# 주문 업무 규칙', '', '## BR-001 주문 취소', '', '- 상태: 확정', '결제 완료 후 24시간 이내에만 주문 취소를 허용한다.', '취소하면 사용한 포인트를 되돌린다.', '',
  '## BR-002 주문 환불', '', '- 상태: 확정', '주문 환불은 원래 결제 수단으로만 한다.', ''].join('\n');
const BILLING = ['# 정산 업무 규칙', '', '## BL-001 정산 되돌림', '', '- 상태: 확정', '주문 취소와 주문 환불이 확정되면 정산을 되돌린다.', ''].join('\n');
// 색인에는 있지만 code-agent 등록 문서(code-agent.json docs)가 아닌 문서 — 수신 범위(registered-docs) 밖 근거
const NOTES = ['# 작업 메모', '', '## 주문 취소 메모', '', '주문 취소 문의는 고객센터로 넘긴다.', ''].join('\n');
const DOCS = { orders: 'docs/rules.md', billing: 'docs/billing.md' };
const GOAL = '주문 취소 가능 기간과 주문 환불 수단을 확인하고 정산 되돌림을 맞춘다';
const CRITERION = '주문 취소와 주문 환불 규칙에 맞춰 정산 되돌림을 확인한다';

function git(repo, ...args) {
  const r = spawnSync('git', ['-C', repo, ...GIT, ...args], { encoding: 'utf8', windowsHide: true });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}
function write(root, files) {
  for (const [path, text] of Object.entries(files)) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text); }
}
const sleepSync = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const alive = pid => { if (!Number.isInteger(pid) || pid <= 0) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
async function waitFor(what, fn, ms = 60000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > end) throw new Error(`기다림 초과: ${what}`);
    await delay(150);
  }
}
const runsDir = repo => join(repo, '.code-agent', 'master', 'runs');
const runFiles = repo => existsSync(runsDir(repo)) ? readdirSync(runsDir(repo)).filter(name => /^run-[^.]+\.json$/.test(name)).sort() : [];
const readRun = (repo, runId) => JSON.parse(readFileSync(join(runsDir(repo), `${runId}.json`), 'utf8'));
const knowledgeLog = repo => {
  const file = join(repo, '.code-agent', 'log', 'knowledge', 'context.jsonl');
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
};

/** 시험 동안 호스트 표지를 지우고 code-agent 키 저장소·Codex 설정을 임시 폴더로 돌린다. 끝나면 되돌린다 */
function isolateEnv(t, root) {
  const saved = Object.fromEntries(Object.entries(process.env).filter(([key]) => HOST_MARKERS.test(key)));
  for (const key of Object.keys(saved)) delete process.env[key];
  Object.assign(process.env, { CODE_AGENT_HOME: join(root, 'home'), CODEX_HOME: join(root, 'codex'), CODE_AGENT_CLAUDE_BIN: FAKE, CODE_AGENT_CODEX_BIN: FAKE });
  cleanup(t, () => {
    for (const key of Object.keys(process.env)) if (HOST_MARKERS.test(key)) delete process.env[key];
    Object.assign(process.env, saved);
  });
}

/** 끝나지 않은 실행은 강제 취소하고, 감독·가짜 호스트 프로세스가 끝날 때까지 기다린다(임시 폴더를 지우기 전 — 동기) */
function settleRuns(repo, tokenFile) {
  const runs = () => runFiles(repo).map(name => { try { return JSON.parse(readFileSync(join(runsDir(repo), name), 'utf8')); } catch { return null; } }).filter(Boolean);
  for (const run of runs().filter(r => ACTIVE_RUN.includes(r.state))) {
    spawnSync(process.execPath, [CA_CLI, 'master', 'call'], { cwd: repo, env: childEnv(), windowsHide: true, timeout: 30000,
      input: JSON.stringify({ protocol: 'code-agent.master', version: 1, type: 'cancel', controller: 'm1', generation: 1, token: readFileSync(tokenFile, 'utf8').trim(),
        commandId: `cleanup-${run.runId}`, payload: { runId: run.runId, force: true, waitMs: 5000 } }) });
  }
  const end = Date.now() + 20000;
  while (Date.now() < end && runs().some(r => ACTIVE_RUN.includes(r.state) || alive(r.supervisor?.pid) || alive(r.host?.pid))) sleepSync(200);
}

/** code-agent 프로젝트 하나 — code-agent 시험 고정 문서(POLICY 4종)와 업무 규칙 문서. 업무 규칙 문서는 agent-knowledge 원본이기도 하다 */
function codeAgentRepo(repo, { rulesPath, rules, plugin, extra = {} }) {
  write(repo, {
    [rulesPath]: rules, ...extra,
    'doc/architecture.md': ['# 아키텍처', '## 기술 스택', 'Node.js', '## 모듈/패키지 구조', 'src/main/app/<파일>.js', '## 계층과 책임', '- app: 애플리케이션 코드',
      '## 의존 방향', 'test → app', '## 공통 모듈', '없음', '## 주요 결정', '- 식별자: 문자열', '## 저장소', '주문 데이터는 PostgreSQL 에 저장한다.'].join('\n'),
    'doc/conventions.md': ['# 코드 컨벤션', '## 명명', '- 파일은 소문자', '## 계층별 규칙', '- app 은 순수 함수로', '## 예외 처리', '- Error 를 던진다', '## 테스트 규칙', '- 테스트 이름·주석에 TC id 를 남긴다'].join('\n'),
    'doc/test-strategy.md': ['# 테스트 전략', '## 수준과 범위', '- Unit: 필수', '## 도구와 실행 명령', '- `test`: 전체 테스트', '## 통과 기준', '- AC 마다 1케이스'].join('\n'),
    'doc/quality.md': ['# 품질·보안 기준', '## 정적 분석', '- `build`: 컴파일', '## 보안 검사', '- 없음 — 리뷰에서 본다', '## 통과 기준과 반영 차단', '- 컴파일 실패는 반영을 막는다'].join('\n'),
    'src/main/app/order.js': '// 주문 취소\nmodule.exports = {};\n', 'src/test/existing.test.js': '// 기존 테스트\n', '01-code.md': '코드 단계 규칙', '02-test.md': '테스트 단계 규칙',
    'code-agent.json': JSON.stringify({ language: 'javascript', sourceExtensions: ['.js'], domainBase: 'src/main', domainRoots: ['app'], conventions: ['doc/conventions.md'],
      docs: { architecture: 'doc/architecture.md', knowledge: { businessRules: rulesPath } }, build: ['node', '-e', 'process.exit(0)'], test: ['node', '-e', "console.log('ok 1 - TC-1')"],
      stages: [{ key: 'code', title: '코드', template: '01-code.md', scope: 'project', outputDirs: ['src/main'] }, { key: 'test', title: '테스트', template: '02-test.md', kind: 'test', scope: 'project', outputDirs: ['src/test'] }],
      // 지식 검색 자리를 선언하지 않은 프로젝트는 hello 에서 인계 참조를 받지 않는다고(refs.accepted false) 알린다
      ...(plugin ? { plugins: { 'agent-knowledge': { slots: ['context.docs'] } } } : {}) }, null, 2),
  });
  git(repo, 'init', '-q', '-b', 'master');
  ca('agent/init.js').init(slash(repo), { host: 'claude' });
  const { checkProjectDocs, recordDocConfirmation } = ca('agent/docs.js'), { loadManifestIfAny } = ca('agent/work.js');
  for (const entry of checkProjectDocs(slash(repo), loadManifestIfAny(slash(repo)))) recordDocConfirmation(slash(repo), entry, 'test', PRESENCE);
  git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'fixture');
}

/** 계획 AI 대역 — 작업마다 자기 프로젝트 업무 규칙 문서의 검색 항목을 근거로 고르고 첫 항목만 필수 의존으로 둔다 */
function provider({ goalPrefix = '', docs = DOCS } = {}) {
  return { name: 'fixture', model: 'fixture', async generate(args) {
    const data = answerFor(args.context), items = args.context.knowledge?.items ?? [];
    data.plan.tasks = data.plan.tasks.map(task => {
      const live = { ...task, requiredCapabilities: ['code-agent:claude'], allowedChanges: ['src/main'], exclusions: ['docs'],
        goal: task.kind === 'implementation' ? `${goalPrefix}${task.goal}` : task.goal };
      if (!args.context.knowledge) return live;
      const refs = task.kind !== 'implementation' ? [] : items.filter(i => i.forProject === task.projectId && i.scopeRole === 'project' && i.path === docs[task.projectId] &&
        !['changed', 'missing'].includes(i.sourceState)).map(i => i.ref).slice(0, 2);
      return { ...live, knowledgeRefs: refs, knowledgeRequired: refs.slice(0, 1) };
    });
    if (args.context.knowledge) data.decisions = data.decisions.map(d => ({ ...d, knowledgeRefs: [] }));
    return { data };
  } };
}

/** 실제 통신 계약 호스트에 요청 기록만 더한다(전송은 실제 code-agent CLI 그대로) */
class RecordingHost extends ControlHost {
  sent = [];
  client(project) {
    const client = super.client(project), request = client.request.bind(client), sent = this.sent;
    client.request = (type, options = {}) => { sent.push({ projectId: project.id, type, options: structuredClone(options) }); return request(type, options); };
    return client;
  }
}

async function world(t) {
  const root = temporary(t);
  isolateEnv(t, root);
  const outside = join(root, 'outside'), ak = join(root, 'ak');
  for (const dir of [outside, ak, join(root, 'home'), join(root, 'codex')]) mkdirSync(dir, { recursive: true });
  const repos = { orders: join(root, 'orders'), billing: join(root, 'billing') };
  codeAgentRepo(repos.orders, { rulesPath: DOCS.orders, rules: RULES, plugin: true, extra: { 'docs/notes.md': NOTES } });
  codeAgentRepo(repos.billing, { rulesPath: DOCS.billing, rules: BILLING, plugin: false });

  // agent-knowledge 색인(실제 CLI, 임시 DB) — 원본은 두 code-agent 저장소의 docs/
  const db = join(ak, 'knowledge.sqlite'), sources = join(ak, 'sources.yaml');
  writeFileSync(sources, JSON.stringify({ schemaVersion: 1, database: { path: db }, sources: [
    { id: 'kb', project: 'orders', path: repos.orders, ref: 'HEAD', include: ['docs/**/*.md'], defaultKind: 'reference', rules: [{ match: DOCS.orders, kind: 'business-rule' }] },
    { id: 'kb2', project: 'billing', path: repos.billing, ref: 'HEAD', include: ['docs/**/*.md'], defaultKind: 'reference', rules: [{ match: DOCS.billing, kind: 'business-rule' }] }] }));
  const indexed = spawnSync(process.execPath, [AK_CLI, 'index', '--config', sources, '--db', db, '--quiet'], { encoding: 'utf8', windowsHide: true, env: process.env });
  assert.equal(indexed.status, 0, indexed.stdout + indexed.stderr);

  // code-agent 쪽 지식 검색 어댑터 — orders 저장소만 생산자 프로젝트에 대응시킨다(billing 은 미등록)
  writeFileSync(join(root, 'home', 'agent-knowledge.json'), JSON.stringify({ schemaVersion: 1, command: [NODE, slash(AK_CLI)], sourcesConfig: slash(sources), db: slash(db),
    projects: [{ root: slash(repos.orders), project: 'orders', sources: ['kb'] }] }));
  ca('agent/plugins/commands.js').registerPlugin(slash(repos.orders), { name: 'agent-knowledge', command: `"${NODE}" "${slash(CA_CLI)}" plugin agent-knowledge`, slots: 'context.docs', sendsCode: false },
    { ask: () => { throw new Error('질문이 없어야 합니다'); }, confirm: () => { throw new Error('확인이 없어야 합니다'); } });

  // master 연동 켜기 — 관리 실행 호스트는 가짜 호스트뿐이다
  const hostFile = join(outside, 'host.json'), policyFile = join(outside, 'policy.json');
  writeFileSync(hostFile, JSON.stringify({ command: [NODE, slash(FAKE)] }));
  writeFileSync(policyFile, JSON.stringify(POLICY));
  const { withInteraction } = ca('agent/tty.js'), { masterEnable } = ca('agent/master/admin.js');
  const tokens = {};
  for (const [id, repo] of Object.entries(repos)) {
    tokens[id] = join(outside, `token-${id}`);
    withInteraction({ confirm: () => PRESENCE, ask: () => 'n' }, () => masterEnable(slash(repo), { controller: 'm1', tokenOut: slash(tokens[id]), host: slash(hostFile), policy: slash(policyFile) }));
  }

  // master 저장소 — 생산자 호출은 기록용 대역을 거쳐 실제 CLI 로 간다
  const spyLog = join(ak, 'producer-calls.jsonl'), spy = join(ak, 'spy.mjs');
  writeFileSync(spy, `import { appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(spyLog)}, JSON.stringify(args) + '\\n');
const r = spawnSync(process.execPath, [${JSON.stringify(AK_CLI)}, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024, windowsHide: true });
if (r.stdout) process.stdout.write(r.stdout);
if (r.stderr) process.stderr.write(r.stderr);
process.exitCode = r.status ?? 1;
`);
  const env = { MASTER_AGENT_KNOWLEDGE_CLI: spy, MASTER_AGENT_KNOWLEDGE_CONFIG: sources, MASTER_AGENT_KNOWLEDGE_DB: db, MASTER_AGENT_KNOWLEDGE_RETRIEVAL_CONFIG: AK_RETRIEVAL };
  const store = new Store(join(root, 'state.db'));
  cleanup(t, () => store.close());
  cleanup(t, () => { for (const [id, repo] of Object.entries(repos)) settleRuns(repo, tokens[id]); });
  const engine = new Engine(store), knowledge = new Knowledge(store);
  for (const [id, domain] of [['orders', 'order'], ['billing', 'billing']]) {
    const p = engine.catalog.register({ id, name: id, path: repos[id], domains: [domain], capabilities: ['code-agent:claude'], constraints: [], currentPlans: [], references: ['fixture'] });
    knowledge.collect(id, { schemaVersion: 1, sources: [{ path: DOCS[id], kind: 'policy' }] }, p.revision);
    setBinding(store, id, { mode: 'enabled', knowledgeProject: id });
    await bindControl(store, id, { cliPath: CA_CLI, controller: 'm1', tokenFile: tokens[id] });
  }
  const host = new RecordingHost(store, { cliPath: CA_CLI, pollMs: 200, followTimeoutMs: 120000 });
  const live = new LiveExecution(store, { env });
  const planner = new Planner(store, { retrieval: new KnowledgeRetrieval(store, { env }) });
  const calls = () => existsSync(spyLog) ? readFileSync(spyLog, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  const producerLeases = async holder => (await callKnowledge(knowledgeConnection(env), 'lease', null, { args: ['list', '--holder', holder] })).leases;
  const dispatch = async (missionId, taskId, { wait = true } = {}) => {
    const m = store.need('mission', missionId), task = m.plans.at(-1).proposal.tasks.find(x => x.id === taskId);
    const state = await host.inspect(store.need('project', task.projectId));
    return live.dispatch(missionId, taskId, host, { expectedRevision: m.revision, expectedState: state.stateVersion, wait });
  };
  const create = (key, projectIds) => engine.create({ goal: GOAL, requestKey: key, mode: 'live', scope: { projectIds, groupIds: [] }, criteria: [{ id: 'c1', description: CRITERION }] });
  const cancel = id => { const m = store.need('mission', id); return engine.control(id, 'cancel', m.revision, undefined, { reason: '시험 단계 종료' }); };
  return { root, repos, tokens, db, sources, env, store, engine, host, live, planner, calls, producerLeases, dispatch, create, cancel };
}

const implementation = (plan, projectId) => plan.proposal.tasks.find(x => x.projectId === projectId && x.kind === 'implementation');
const attemptOf = (f, missionId, taskId) => f.store.need('mission', missionId).attempts.find(a => a.taskId === taskId);
const controlRunOf = (f, attempt) => f.store.list('control-run').find(r => r.attemptId === attempt.id && r.invocationId === attempt.invocationId);
/**
 * 봉인 묶음 항목 → 수신 참조(필수 표시는 계획의 knowledgeRequired). 형식 1은 항목·세대·커밋·해시, 형식 2는 생산자 ItemRef 필드 이름 그대로다
 * (code-agent protocol.ts 형식 2 — 값이 없는 선택 필드는 싣지 않는다). handoff.mjs 를 쓰지 않고 시험에서 따로 만든다
 */
const wireOf = (bundle, task, version, refs = task.knowledgeRefs) => {
  const items = new Map(bundle.knowledge.items.map(i => [i.ref, i]));
  return refs.map(ref => {
    const i = items.get(ref), required = task.knowledgeRequired.includes(ref);
    if (version === 1) return { itemId: i.itemId, generation: i.indexGeneration, commit: i.commit, itemSha256: i.itemSha256, required };
    return { indexId: i.indexId, indexGeneration: i.indexGeneration, itemId: i.itemId, itemSha256: i.itemSha256, commit: i.commit, sourceId: i.sourceId, path: i.path, startLine: i.startLine, endLine: i.endLine,
      ...(i.segmentId ? { segmentId: i.segmentId, segmentSha256: i.segmentSha256, segmentStartLine: i.segmentStartLine, segmentEndLine: i.segmentEndLine } : {}),
      handle: i.handle, projectId: i.producerProjectId, documentSha256: i.documentSha256, blobSha: i.blobSha, required };
  });
};
/**
 * 공통 계약 송신 결정: 필수 참조가 있으면 진행 게이트(refs.requiredGate)를 공지하고 지금 형식 2를 받는(refs.versions — 색인 대조 등록) 수신자에게
 * 색인 식별이 있는 묶음으로만 형식 2를 보낸다. 선택 참조만이면 함께 쓰는 가장 높은 형식이다
 */
const expectedVersion = (hello, bundle) => hello.knowledge.refs.versions.includes(2) && bundle.knowledge.retrieval.indexId ? 2 : 1;
/** KNOWLEDGE_INTEGRATION_RECORD 가 있으면 실제 hello·submit knowledge·접수 영수증·실행 기록을 그 파일에 남긴다(보고용 재현 기록, 시험 판정과 무관) */
const keepRecord = entry => { if (process.env.KNOWLEDGE_INTEGRATION_RECORD) writeFileSync(process.env.KNOWLEDGE_INTEGRATION_RECORD, `${JSON.stringify(entry, null, 2)}\n`); };
const generationOf = ref => ref.generation ?? ref.indexGeneration;

test('실제 3개 프로젝트 지식 인계: master-agent 호스트 · agent-knowledge 생산자 · code-agent 수신자', { skip, timeout: 600000 }, async t => {
  const f = await world(t);
  const s = {};

  await t.test('분석: 실제 생산자 형식 2 검색으로 봉인한 계획 묶음이 그 세대를 목표 단위 임대로 붙잡는다', async () => {
    const m = f.create('ki-m1', ['orders', 'billing']);
    const result = await f.planner.analyze(m.id, provider(), { expectedRevision: m.revision });
    assert.equal(result.mission.state, 'planned', JSON.stringify(result.analysis.error ?? result.analysis.knowledge));
    const plan = f.store.need('mission', m.id).plans.at(-1), bundle = f.store.get(BUNDLE_KIND, plan.knowledge.bundleId);
    assert.equal(bundle.knowledge.retrieval.contract, 'agent-knowledge.search@2', '이 생산자 빌드와는 형식 2로 협의한다');
    assert.match(bundle.knowledge.retrieval.indexId, /^[0-9a-f]{32}$/);
    const orders = implementation(plan, 'orders'), billing = implementation(plan, 'billing');
    assert.equal(orders.knowledgeRefs.length, 2, '주문 작업은 필수 1·선택 1 근거를 인용한다');
    assert.deepEqual(orders.knowledgeRequired, orders.knowledgeRefs.slice(0, 1));
    assert.equal(billing.knowledgeRequired.length, 1, '정산 작업도 필수 근거를 인용한다');
    // 생산자 임대 — 보유자 master-agent:<목표>, 계획 세대. 생산자 lease list 와 묶음 기록이 같다
    assert.deepEqual([bundle.lease.state, bundle.lease.holder, bundle.lease.generation, bundle.lease.indexId], ['held', leaseHolder(m.id), bundle.generation, bundle.knowledge.retrieval.indexId]);
    const leases = await f.producerLeases(leaseHolder(m.id));
    assert.deepEqual(leases.map(l => [l.leaseId, l.holder, l.generation, l.expired]), [[bundle.lease.leaseId, leaseHolder(m.id), bundle.generation, false]]);
    Object.assign(s, { m1: m.id, plan1: plan, bundle1: bundle.id, orders, billing });
  });

  await t.test('필수 근거를 받지 않는 code-agent 프로젝트의 작업은 시도·실행 없이 그 작업만 보류된다', async () => {
    const hello = await f.host.knowledgeHello(f.store.need('project', 'billing'));
    // 지식 검색 자리를 선언하지 않은 프로젝트의 실제 공지: 인계 형식은 알지만 참조를 받지 않는다(accepted false)
    assert.deepEqual([hello.knowledge.mode, hello.knowledge.refs.supported, hello.knowledge.refs.accepted], ['off', true, false]);
    const sent = f.host.sent.length;
    let held;
    await assert.rejects(f.dispatch(s.m1, s.billing.id), error => { held = error; return Boolean(error.handoff); });
    // 형식은 맞지만 받지 않는 수신자 — 형식 불일치(knowledge-handoff-version)가 아니라 미수락으로 막는다
    assert.equal(held.code, 'knowledge-handoff-not-accepted');
    assert.deepEqual([held.handoff.status, held.handoff.required, held.handoff.receiver.known, held.handoff.receiver.supported, held.handoff.receiver.accepted], ['held', 1, true, true, false]);
    const mission = f.store.need('mission', s.m1);
    assert.ok(!mission.attempts.some(a => a.taskId === s.billing.id), '시도를 만들지 않는다');
    assert.equal(mission.tasks.find(x => x.id === s.billing.id).state, 'queued');
    assert.deepEqual(runFiles(f.repos.billing), [], 'code-agent 실행을 만들지 않는다');
    assert.ok(!f.host.sent.slice(sent).some(x => x.type === 'submit'), 'submit 을 보내지 않는다');
    const event = f.store.events(s.m1).find(e => e.type === 'knowledge-handoff-held' && e.taskId === s.billing.id);
    assert.deepEqual([event.code, event.projectId, event.required], [held.code, 'billing', 1]);
  });

  await t.test('정상 인계: 같은 목표의 다른 작업은 계속 배정되고 실제 접수·저장·영수증이 보낸 인계와 같다. 재전송은 같은 실행, 다른 내용은 충돌', async () => {
    const hello = await f.host.knowledgeHello(f.store.need('project', 'orders'));
    assert.deepEqual([hello.knowledge.mode, hello.knowledge.refs.accepted, typeof hello.knowledge.gate?.resume], ['enabled', true, 'string']);
    const sent = f.host.sent.length, calls = f.calls().length, events = f.store.events(s.m1).length;
    await f.dispatch(s.m1, s.orders.id);
    const attempt = attemptOf(f, s.m1, s.orders.id), handoff = attempt.knowledgeHandoff, bundle = f.store.get(BUNDLE_KIND, s.bundle1);
    const version = expectedVersion(hello, bundle);
    // 이 작업에는 필수 근거가 있다 — 실제 수신자가 진행 게이트와 형식 2를 공지하므로 형식 2로 간다(형식 1로 내려 보내지 않는다)
    assert.deepEqual([hello.knowledge.refs.requiredGate, version], [true, 2]);
    // 실제 hello 공지 그대로 — 지금 받는 형식 중 가장 높은 것으로 보내고, 진행 게이트·회복 명령 공지를 기록한다
    assert.deepEqual([handoff.status, handoff.version, handoff.receiver.accepted, handoff.receiver.versions, handoff.receiver.gate, handoff.receiver.commands],
      ['prepared', version, true, hello.knowledge.refs.versions, true, hello.knowledge.gate.command.actions]);
    // 계획의 필수·선택 근거가 봉인 묶음 항목 그대로(항목·세대·커밋·해시, 형식 2는 색인 ID·출처·줄 범위까지) 실린다. 세대는 계획 세대다
    assert.deepEqual(handoff.payload, { version, refs: wireOf(bundle, s.orders, version) });
    assert.ok(handoff.payload.refs.every(r => generationOf(r) === bundle.generation));
    assert.deepEqual([handoff.sent, handoff.sentRequired, handoff.omitted], [2, 1, []]);
    // 생산자가 지금 돌려주는 항목 출처와도 같다(실제 get)
    for (const ref of handoff.payload.refs) {
      const got = await callKnowledge(knowledgeConnection(f.env), 'get', { id: ref.itemId, profile: 'code', scope: { projects: ['orders'] } });
      assert.deepEqual([got.item.provenance.generation, got.item.provenance.commit, got.item.provenance.itemSha256], [generationOf(ref), ref.commit, ref.itemSha256]);
    }
    // 실제로 보낸 submit — 시도에 고정한 payload 그대로, 프롬프트에는 싣지 않는다
    const submit = f.host.sent.slice(sent).find(x => x.type === 'submit' && x.projectId === 'orders');
    assert.equal(submit.options.commandId, `inv-${attempt.invocationId}`);
    assert.deepEqual(submit.options.payload.knowledge, handoff.payload);
    assert.ok(!/kitem:|knowledgeRefs|knowledgeRequired/.test(submit.options.payload.prompt));
    // code-agent 가 저장한 실행 기록의 knowledge 가 같다
    const record = controlRunOf(f, attempt), runId = record.id;
    assert.deepEqual(readRun(f.repos.orders, runId).knowledge, handoff.payload);
    // 접수 영수증 — 수신자 정본 해시가 master 해시와 같다(접수는 저장일 뿐 검증이 아니다)
    assert.equal(handoff.digest, knowledgeDigest(handoff.payload));
    assert.deepEqual([record.knowledge.state, record.knowledge.digestMatched, record.knowledge.receiverDigest, record.knowledge.acceptedRefs, record.knowledge.receipt, record.knowledge.receiverVersion],
      ['accepted', true, knowledgeDigest(handoff.payload), 2, 'stored', version]);
    // 가짜 호스트(MODE=complete)는 작업을 열지 않는다 — 작업 고정 확인은 unbound, 게이트 판정은 작업이 없어 보고 없음(막지 않음)
    assert.deepEqual([handoff.delivery.state, handoff.delivery.runId, handoff.delivery.stored, handoff.delivery.verification.state], ['accepted', runId, 'unbound', 'not-reported']);
    assert.equal(deliveryBlock(handoff), null);
    const types = f.store.events(s.m1).slice(events).map(e => e.type);
    for (const type of ['knowledge-handoff-sent', 'knowledge-handoff-accepted', 'knowledge-handoff-checked', 'knowledge-handoff-recorded']) assert.ok(types.includes(type), type);
    const decision = f.store.list('decision', { missionId: s.m1 }).find(d => d.action === 'dispatch-live' && d.codeAgentWorkId === attempt.codeAgentWorkId);
    assert.deepEqual([decision.knowledge.status, decision.knowledge.sent, decision.knowledge.sentRequired, decision.knowledge.hash], ['prepared', 2, 1, handoff.hash]);
    // enabled 프로젝트의 배정은 계획 세대 임대를 연장한다(실제 생산자 lease renew)
    assert.ok(f.calls().slice(calls).some(args => args[0] === 'lease' && args[1] === 'renew' && args.includes(bundle.lease.leaseId)));
    keepRecord({ hello: hello.knowledge, submit: { commandId: submit.options.commandId, mode: submit.options.payload.mode, knowledge: submit.options.payload.knowledge },
      stored: readRun(f.repos.orders, runId).knowledge, controlRun: record.knowledge, delivery: handoff.delivery, lease: bundle.lease });

    // 같은 commandId·같은 봉투 재전송 → 기록된 응답(같은 실행·같은 정본 해시). 다른 내용 → conflict, 실행을 새로 만들지 않는다
    const binding = f.store.need('control-binding', 'orders');
    const client = new ControlClient({ cliPath: CA_CLI, projectPath: f.repos.orders, controller: binding.controller, tokenFile: binding.tokenFile, generation: binding.generation });
    const files = runFiles(f.repos.orders);
    const replay = await client.request('submit', submit.options);
    assert.deepEqual([replay.replayed, replay.result.runId, replay.result.knowledge.digest, replay.result.knowledge.refs], [true, runId, knowledgeDigest(handoff.payload), 2]);
    const changed = { ...submit.options, payload: { ...submit.options.payload, knowledge: { ...handoff.payload, refs: handoff.payload.refs.map((r, n) => n === 1 ? { ...r, required: !r.required } : r) } } };
    await assert.rejects(client.request('submit', changed), error => error.controlCode === 'conflict');
    assert.deepEqual(runFiles(f.repos.orders), files, '두 번째 실행 기록이 없다');
    s.run1 = runId;
  });

  await t.test('수명: 목표가 끝나면 묶음 임대가 release-pending 이 되고 settleLeases 가 실제 생산자에서 놓는다', async () => {
    f.cancel(s.m1);
    let bundle = f.store.get(BUNDLE_KIND, s.bundle1);
    assert.deepEqual([bundle.state, bundle.lease.state, bundle.lease.releaseReason], ['released', 'release-pending', 'mission-finished']);
    assert.equal((await f.producerLeases(leaseHolder(s.m1))).length, 1, '정리 전에는 생산자에 남아 있다');
    assert.deepEqual(await settleLeases(f.store, { missionId: s.m1, env: f.env }), [{ bundleId: s.bundle1, state: 'released' }]);
    bundle = f.store.get(BUNDLE_KIND, s.bundle1);
    assert.equal(bundle.lease.state, 'released');
    assert.deepEqual(await f.producerLeases(leaseHolder(s.m1)), []);
    assert.ok(f.store.events(s.m1).some(e => e.type === 'knowledge-lease-released' && e.bundleId === s.bundle1 && e.reason === 'mission-finished'));
    assert.deepEqual(await settleLeases(f.store, { missionId: s.m1, env: f.env }), [], '다시 놓지 않는다');
  });

  await t.test('호환: 지식 참조가 없는 작업은 hello·생산자 없이 knowledge 키 없는 submit 으로 접수된다', async () => {
    let m = f.create('ki-m2', ['orders']);
    const project = f.store.need('project', 'orders');
    const task = { id: 'plain', projectId: 'orders', domain: 'order', kind: 'implementation', goal: '주문 화면 문구 수정', rationale: '지식 근거 없는 기존 작업', references: [project.references[0]],
      dependsOn: [], criteria: ['c1'], allowedChanges: ['src/main'], exclusions: ['docs'], outputs: ['o'], requiredCapabilities: ['code-agent:claude'], verification: '검토' };
    m = f.engine.plan(m.id, { schemaVersion: 1, summary: '지식 없는 계획', unresolved: [], tasks: [task, { ...task, id: 'check', kind: 'verification', dependsOn: ['plain'] }] }, m.revision);
    const sent = f.host.sent.length, calls = f.calls().length, files = runFiles(f.repos.orders);
    await f.dispatch(m.id, 'plain');
    const attempt = attemptOf(f, m.id, 'plain'), record = controlRunOf(f, attempt);
    assert.ok(!Object.hasOwn(attempt, 'knowledgeHandoff'));
    const window = f.host.sent.slice(sent), submit = window.find(x => x.type === 'submit');
    assert.ok(!Object.hasOwn(submit.options.payload, 'knowledge'), 'submit 에 knowledge 키가 없다');
    assert.ok(!window.some(x => x.type === 'hello'), '지식 인계 공지를 묻지 않는다');
    assert.equal(f.calls().length, calls, '생산자를 부르지 않는다');
    assert.equal(runFiles(f.repos.orders).length, files.length + 1);
    assert.ok(!Object.hasOwn(readRun(f.repos.orders, record.id), 'knowledge'), 'code-agent 실행 기록에 knowledge 가 없다');
    assert.ok(!Object.hasOwn(record, 'knowledge'));
    assert.equal(readRun(f.repos.orders, record.id).state, 'completed', '접수돼 끝까지 실행됐다');
    assert.ok(!f.store.events(m.id).some(e => e.type.startsWith('knowledge-handoff')));
    f.cancel(m.id);
  });

  await t.test('수명·off: 계획 교체로 이전 묶음 임대를 놓고, off 프로젝트 배정은 생산자를 부르지 않으면서 필수 근거는 계속 보낸다', async () => {
    let m = f.create('ki-m3', ['orders']);
    await f.planner.analyze(m.id, provider(), { expectedRevision: m.revision });
    const before = f.store.get(BUNDLE_KIND, f.store.need('mission', m.id).plans.at(-1).knowledge.bundleId);
    m = f.store.need('mission', m.id);
    const replaced = await f.planner.analyze(m.id, provider(), { expectedRevision: m.revision });
    assert.equal(replaced.mission.state, 'planned');
    const plan = f.store.need('mission', m.id).plans.at(-1), bundle = f.store.get(BUNDLE_KIND, plan.knowledge.bundleId);
    assert.notEqual(bundle.id, before.id);
    const old = f.store.get(BUNDLE_KIND, before.id);
    assert.deepEqual([old.state, old.releaseReason, old.lease.state, old.lease.releaseReason], ['released', 'plan-replaced', 'released', 'plan-replaced']);
    assert.deepEqual((await f.producerLeases(leaseHolder(m.id))).map(l => l.leaseId), [bundle.lease.leaseId], '생산자에는 지금 계획의 임대만 남는다');

    const hello = await f.host.knowledgeHello(f.store.need('project', 'orders')), version = expectedVersion(hello, bundle);
    setBinding(f.store, 'orders', { mode: 'off', revision: bindingOf(f.store, 'orders').revision });
    try {
      const task = implementation(plan, 'orders'), lease = structuredClone(f.store.get(BUNDLE_KIND, bundle.id).lease), calls = f.calls().length;
      await f.dispatch(m.id, task.id);
      assert.equal(f.calls().length, calls, 'off 배정은 생산자를 부르지 않는다(임대 연장 없음)');
      assert.deepEqual(f.store.get(BUNDLE_KIND, bundle.id).lease, lease);
      const attempt = attemptOf(f, m.id, task.id), handoff = attempt.knowledgeHandoff;
      // 이미 승인된 필수 의존은 off 에서도 인계한다. 선택 근거는 새로 넘기지 않는다
      assert.deepEqual([handoff.status, handoff.version, handoff.sent, handoff.sentRequired], ['prepared', version, 1, 1]);
      assert.deepEqual(handoff.payload, { version, refs: wireOf(bundle, task, version, task.knowledgeRequired) });
      assert.deepEqual(handoff.omitted, task.knowledgeRefs.filter(r => !task.knowledgeRequired.includes(r)).map(ref => ({ ref, reason: 'knowledge-disabled' })));
      const record = controlRunOf(f, attempt);
      assert.deepEqual(readRun(f.repos.orders, record.id).knowledge, handoff.payload);
      assert.deepEqual([record.knowledge.state, record.knowledge.digestMatched], ['accepted', true]);
    } finally {
      setBinding(f.store, 'orders', { mode: 'enabled', revision: bindingOf(f.store, 'orders').revision });
      f.cancel(m.id);
    }
    assert.deepEqual(await settleLeases(f.store, { missionId: m.id, env: f.env }), [{ bundleId: bundle.id, state: 'released' }]);
    assert.deepEqual(await f.producerLeases(leaseHolder(m.id)), []);
  });

  await t.test('수신 거부: code-agent 등록 문서 밖의 필수 근거는 실제 수신자가 받지 않는다 — 실행 없이 그 시도만 거부로 막고 같은 호출을 다시 보내지 않는다', async () => {
    const m = f.create('ki-m5', ['orders']);
    // agent-knowledge 는 docs/notes.md 도 색인하지만 code-agent.json 의 등록 문서가 아니다 — master 는 수신자의 등록 문서 목록을 모른다
    await f.planner.analyze(m.id, provider({ docs: { orders: 'docs/notes.md' } }), { expectedRevision: m.revision });
    const plan = f.store.need('mission', m.id).plans.at(-1), task = implementation(plan, 'orders');
    try {
      assert.equal(task.knowledgeRequired.length, 1);
      const sent = f.host.sent.length, events = f.store.events(m.id).length, files = runFiles(f.repos.orders);
      await f.dispatch(m.id, task.id);
      const attempt = attemptOf(f, m.id, task.id), handoff = attempt.knowledgeHandoff, commandId = `inv-${attempt.invocationId}`;
      assert.equal(handoff.status, 'prepared');
      assert.deepEqual(runFiles(f.repos.orders), files, 'code-agent 실행을 만들지 않았다');
      assert.equal(f.host.sent.slice(sent).filter(x => x.type === 'submit' && x.options.commandId === commandId).length, 1, '같은 commandId 를 다시 보내지 않는다');
      const rejected = f.store.events(m.id).slice(events).find(e => e.type === 'knowledge-handoff-rejected');
      assert.deepEqual([rejected.commandId, rejected.code, rejected.reason], [commandId, 'invalid-request', 'knowledge-scope']);
      // 확인되지 않은 실행으로 두지 않는다 — 거부 응답은 실행을 만들지 않았다는 확인이고, 그 시도만 막힌다
      assert.deepEqual([attempt.state, attempt.turns.at(-1).error.code, handoff.delivery.state], ['unknown', 'knowledge-handoff-rejected', 'rejected']);
      assert.equal(deliveryBlock(handoff), 'knowledge-handoff-rejected');
      const known = await f.host.client(f.store.need('project', 'orders')).result('command', { payload: { commandId } });
      assert.equal(known.known, true);
      assert.ok(!known.response?.ok && known.response?.error?.detail?.reason === 'knowledge-scope', JSON.stringify(known));
    } finally { f.cancel(m.id); }
    await settleLeases(f.store, { missionId: m.id, env: f.env });
  });

  await t.test('임대·세대: 실제 생산자 임대가 만료되면 같은 세대로 다시 잡아 인계하고, 만료 뒤 세대가 정리되면 시도 없이 그 작업만 보류한다', async () => {
    const lease = args => callKnowledge(knowledgeConnection(f.env), 'lease', null, { args });
    const leaseCalls = from => f.calls().slice(from).filter(args => args[0] === 'lease').map(args => args.slice(0, args.indexOf('--config') < 0 ? args.length : args.indexOf('--config')));
    const open = new Set();
    try {
      // 두 목표가 같은 활성 세대를 계획 근거로 붙잡는다. master 임대 기간(3일)을 생산자 최소 기간(60초)으로 밖에서 줄여 실제로 만료시킨다
      const planned = [];
      for (const key of ['ki-m6', 'ki-m7']) {
        const m = f.create(key, ['orders']); open.add(m.id);
        await f.planner.analyze(m.id, provider(), { expectedRevision: m.revision });
        const plan = f.store.need('mission', m.id).plans.at(-1), bundle = f.store.get(BUNDLE_KIND, plan.knowledge.bundleId);
        assert.equal(bundle.lease.state, 'held');
        planned.push({ id: m.id, task: implementation(plan, 'orders'), bundle, expiresAt: (await lease(['renew', '--lease-id', bundle.lease.leaseId, '--ttl', '60'])).lease.expiresAt });
      }
      const [m6, m7] = planned, generation = m6.bundle.lease.generation;
      assert.equal(m7.bundle.lease.generation, generation);
      await delay(Math.max(...planned.map(p => Date.parse(p.expiresAt))) - Date.now() + 1500);
      assert.deepEqual((await f.producerLeases(leaseHolder(m6.id))).map(l => [l.leaseId, l.expired]), [[m6.bundle.lease.leaseId, true]]);

      // 1) 만료 → 재획득: 배정 직전 연장이 실제 lease-expired 를 받고 같은 세대·색인 ID 로 새 임대를 잡은 뒤 그대로 인계한다
      let calls = f.calls().length;
      await f.dispatch(m6.id, m6.task.id);
      assert.deepEqual(leaseCalls(calls), [['lease', 'renew', '--lease-id', m6.bundle.lease.leaseId, '--ttl', '259200'],
        ['lease', 'acquire', '--holder', leaseHolder(m6.id), '--generation', String(generation), '--ttl', '259200', '--index-id', m6.bundle.lease.indexId]]);
      const renewed = f.store.get(BUNDLE_KIND, m6.bundle.id).lease;
      assert.notEqual(renewed.leaseId, m6.bundle.lease.leaseId);
      assert.deepEqual([renewed.state, renewed.generation, renewed.holder, renewed.indexId], ['held', generation, leaseHolder(m6.id), m6.bundle.lease.indexId]);
      assert.deepEqual((await f.producerLeases(leaseHolder(m6.id))).filter(l => !l.expired).map(l => [l.leaseId, l.generation]), [[renewed.leaseId, generation]]);
      assert.ok(f.store.events(m6.id).some(e => e.type === 'knowledge-lease-reacquired' && e.bundleId === m6.bundle.id && e.generation === generation));
      const handoff = attemptOf(f, m6.id, m6.task.id).knowledgeHandoff;
      assert.deepEqual([handoff.status, handoff.lease.state, handoff.lease.leaseId, handoff.delivery.state], ['prepared', 'held', renewed.leaseId, 'accepted']);
      assert.ok(handoff.payload.refs.every(r => generationOf(r) === generation));
      f.cancel(m6.id); open.delete(m6.id);
      assert.deepEqual(await settleLeases(f.store, { missionId: m6.id, env: f.env }), [{ bundleId: m6.bundle.id, state: 'released' }]);

      // 2) 만료 뒤 정리: 다른 원본이 바뀌어 새 세대를 게시하고(보존 1) 만료 임대만 남은 계획 세대를 생산자가 지운다
      await settleLeases(f.store, { env: f.env });
      const before = (await lease(['list'])).leases;
      assert.deepEqual(before.filter(l => !l.expired), [], '계획 세대를 지키는 유효 임대가 없다');
      assert.ok(before.some(l => l.leaseId === m7.bundle.lease.leaseId && l.expired));
      write(f.repos.billing, { [DOCS.billing]: `${BILLING}\n## BL-002 정산 보류\n\n- 상태: 확정\n정산 보류는 하루를 넘기지 않는다.\n` });
      git(f.repos.billing, 'commit', '-qam', '정산 보류 규칙');
      const gcSources = join(dirname(f.sources), 'sources-retain-1.yaml');
      writeFileSync(gcSources, JSON.stringify({ ...JSON.parse(readFileSync(f.sources, 'utf8')), index: { retainGenerations: 1 } }));
      const indexed = spawnSync(process.execPath, [AK_CLI, 'index', '--config', gcSources, '--db', f.db, '--quiet'], { encoding: 'utf8', windowsHide: true, env: process.env });
      assert.equal(indexed.status, 0, indexed.stdout + indexed.stderr);
      assert.deepEqual((await lease(['list'])).leases, [], '만료 임대는 정리와 함께 지워진다');

      // 배정 직전 연장 → 임대 없음 → 같은 세대 재획득 실패(generation-not-found) → 소실. 시도·submit 없이 그 작업만 보류한다
      const sent = f.host.sent.length;
      calls = f.calls().length;
      let held;
      await assert.rejects(f.dispatch(m7.id, m7.task.id), error => { held = error; return Boolean(error.handoff); });
      assert.equal(held.code, 'knowledge-generation-expired');
      assert.deepEqual([held.handoff.status, held.handoff.required, held.handoff.lease.state, held.handoff.lease.reason], ['held', 1, 'lost', 'generation-not-found']);
      assert.deepEqual(leaseCalls(calls).map(args => args.slice(0, 2)), [['lease', 'renew'], ['lease', 'acquire']]);
      const lost = f.store.get(BUNDLE_KIND, m7.bundle.id).lease;
      assert.deepEqual([lost.state, lost.reason, lost.generation, lost.diagnostic?.reason], ['lost', 'generation-not-found', generation, 'generation-not-found']);
      assert.ok(!f.store.need('mission', m7.id).attempts.some(a => a.taskId === m7.task.id), '시도를 만들지 않는다');
      assert.ok(!f.host.sent.slice(sent).some(x => x.type === 'submit'), 'submit 을 보내지 않는다');
      const events = f.store.events(m7.id);
      assert.ok(events.some(e => e.type === 'knowledge-lease-failed' && e.bundleId === m7.bundle.id && e.state === 'lost' && e.reason === 'generation-not-found'));
      assert.ok(events.some(e => e.type === 'knowledge-handoff-held' && e.taskId === m7.task.id && e.code === 'knowledge-generation-expired'));
      // 소실을 확인한 임대는 다시 묻지 않는다 — 같은 보류, 생산자 호출 없음(재계획이 새 묶음·임대를 만든다)
      calls = f.calls().length;
      await assert.rejects(f.dispatch(m7.id, m7.task.id), error => error.code === 'knowledge-generation-expired');
      assert.deepEqual(leaseCalls(calls), []);
    } finally { for (const id of open) f.cancel(id); }
  });

  await t.test('진행 게이트: master 가 연 code-agent 작업(MA-<uuid>)에 고정된 인계를 실제로 검증하고 통과·실패를 master 가 그대로 본다', async () => {
    let m = f.create('ki-m4', ['orders']);
    // 가짜 호스트는 프롬프트의 MODE=loop 로 hook 을 돌며 기다린다 — 그 사이 작업을 연다(가짜 호스트는 작업을 열지 않는다)
    await f.planner.analyze(m.id, provider({ goalPrefix: 'MODE=loop ' }), { expectedRevision: m.revision });
    const plan = f.store.need('mission', m.id).plans.at(-1), task = implementation(plan, 'orders'), bundle = f.store.get(BUNDLE_KIND, plan.knowledge.bundleId);
    await f.dispatch(m.id, task.id, { wait: false });
    let attempt = attemptOf(f, m.id, task.id);
    const workId = attempt.codeAgentWorkId, runId = controlRunOf(f, attempt).id, project = f.store.need('project', 'orders');
    assert.equal(attempt.state, 'running');
    assert.match(workId, /^MA-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    await waitFor('code-agent 실행 시작', () => readRun(f.repos.orders, runId).state === 'running');
    // code-agent 는 MA-<uuid> 작업 ID 를 받는다(요구 ID 형식 [A-Za-z0-9][A-Za-z0-9._-]{0,63}). 실행 중 연 작업을 감독이 그 실행에 묶는다
    const spec = `doc/work/${workId}.md`;
    write(f.repos.orders, { [spec]: ['---', 'kind: feature', `id: ${workId}`, 'title: 주문 취소 기간을 확인한다', 'target: order', 'scope: [src/main, src/test]', '---', '', '결제 후 24시간 이내 주문 취소를 허용한다.', ''].join('\n') });
    ca('agent/request.js').recordRequestDecision(slash(f.repos.orders), { id: workId, spec, decision: 'confirmed', approver: 'test', presence: PRESENCE });
    ca('agent/commands.js').start(slash(f.repos.orders), `${slash(f.repos.orders)}/${spec}`);
    const worksFile = join(f.repos.orders, '.code-agent', 'master', 'works', `${encodeURIComponent(workId)}.json`);
    const bound = JSON.parse(await waitFor('작업 연결', () => existsSync(worksFile) && readFileSync(worksFile, 'utf8')));
    assert.deepEqual([bound.workId, bound.runId, bound.knowledge], [workId, runId, attempt.knowledgeHandoff.payload]);
    if (readRun(f.repos.orders, runId).state === 'running') await f.host.stopAttempt(m.id, attempt.id, 'pause', { reason: '시험 정지' });
    await f.live.reattach(m.id, attempt.id, f.host, { wait: true });

    // 1) 실행 끝 — 실제 snapshot 으로 작업 고정(matched)·게이트(검증 전 → unverified)를 보고 그 시도를 막는다
    attempt = attemptOf(f, m.id, task.id);
    let handoff = attempt.knowledgeHandoff;
    const record = f.store.get('control-run', runId);
    assert.deepEqual([record.knowledge.workId, record.knowledge.stored, record.knowledge.verification.state, record.knowledge.verification.source], [workId, 'matched', 'unverified', 'code-agent-gate']);
    assert.deepEqual([attempt.state, handoff.delivery.stored, handoff.delivery.verification.state, handoff.delivery.verification.action], ['blocked', 'matched', 'unverified', 'knowledge-reverify']);
    assert.equal(deliveryBlock(handoff), 'knowledge-verification-pending');

    // 2) master 재검증(code-agent knowledge verify, 시도마다 한 번) → 실제 어댑터·생산자로 대조해 통과
    let state = await f.host.inspect(project);
    assert.deepEqual([state.resume.code, state.work.id, state.knowledge.action, state.knowledge.digest], ['knowledge-blocked', workId, 'knowledge-reverify', handoff.digest]);
    m = f.store.need('mission', m.id);
    await f.live.reverifyKnowledge(m.id, attempt.id, f.host, { expectedRevision: m.revision, expectedState: state.stateVersion });
    attempt = attemptOf(f, m.id, task.id); handoff = attempt.knowledgeHandoff;
    assert.deepEqual([handoff.reverify.state, handoff.reverify.commandId, handoff.delivery.verification.state], ['passed', `kv-${attempt.id}`, 'passed']);
    assert.equal(deliveryBlock(handoff), null);
    m = f.store.need('mission', m.id); state = await f.host.inspect(project);
    await assert.rejects(f.live.reverifyKnowledge(m.id, attempt.id, f.host, { expectedRevision: m.revision, expectedState: state.stateVersion }), error => error.code === 'knowledge-verification-pending');

    // 3) code-agent context 의 pinned 검증이 게이트 기록을 쓴다 — master 는 상태 조회·snapshot 의 게이트로 passed 를 본다
    const context = () => {
      const r = spawnSync(process.execPath, [CA_CLI, 'context'], { cwd: f.repos.orders, env: childEnv(), encoding: 'utf8', windowsHide: true, timeout: 120000 });
      assert.equal(r.status, 0, r.stderr);
      return knowledgeLog(f.repos.orders).at(-1);
    };
    const required = handoff.payload.refs.find(r => r.required);
    let pinned = context().pinned.find(p => p.itemId === required.itemId);
    assert.deepEqual([pinned.ok, pinned.how, pinned.sha256], [true, 'exact', required.itemSha256]);
    state = await f.host.inspect(project);
    assert.equal(state.knowledge.state, 'verified');
    assert.equal(gateVerification(state.knowledge, handoff, workId).state, 'passed');
    const snapshot = await f.host.client(project).result('snapshot');
    assert.equal(gateVerification(snapshot.state.knowledge, handoff, workId).state, 'passed');
    await f.live.knowledgeContinuation(f.store.need('mission', m.id), attempt, project, state);

    // 4) 필수 근거 원본을 커밋 없이 고친다 → pinned content-changed → 게이트 knowledge-replan → master 는 failed(knowledge-verification-failed)
    const rulesFile = join(f.repos.orders, DOCS.orders), item = bundle.knowledge.items.find(i => i.itemId === required.itemId);
    const lines = RULES.split('\n'), last = [...Array(item.endLine - item.startLine + 1).keys()].map(n => item.endLine - 1 - n).find(n => lines[n].trim());
    lines[last] = `${lines[last]} (수정)`;
    writeFileSync(rulesFile, lines.join('\n'));
    try {
      pinned = context().pinned.find(p => p.itemId === required.itemId);
      assert.deepEqual([pinned.ok, pinned.reason], [false, 'content-changed']);
      state = await f.host.inspect(project);
      assert.deepEqual([state.resume.code, state.knowledge.state, state.knowledge.action], ['knowledge-blocked', 'blocked', 'knowledge-replan']);
      const verification = gateVerification(state.knowledge, handoff, workId);
      assert.deepEqual([verification.state, verification.action, verification.failures.map(x => x.itemId)], ['failed', 'knowledge-replan', [required.itemId]]);
      assert.equal(deliveryBlock({ ...handoff, delivery: { ...handoff.delivery, verification } }), 'knowledge-verification-failed');
      await assert.rejects(f.live.knowledgeContinuation(f.store.need('mission', m.id), attemptOf(f, m.id, task.id), project, state), error => error.code === 'knowledge-verification-failed');
    } finally { writeFileSync(rulesFile, RULES); }
    f.cancel(m.id);
    assert.deepEqual(await settleLeases(f.store, { missionId: m.id, env: f.env }), [{ bundleId: bundle.id, state: 'released' }]);
    assert.ok(runFiles(f.repos.orders).every(name => !ACTIVE_RUN.includes(readRun(f.repos.orders, basename(name, '.json')).state)), '진행 중 실행이 남지 않는다');
  });
});
