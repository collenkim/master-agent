import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, appendFileSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { Store } from '../packages/storage/store.mjs';
import { Engine } from '../packages/orchestrator/engine.mjs';
import { LiveWorkflow } from '../packages/orchestrator/drive.mjs';
import { LiveVerification } from '../packages/verification/live-verification.mjs';
import { ControlHost, bindControl } from '../packages/runner/control-host.mjs';
import { CliProvider } from '../packages/reasoning/cli-provider.mjs';
import { Knowledge } from '../packages/knowledge/sources.mjs';

// Opt-in live two-project execution. Only project onboarding TTY is emulated.
// Task approvals/questions, development, verification and delivery use production paths.
const [action, location] = process.argv.slice(2);
assert.ok(['setup', 'drive', 'status', 'report', 'stop'].includes(action), 'setup | drive <root> | status <root> | report <root> | stop <root>');
const root = action === 'setup' ? resolve('.master-agent', `full-flow-${randomUUID()}`) : resolve(location);
const save = (file, value) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify(value, null, 2) + '\n'); };
const write = (file, value) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, value); };
const git = (path, args) => execFileSync('git', ['-C', path, ...args], { encoding: 'utf8', windowsHide: true, stdio: 'pipe' }).trim();
const hashFile = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const cli = 'C:/IdeaProjects/code-agent/dist/agent/cli.js';
const claude = 'C:/Users/kai/.local/bin/claude.exe';
const configFile = join(root, 'experiment.json');

if (action === 'setup') {
  mkdirSync(root, { recursive: true });
  const require = createRequire(import.meta.url), use = name => require(`C:/IdeaProjects/code-agent/dist/agent/${name}.js`);
  const { init } = use('init'), { docsBegin, docsEnd, confirmDoc } = use('docsCommands'), { setupProject } = use('setup');
  const { withInteraction } = use('tty'), { masterEnable, masterGrant } = use('master/admin');
  const { DEFAULT_ALLOWED_TOOLS } = use('master/protocol');
  const tty = fn => withInteraction({ confirm: () => ({ channel: 'tty', verified: true, detail: '전체 흐름 시험의 도입 TTY 흉내 — 실제 사람 확인 아님' }), ask: () => 'n' }, fn);
  const store = new Store(join(root, 'state.db')), engine = new Engine(store);
  try {
    const projects = [];
    const policy = '이 저장소는 격리된 전체 흐름 시험이다. Node.js 24, CommonJS와 node:test만 사용한다. 외부 패키지 다운로드·원격 반영은 하지 않는다. 계산은 마지막에 Math.round(x * 100) / 100으로 반올림한다. 요구사항에 명시되지 않은 기능은 추가하지 않는다.\n';
    for (const id of ['price-core', 'invoice-app']) {
      const path = join(root, id);
      mkdirSync(path);
      git(path, ['init', '-q', '-b', 'master']); git(path, ['config', 'user.name', 'full-flow-fixture']);
      git(path, ['config', 'user.email', 'fixture@example.invalid']); git(path, ['config', 'commit.gpgsign', 'false']); git(path, ['config', 'core.autocrlf', 'false']);
      init(path, { cli, host: 'claude' }); docsBegin(path); setupProject(path, 'node'); docsEnd(path);
      write(join(path, 'README.md'), `# ${id}\n\n격리된 실제 AI 전체 흐름 시험. node --test로 테스트한다.\n`);
      write(join(path, 'POLICY.md'), policy);
      save(join(path, 'package.json'), { name: id, version: '1.0.0', private: true, type: 'commonjs', scripts: { test: 'node --test' } });
      write(join(path, 'src/bootstrap.js'), "module.exports = {};\n");
      write(join(path, 'tests/bootstrap.test.js'), "const test = require('node:test'); const assert = require('node:assert/strict'); test('bootstrap', () => assert.equal(typeof require('../src/bootstrap'), 'object'));\n");
      appendFileSync(join(path, '.gitignore'), '\nnode_modules/\n');
      if (id === 'invoice-app') {
        const upstream = join(root, 'price-core');
        write(join(path, 'scripts/link-price-core.cjs'), `const fs = require('node:fs'), path = require('node:path');\nconst upstream = ${JSON.stringify(upstream)};\nconst target = path.resolve('node_modules/price-core');\nfs.mkdirSync(path.dirname(target), { recursive: true });\nif (fs.existsSync(target)) { if (fs.realpathSync(target) !== fs.realpathSync(upstream)) throw Error('Unexpected dependency target'); }\nelse fs.symlinkSync(upstream, target, 'junction');\nconsole.log('price-core dependency ready');\n`);
        const manifest = JSON.parse(readFileSync(join(path, 'code-agent.json'), 'utf8'));
        manifest.prepare = ['node', 'scripts/link-price-core.cjs']; save(join(path, 'code-agent.json'), manifest);
        execFileSync(process.execPath, ['scripts/link-price-core.cjs'], { cwd: path, windowsHide: true, stdio: 'pipe' });
      }
      tty(() => confirmDoc(path, 'all'));
      git(path, ['add', '.']); git(path, ['commit', '-qm', 'chore: isolated full-flow onboarding fixture']);
      assert.equal(git(path, ['status', '--porcelain']), '');
      const p = engine.catalog.register({ id, name: id, path, domains: [id === 'price-core' ? 'price' : 'invoice'], capabilities: ['code-agent:claude'], constraints: ['원격 반영·설정 변경 금지'], currentPlans: [], references: ['sample-policy'] });
      projects.push(new Knowledge(store).collect(id, { schemaVersion: 1, sources: [{ path: 'POLICY.md', kind: 'policy' }] }, p.revision).project);
    }
    const goals = {
      discount: 'src/discount.js는 CommonJS module.exports = { discount }로 discount(amount, percent)를 제공한다. amount는 유한한 number이며 0~1000000, percent는 유한한 number이며 0~100이어야 하고, 하나라도 위반하면 RangeError다(문자열·null·undefined·NaN·Infinity도 거부). 정상 결과는 Math.round(amount * (1 - percent / 100) * 100) / 100이다. tests/discount.test.js에 node:test로 정상·경계·오류 케이스를 검증한다.',
      total: 'src/total.js는 CommonJS module.exports = { total }로 total(items)를 제공한다. items가 배열이 아니면 TypeError다. 배열 길이가 1000을 넘으면 RangeError다. 모든 인덱스에 배열이 아닌 {qty, price} 객체가 있어야 하며 빈 자리(희소 배열)·null·배열 원소·객체가 아닌 원소는 TypeError다. qty는 number 정수 0~1000, price는 유한한 number 0~1000000이어야 하고 필드 누락 또는 값 위반은 RangeError다(문자열·NaN·Infinity 거부). 합계는 모든 qty*price를 더한 뒤 마지막 한 번만 Math.round(sum*100)/100으로 반올림한다. 빈 배열은 0이다. tests/total.test.js에 node:test로 정상·경계·오류 케이스를 검증한다.',
      checkout: 'src/checkout.js는 CommonJS module.exports = { checkout }로 checkout(items, percent)를 제공한다. 같은 프로젝트의 require("./total.js").total과 require("price-core/src/discount.js").discount를 재사용해서 discount(total(items), percent)를 반환한다. 입력 검증은 두 함수의 오류를 그대로 전파하고 계산을 복제하지 않는다. total 결과가 discount의 amount 범위를 넘으면 RangeError를 그대로 전파한다. tests/checkout.test.js에 node:test로 실제 두 모듈을 사용하는 정상·경계·오류 통합 테스트를 작성한다. price-core 의존성 연결은 기존 code-agent.json prepare가 제공한다.',
    };
    const criteria = Object.entries(goals).map(([id, description]) => ({ id, description }));
    let mission = engine.create({ mode: 'live', requestKey: `full-flow-${randomUUID()}`, goal: 'price-core 할인 함수와 invoice-app 합계 함수를 구현하고, 두 결과를 재사용하는 결제 금액 함수를 통합해 실제 검증·로컬 반영까지 완료한다. 각 작업의 명시된 입력 정책과 기존 검토·승인 절차를 지킨다.', scope: { projectIds: projects.map(p => p.id), groupIds: [] }, criteria });
    const tasks = Object.entries(goals).map(([id, goal]) => {
      const p = projects.find(p => p.id === (id === 'discount' ? 'price-core' : 'invoice-app'));
      return { id, projectId: p.id, domain: p.domains[0], kind: id === 'checkout' ? 'integration' : 'implementation', goal,
        rationale: '도메인별 독립 구현과 선행 산출물을 사용하는 통합', references: p.references, dependsOn: id === 'checkout' ? ['discount', 'total'] : [],
        criteria: id === 'checkout' ? ['discount', 'total', 'checkout'] : [id], allowedChanges: [`src/${id}.js`, `tests/${id}.test.js`], exclusions: ['code-agent.json', 'package.json', 'POLICY.md', 'scripts/link-price-core.cjs', 'src/bootstrap.js', 'tests/bootstrap.test.js'], outputs: [`${id}-check`], requiredCapabilities: ['code-agent:claude'], verification: '프로젝트 node:test와 master 독립 검사 통과' };
    });
    mission = engine.plan(mission.id, { schemaVersion: 1, summary: '두 프로젝트·세 작업 전체 흐름 검증용 고정 계획', unresolved: [], tasks }, mission.revision);
    const scripts = {
      discount: `const {discount:d}=require(${JSON.stringify(join(root, 'price-core/src/discount.js'))}); assert.equal(d(100,10),90); assert.equal(d(19.99,15),16.99); assert.equal(d(0,100),0); assert.equal(d(100,0),100); assert.equal(d(100,100),0); for(const x of [-1,1000001,NaN,Infinity,'1',null,undefined]) assert.throws(()=>d(x,10),RangeError); for(const x of [-1,101,NaN,Infinity,'1',null,undefined]) assert.throws(()=>d(100,x),RangeError);`,
      total: `const {total:t}=require(${JSON.stringify(join(root, 'invoice-app/src/total.js'))}); assert.equal(t([]),0); assert.equal(t([{qty:2,price:9.99},{qty:1,price:5}]),24.98); assert.equal(t([{qty:1,price:0.004},{qty:1,price:0.004}]),0.01); assert.equal(t([{qty:0,price:1000000}]),0); assert.throws(()=>t(null),TypeError); assert.throws(()=>t(new Array(2)),TypeError); assert.throws(()=>t(Array(1001).fill({qty:0,price:0})),RangeError); for(const x of [null,[],1,'x']) assert.throws(()=>t([x]),TypeError); for(const x of [{},{qty:0.5,price:1},{qty:-1,price:1},{qty:1001,price:1},{qty:1,price:1000001},{qty:1,price:NaN},{qty:'1',price:1},{qty:1,price:Infinity}]) assert.throws(()=>t([x]),RangeError);`,
      checkout: `const {checkout:c}=require(${JSON.stringify(join(root, 'invoice-app/src/checkout.js'))}); assert.equal(c([{qty:2,price:9.99},{qty:1,price:5}],10),22.48); assert.equal(c([],0),0); assert.equal(c([{qty:1,price:100}],100),0); assert.throws(()=>c(null,0),TypeError); assert.throws(()=>c([{qty:1,price:1}],NaN),RangeError); assert.throws(()=>c([{qty:2,price:1000000}],0),RangeError);`,
    };
    for (const [id, body] of Object.entries(scripts)) write(join(root, 'checks', `${id}.cjs`), `const assert=require('node:assert/strict');\n${body}\nconsole.log('${id} independent assertions passed');\n`);
    const verifier = new LiveVerification(store);
    for (const task of tasks) {
      const ids = task.id === 'checkout' ? ['checkout', 'discount', 'total'] : [task.id];
      const checks = ids.map(id => ({ id: `${id}-independent`, executable: process.execPath, args: [join(root, 'checks', `${id}.cjs`)], criterionIds: task.criteria, timeoutMs: 30000 }));
      checks.push({ id: `${task.id}-project-tests`, executable: process.execPath, args: ['--test'], criterionIds: task.criteria, timeoutMs: 30000 });
      mission = verifier.configure(mission.id, { schemaVersion: 1, taskId: task.id, allowedPaths: task.allowedChanges, codeAgentRecords: true, delivery: { mode: 'code-agent-commit', metadataPaths: [] }, checks, artifacts: [{ name: `${task.id}-check`, checkId: `${task.id}-independent` }] }, mission.revision);
    }
    for (const p of projects) {
      const outside = join(root, 'control', p.id), tokenFile = join(outside, 'controller.token');
      mkdirSync(outside, { recursive: true });
      const hostFile = join(outside, 'host.json'), grantFile = join(outside, 'grant.json');
      save(hostFile, { command: [claude], permissionMode: 'acceptEdits', allowedTools: [...DEFAULT_ALLOWED_TOOLS, 'Agent', `Bash(node ${cli} *)`, `PowerShell(node ${cli} *)`, 'Bash(node --test*)', 'Bash(node --check*)', 'Bash(npm test*)'] });
      tty(() => masterEnable(p.path, { controller: 'full-flow', tokenOut: tokenFile, host: hostFile }));
      save(grantFile, { id: `full-flow-${p.id}`, controller: 'full-flow', missions: [mission.id], actions: ['request', 'plan', 'deliver', 'answer'], paths: ['src/**', 'tests/**', 'doc/work/**', '.code-agent/work/**', '.code-agent/approvals/**'], ttlHours: 24, maxUses: 80 });
      tty(() => masterGrant(p.path, grantFile));
      await bindControl(store, p.id, { cliPath: cli, controller: 'full-flow', tokenFile });
    }
    const preflight = Object.keys(scripts).map(id => ({ id, exitCode: spawnSync(process.execPath, [join(root, 'checks', `${id}.cjs`)], { windowsHide: true }).status }));
    assert.ok(preflight.every(c => c.exitCode !== 0), '독립 검사는 구현 전 실패해야 한다');
    const config = { scenarioVersion: 2, root, missionId: mission.id, database: join(root, 'state.db'), cli, claude, createdAt: new Date().toISOString(), node: process.version,
      masterCommit: git(resolve('.'), ['rev-parse', 'HEAD']), codeAgentCliHash: hashFile(cli),
      setupEmulated: ['공통 정책 문서 확인 TTY', 'master enable TTY', 'master grant TTY'],
      scope: '고정 master 계획으로 실제 개발·위임 판단·독립 검증·반영·통합 완료. master 초기 AI 계획 생성은 별도 범위.', projects, tasks, preflight };
    save(configFile, config);
    console.log(JSON.stringify({ stage: 'prepared', root, missionId: mission.id, preflight }));
  } finally { store.close(); }
} else {
  const config = JSON.parse(readFileSync(configFile, 'utf8'));
  const store = new Store(config.database), engine = new Engine(store);
  const status = () => {
    const m = store.need('mission', config.missionId);
    const projects = config.projects.map(p => {
      const file = join(p.path, '.code-agent/master/observed.json');
      if (!existsSync(file)) return { id: p.id, phase: null };
      const observed = JSON.parse(readFileSync(file, 'utf8'));
      return { id: p.id, at: observed.at, phase: observed.phase, attempt: observed.attempt, resume: observed.resume, unanswered: observed.unanswered };
    });
    return { at: new Date().toISOString(), missionId: m.id, state: m.state, tasks: m.tasks.map(t => ({ id: t.id, state: t.state })), projects,
      latestEvent: store.events(m.id).at(-1)?.type, openEscalations: store.list('escalation').filter(e => e.missionId === m.id && e.state === 'open').map(e => ({ id: e.id, taskId: e.taskId, target: e.target, category: e.category, reason: e.reason })) };
  };
  const report = () => {
    const m = engine.describe(config.missionId);
    const result = { ...config, recordedAt: new Date().toISOString(), mission: m, records: {} };
    for (const kind of ['decision', 'delegation', 'escalation', 'verification-run', 'evidence', 'control-run', 'graph-run']) result.records[kind] = store.list(kind).filter(r => r.missionId === m.id);
    result.projects = config.projects.map(p => {
      const work = join(p.path, 'doc/work');
      return { id: p.id, path: p.path, head: git(p.path, ['rev-parse', 'HEAD']), status: git(p.path, ['status', '--porcelain']), log: git(p.path, ['log', '-6', '--oneline']),
        questions: existsSync(work) ? readdirSync(work).filter(n => existsSync(join(work,n,'questions.md'))).map(n => ({ workId: n, text: readFileSync(join(work,n,'questions.md'),'utf8') })) : [] };
    });
    result.passed = m.state === 'succeeded' && m.tasks.length === 3 && m.tasks.every(t => t.state === 'succeeded');
    save(join(root, 'report.json'), result);
    return result;
  };
  try {
    if (action === 'stop') {
      const m = store.need('mission', config.missionId);
      if (m.state !== 'paused') engine.control(m.id, 'pause', m.revision);
      const host = new ControlHost(store, { cliPath: config.cli, pollMs: 1000 });
      for (const attempt of m.attempts.filter(a => a.state === 'running')) {
        const result = await host.stopAttempt(m.id, attempt.id, 'pause', { waitMs: 60000, reason: '시험 명세와 독립 검사 불일치로 보존 중단; 명세를 명확히 한 새 시험으로 대체' });
        console.log(JSON.stringify({ stage: 'stopped', attemptId: attempt.id, stopped: result.stopped, state: result.run?.state }));
      }
      save(join(root, 'operator-stop.json'), { at: new Date().toISOString(), reason: '샘플 명세는 원소 형태 오류의 종류를 정하지 않았는데 독립 검사가 RangeError로 제한했다. 진행 중인 검사·판단을 바꾸지 않고 보존 중단한다.' });
    }
    else if (action === 'status') console.log(JSON.stringify(status(), null, 2));
    else if (action === 'report') { const r = report(); console.log(JSON.stringify({ passed: r.passed, state: r.mission.state, report: join(root, 'report.json') })); }
    else {
      const host = new ControlHost(store, { cliPath: config.cli, pollMs: 2000, followTimeoutMs: 4 * 3600000 });
      const real = new CliProvider({ provider: 'claude', cliPath: config.claude, timeoutMs: 300000 });
      const provider = { name: real.name, generate: async request => {
        const id = randomUUID(); write(join(root, 'judgments', `${id}.prompt.txt`), request.prompt);
        const result = await real.generate(request); save(join(root, 'judgments', `${id}.json`), result);
        console.log(JSON.stringify({ stage: 'judgment', category: result.data.category, verdict: result.data.verdict, answer: result.data.answer, reason: result.data.reason?.slice(0, 220) }));
        return result;
      } };
      console.log(JSON.stringify({ stage: 'drive-start', ...status() }));
      const timer = setInterval(() => { try { const s = status(); save(join(root, 'progress.json'), s); console.log(JSON.stringify({ stage: 'progress', ...s })); } catch (error) { console.log(JSON.stringify({ stage: 'progress-error', message: error.message })); } }, 30000);
      try {
        const result = await new LiveWorkflow(store).run(config.missionId, host, provider);
        save(join(root, `drive-${Date.now()}.json`), result);
        console.log(JSON.stringify({ stage: 'drive-returned', state: result.mission.state, blockers: result.blockers }));
      } finally { clearInterval(timer); const r = report(); console.log(JSON.stringify({ stage: 'report', passed: r.passed, report: join(root, 'report.json') })); }
    }
  } finally { store.close(); }
}
