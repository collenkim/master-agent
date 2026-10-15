import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { temporary, cleanup } from './helpers.mjs';
import { Store } from '../packages/storage/store.mjs';
import { Engine } from '../packages/orchestrator/engine.mjs';
import { ControlHost, bindControl, requestControlHandover, acceptControl } from '../packages/runner/control-host.mjs';
import { ControlClient } from '../packages/code-agent-adapter/control.mjs';

/**
 * 실제 code-agent CLI(빌드 산출물)와 통신 계약으로 주고받는 연동 시험. 호스트는 code-agent 의 가짜 호스트(masterFakeHost.js)다 —
 * 실제 모델 실행이 아니다. 사람의 TTY 확인(enable)은 code-agent 시험과 같은 방식(withInteraction)으로 흉내낸다.
 * CODE_AGENT_DIST(또는 옆 저장소 ../code-agent/dist)가 없으면 건너뛴다.
 */
const DIST = resolve(process.env.CODE_AGENT_DIST ?? join(dirname(fileURLToPath(import.meta.url)), '../../code-agent/dist'));
const CLI = join(DIST, 'agent/cli.js'), FAKE = join(DIST, 'test/masterFakeHost.js');
const available = existsSync(CLI) && existsSync(FAKE) && existsSync(join(DIST, 'agent/master/admin.js'));
const POLICY = { heartbeatMs: 200, progressMs: 300, startTimeoutMs: 15000, stopGraceMs: 60000, masterTimeoutMs: 600000 };

function enable(root, outside, controller) {
  const script = join(outside, 'enable.cjs'), tokenFile = join(outside, `token-${controller}`);
  writeFileSync(join(outside, 'host.json'), JSON.stringify({ command: [process.execPath, FAKE] }));
  writeFileSync(join(outside, 'policy.json'), JSON.stringify(POLICY));
  writeFileSync(script, `const [dist, root, controller, tokenOut, host, policy] = process.argv.slice(2);
const { masterEnable } = require(dist + '/agent/master/admin.js');
const { withInteraction } = require(dist + '/agent/tty.js');
console.log(withInteraction({ confirm: () => ({ channel: 'tty', verified: true, detail: '모의 TTY(시험)' }), ask: () => 'n' },
  () => masterEnable(root, { controller, tokenOut, host, policy })));\n`);
  execFileSync(process.execPath, [script, DIST, root, controller, tokenFile, join(outside, 'host.json'), join(outside, 'policy.json')], { stdio: 'pipe' });
  return tokenFile;
}
async function waitFor(what, fn, ms = 30000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > end) throw new Error(`기다림 초과: ${what}`);
    await new Promise(r => setTimeout(r, 150));
  }
}

test('실제 code-agent 통신 계약: 연결·원자적 접수·중복 거부·이벤트 커서·결과·재부착·정지·제어권 인계와 이전 소유자 거부', { skip: !available && 'code-agent dist 없음', timeout: 180000 }, async t => {
  const root = temporary(t), outside = join(root, 'outside'); mkdirSync(outside);
  const path = join(root, 'project'); mkdirSync(path);
  const git = args => execFileSync('git', ['-C', path, ...args], { stdio: 'pipe' });
  git(['init', '-q']); git(['config', 'user.name', 't']); git(['config', 'user.email', 't@t']);
  writeFileSync(join(path, 'README.md'), 'x\n'); git(['add', '-A']); git(['commit', '-qm', 'init']);
  const store = new Store(join(root, 'm1.db')), other = new Store(join(root, 'm2.db'));
  cleanup(t, () => { store.close(); other.close(); });
  for (const s of [store, other]) new Engine(s).catalog.register({ id: 'p', name: 'p', path, domains: ['fixture'], capabilities: ['code-agent:claude'], constraints: [], currentPlans: [], references: ['fixture'] });

  // 연동이 꺼진 프로젝트는 연결하지 않는다
  await assert.rejects(bindControl(store, 'p', { cliPath: CLI, controller: 'm1', tokenFile: join(outside, 'none') }), e => e.code === 'control-not-enabled');
  const token1 = enable(path, outside, 'm1');
  const binding = await bindControl(store, 'p', { cliPath: CLI, controller: 'm1', tokenFile: token1 });
  assert.equal(binding.owner, true); assert.equal(binding.generation, 1);
  assert.equal(binding.delegation.available, true);
  const host = new ControlHost(store, { cliPath: CLI, pollMs: 200, followTimeoutMs: 60000 });
  const project = store.need('project', 'p'), client = host.client(project);
  // 연결만으로는 위임 권한이 없다
  assert.deepEqual((await client.result('grants')).grants, []);

  // 원자적 접수 — 같은 commandId 재전송은 같은 실행, 다른 내용은 conflict
  const payload = { mode: 'start', prompt: 'MODE=complete WRITE=src/out.txt', links: { missionId: 'M-1', taskId: 'T-1', attemptId: 'A-1', invocationId: 'I-1' } };
  const accepted = await client.result('submit', { commandId: 'inv-I-1', payload });
  const replay = await client.request('submit', { commandId: 'inv-I-1', payload });
  assert.equal(replay.replayed, true); assert.equal(replay.result.runId, accepted.runId);
  await assert.rejects(client.result('submit', { commandId: 'inv-I-1', payload: { ...payload, prompt: 'MODE=fail' } }), e => e.code === 'control-conflict');
  const ticket = { project, projectId: 'p', missionId: 'M-1', id: 'A-1', invocationId: 'I-1' };
  host.recordRun(ticket, accepted, 'inv-I-1');
  const outcome = await host.follow(project, accepted.runId, ticket);
  assert.equal(outcome.status, 'returned'); assert.equal(outcome.control.state, 'completed');
  assert.ok(outcome.control.files.some(f => f.path === 'src/out.txt'));
  const cursor = store.get('control-cursor', 'p');
  assert.ok(cursor.seq > 0 && cursor.logId);
  assert.ok(store.events('M-1').some(e => e.type === 'control-event' && e.eventType === 'run.finished' && e.seq));
  // 재부착 — 같은 호출의 기록으로 결과를 받고 새 실행을 만들지 않는다
  const again = await host.reattach(ticket);
  assert.equal(again.control.runId, accepted.runId);
  const snapshot = await client.result('snapshot');
  assert.equal(snapshot.runs.recent.length, 1);
  await assert.rejects(host.reattach({ ...ticket, invocationId: 'never-sent' }), e => e.code === 'control-not-submitted');

  // 정지 — 요청 접수와 실제 정지를 가른다
  const loop = await client.result('submit', { commandId: 'inv-I-2', payload: { mode: 'start', prompt: 'MODE=loop', links: { missionId: 'M-1', attemptId: 'A-2', invocationId: 'I-2' } } });
  await waitFor('실행 시작', async () => (await client.result('result', { payload: { runId: loop.runId } })).run.state === 'running');
  const stop = await host.stop(project, loop.runId, 'pause', { commandId: `stop-${loop.runId}-pause`, reason: '시험 정지' });
  assert.equal(stop.requested, true);
  const paused = await waitFor('협력 정지', async () => { const v = await client.result('result', { payload: { runId: loop.runId } }); return v.final && v; });
  assert.equal(paused.run.state, 'paused');

  // 제어권 인계 — 등록된 제어자에게만, 정지 확인 뒤 세대를 올려 넘긴다. 인수 전·이전 소유자의 상태 변경은 거부된다
  const token2 = enable(path, outside, 'm2');
  await bindControl(other, 'p', { cliPath: CLI, controller: 'm2', tokenFile: token2 });
  assert.equal(other.get('control-binding', 'p').owner, false);
  const handed = await requestControlHandover(store, 'p', { cliPath: CLI, to: 'm2', commandId: 'ho-1', waitMs: 20000, pollMs: 200 });
  assert.equal(handed.transferred, true);
  assert.equal(store.get('control-binding', 'p').owner, false);
  const stale = new ControlClient({ cliPath: CLI, projectPath: path, controller: 'm1', tokenFile: token1, generation: 1 });
  await assert.rejects(stale.result('submit', { commandId: 'late-1', payload: { mode: 'start', prompt: 'MODE=complete' } }), e => e.code === 'control-fenced');
  const accepted2 = await acceptControl(other, 'p', { cliPath: CLI, controller: 'm2', tokenFile: token2 });
  assert.equal(accepted2.owner, true); assert.equal(accepted2.generation, 2);
  const newHost = new ControlHost(other, { cliPath: CLI, pollMs: 200 });
  const resumed = await newHost.client(other.need('project', 'p')).result('submit', { commandId: 'inv-I-3', payload: { mode: 'start', prompt: 'MODE=complete', links: { missionId: 'M-2' } } });
  assert.ok(resumed.runId);
  await assert.rejects(stale.result('pause', { commandId: 'late-2', payload: { runId: resumed.runId } }), e => e.code === 'control-fenced');
  await waitFor('새 소유자 실행 종료', async () => (await newHost.client(other.need('project', 'p')).result('result', { payload: { runId: resumed.runId } })).final);
  // 토큰 값은 master 저장소에 남기지 않는다(파일 경로만)
  assert.ok(!JSON.stringify(store.get('control-binding', 'p')).includes(readFileSync(token1, 'utf8').trim()));
});
