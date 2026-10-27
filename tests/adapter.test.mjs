import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { observeProject, parseState } from '../packages/code-agent-adapter/observe.mjs';
import { setup } from './helpers.mjs';

function stateFor(path) {
  return { schema: 'code-agent.state', schemaVersion: 1, observedAt: new Date().toISOString(), stateVersion: 'v1',
    repo: { root: path }, work: null, resume: { code: 'no-work', reasons: [] },
    ownership: { process: 'unverified', lease: { state: 'none' } }, unknown: ['프로세스 생존 미확인'] };
}
function fixtureCli(root, projectPath, source) {
  mkdirSync(join(projectPath, '.code-agent'), { recursive: true });
  writeFileSync(join(projectPath, '.code-agent/version'), 'fixture-only');
  const cli = join(root, 'fake-code-agent.mjs');
  writeFileSync(cli, source);
  return cli;
}

test('상태 조회 스키마·버전·프로젝트 경로·미확인을 구별한다', t => {
  const { fixture } = setup(t);
  const path = fixture.projects[0].path;
  const state = stateFor(path);
  assert.equal(parseState(JSON.stringify(state), path).status, 'observed');
  assert.equal(parseState('사람용 출력', path).status, 'invalid-json');
  assert.equal(parseState(JSON.stringify({ ...state, schemaVersion: 2 }), path).status, 'unsupported-version');
  assert.equal(parseState(JSON.stringify({ ...state, ownership: null }), path).status, 'invalid-state');
  assert.equal(parseState(JSON.stringify({ ...state, repo: { root: fixture.projects[1].path } }), path).status, 'wrong-project');
  assert.equal(parseState(JSON.stringify({ ...state, resume: { code: 'unobservable', reasons: [] } }), path).status, 'unobservable');
});

test('실제 프로세스 호출에서 cwd와 status --json 인자를 고정하고 상태를 변경하지 않는다', async t => {
  const { store, fixture, root } = setup(t);
  const p = fixture.projects[0];
  const cli = fixtureCli(root, p.path, `
    import assert from 'node:assert/strict';
    assert.deepEqual(process.argv.slice(2), ['status', '--json']);
    const state = ${JSON.stringify(stateFor(p.path))};
    state.repo.root = process.cwd();
    console.log(JSON.stringify(state));
  `);
  const marker = readFileSync(join(p.path, '.code-agent/version'), 'utf8');
  const observation = await observeProject(store, p.id, { cliPath: cli });
  assert.equal(observation.status, 'observed');
  assert.equal(observation.state.ownership.process, 'unverified');
  assert.equal(observation.capabilities.submit, false);
  assert.equal(store.need('project', p.id).revision, 1);
  assert.equal(readFileSync(join(p.path, '.code-agent/version'), 'utf8'), marker);
});

test('조회 실패에도 마지막 관측을 보존하고 실행 오류를 성공으로 바꾸지 않는다', async t => {
  const { store, fixture, root } = setup(t);
  const p = fixture.projects[0];
  const cli = fixtureCli(root, p.path, `console.log(${JSON.stringify(JSON.stringify(stateFor(p.path)))});`);
  await observeProject(store, p.id, { cliPath: cli });
  writeFileSync(cli, 'console.log("invalid"); process.exitCode=2;');
  const observation = await observeProject(store, p.id, { cliPath: cli });
  assert.equal(observation.status, 'invalid-json');
  assert.equal(observation.lastSuccessfulState.stateVersion, 'v1');
  assert.equal(observation.capabilities.status, false);
});

test('종료 코드 3도 유효한 상태 JSON이면 관측하며 프로세스 생존을 추정하지 않는다', async t => {
  const { store, fixture, root } = setup(t);
  const p = fixture.projects[0];
  const state = stateFor(p.path); state.resume.code = 'stale-request';
  const cli = fixtureCli(root, p.path, `console.log(${JSON.stringify(JSON.stringify(state))}); process.exitCode=3;`);
  const result = await observeProject(store, p.id, { cliPath: cli });
  assert.equal(result.status, 'observed');
  assert.equal(result.exitCode, 3);
});

test('설치 마커가 없으면 실행하지 않고 셸 래퍼도 거부한다', async t => {
  const { store, fixture, root } = setup(t);
  const cli = join(root, 'never-run.mjs'); writeFileSync(cli, 'throw new Error("must not execute");');
  const result = await observeProject(store, fixture.projects[0].id, { cliPath: cli });
  assert.equal(result.status, 'not-installed');
  const wrapper = join(root, 'wrapper.cmd'); writeFileSync(wrapper, 'exit /b 0');
  await assert.rejects(observeProject(store, fixture.projects[0].id, { cliPath: wrapper }), e => e.code === 'invalid-cli');
});

test('응답 없는 상태 조회를 시간 초과로 분류한다', async t => {
  const { store, fixture, root } = setup(t);
  const p = fixture.projects[0];
  const cli = fixtureCli(root, p.path, 'setInterval(() => {}, 1000);');
  const result = await observeProject(store, p.id, { cliPath: cli, timeoutMs: 250 });
  assert.equal(result.status, 'timeout');
});

test('L1: 상태 조회는 호스트·런타임 표지를 제거하고 일반 환경값은 보존한다', async t => {
  const { store, fixture, root } = setup(t), project = fixture.projects[0];
  const values = { CLAUDECODE: '1', CLAUDE_PROJECT_DIR: '/private/parent', CLAUDE_CODE_ENTRYPOINT: 'host',
    CODE_AGENT_MASTER_RUN: 'parent-run', CODE_AGENT_CROSS: '1', CODE_AGENT_RUNTIME_SELF: 'private-runtime',
    CODE_AGENT_ENTRY_PATH: 'private-entry', CODEX_CI: '1', CODEX_SANDBOX: '1', CODEX_SANDBOX_NETWORK_DISABLED: '1',
    CODEX_THREAD_ID: 'private-thread', MASTER_AGENT_ALLOWED_ENV: 'preserved' };
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  Object.assign(process.env, values);
  t.after(() => { for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  } });
  const cli = fixtureCli(root, project.path, `
    import assert from 'node:assert/strict';
    for (const key of ${JSON.stringify(Object.keys(values).filter(key => key !== 'MASTER_AGENT_ALLOWED_ENV'))}) assert.equal(process.env[key], undefined, key);
    assert.equal(process.env.MASTER_AGENT_ALLOWED_ENV, 'preserved');
    assert.equal(process.env.GIT_OPTIONAL_LOCKS, '0');
    console.log(JSON.stringify(${JSON.stringify(stateFor(project.path))}));
  `);
  assert.equal((await observeProject(store, project.id, { cliPath: cli })).status, 'observed');
});
