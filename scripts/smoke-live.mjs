import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import assert from 'node:assert/strict';
import { Store } from '../packages/storage/store.mjs';
import { Engine } from '../packages/orchestrator/engine.mjs';
import { LiveExecution } from '../packages/orchestrator/live.mjs';
import { ClaudeHost } from '../packages/runner/claude-host.mjs';

const { values } = parseArgs({ options: { cli: { type: 'string' }, 'host-cli': { type: 'string' }, 'allow-code-agent-cli': { type: 'boolean' } } });
assert.ok(values.cli, '--cli <code-agent CLI JS 절대 경로>');
const root = resolve('.master-agent', `live-smoke-${randomUUID()}`), project = join(root, 'project');
mkdirSync(project, { recursive: true });
execFileSync('git', ['init', '--quiet', project], { stdio: 'pipe' });
execFileSync(process.execPath, [resolve(values.cli), 'init', '--host', 'claude', '--cli', resolve(values.cli)], { cwd: project, stdio: 'pipe' });
if (values['allow-code-agent-cli']) {
  const cli = resolve(values.cli).replaceAll('\\', '/');
  // 이 격리 시험의 code-agent CLI 도구 실행만 허용한다. hooks·사람 동의는 유지한다.
  writeFileSync(join(project, '.claude', 'settings.local.json'), JSON.stringify({ permissions: { allow: [
    `Bash(node ${cli} *)`, `PowerShell(node ${cli} *)`, 'Read', 'Glob', 'Grep',
  ] } }, null, 2));
}
// 미도입 프로젝트에서 접수 전제 부족을 우회하지 않는 실제 호스트 연결 시험이다.
writeFileSync(join(project, 'subtotal.mjs'), 'export const subtotal = (price, quantity) => price * quantity;\n');
const sourceBefore = readFileSync(join(project, 'subtotal.mjs'), 'utf8');
const store = new Store(join(root, 'state.db'));
try {
  const engine = new Engine(store), host = new ClaudeHost({ cliPath: resolve(values.cli), hostPath: values['host-cli'], timeoutMs: 180000 });
  const p = engine.catalog.register({ id: 'invoice', name: '실제 호스트 접수 경계 시험', path: project, domains: ['invoice'],
    capabilities: ['code-agent:claude'], constraints: ['도입·승인이 없으면 구현 금지'], currentPlans: [], references: ['smoke:invoice'] });
  let mission = engine.create({ requestKey: 'live-smoke', mode: 'live', goal: 'subtotal의 음수 입력을 거부하도록 개선한다. 프로젝트 도입·요구 확정·계획 승인 전에는 구현하지 않는다.',
    scope: { projectIds: [p.id], groupIds: [] }, criteria: [{ id: 'negative', description: '음수 입력을 거부한다.' }] });
  const base = { projectId: p.id, domain: 'invoice', rationale: '합성 계산 함수의 입력 검증', references: p.references, criteria: ['negative'],
    exclusions: ['승인 우회'], requiredCapabilities: ['code-agent:claude'], verification: '음수 입력 검증 테스트' };
  mission = engine.plan(mission.id, { schemaVersion: 1, summary: '실제 호스트 접수 경계 시험의 고정 계획', unresolved: [], tasks: [
    { ...base, id: 'implement', kind: 'implementation', goal: mission.goal, dependsOn: [], allowedChanges: ['subtotal.mjs'], outputs: ['change'] },
    { ...base, id: 'verify', kind: 'verification', goal: '음수 입력 거부 검증', dependsOn: ['implement'], allowedChanges: [], outputs: ['report'] },
  ] }, mission.revision);
  const state = await host.inspect(p);
  console.log(JSON.stringify({ started: true, root, expectedState: state.stateVersion }));
  const result = await new LiveExecution(store).dispatch(mission.id, 'implement', host, { expectedRevision: mission.revision, expectedState: state.stateVersion });
  const turn = result.attempts[0].turns[0];
  const report = { missionId: result.id, state: result.state, taskState: result.tasks[0].state, hostReturned: Boolean(turn.result),
    sessionId: turn.result?.sessionId ?? null, error: turn.error, remoteResume: turn.state?.resume ?? null, permissionDenials: turn.result?.permissionDenials ?? [],
    hostSummary: turn.result?.summary ?? null, scopedCliPermission: Boolean(values['allow-code-agent-cli']), sourceUnchanged: readFileSync(join(project, 'subtotal.mjs'), 'utf8') === sourceBefore,
    noFalseCompletion: result.state !== 'succeeded' && result.evidence.length === 0,
    scope: '실제 CLI 설치·호스트 접수·관측 경계. 승인 이후 코드 수정과 완료 검증은 포함하지 않는다.', database: join(root, 'state.db') };
  writeFileSync(join(root, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  assert.equal(report.hostReturned, true, '실제 호스트 응답 미확인');
  assert.equal(report.sourceUnchanged, true); assert.equal(report.noFalseCompletion, true);
} finally { store.close(); }
