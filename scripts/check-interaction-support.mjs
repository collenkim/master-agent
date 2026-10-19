// Read-only hello probes in two isolated repositories. No enable/setup/install or managed-project mutation.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findCodeAgent } from '../packages/code-agent-adapter/discovery.mjs';
import { callOnce, PROTOCOL, PROTOCOL_VERSION } from '../packages/code-agent-adapter/control.mjs';

const cliPath = findCodeAgent(process.argv[2]);
const codeAgentRoot = resolve(dirname(cliPath), '../..');
const handoff = join(codeAgentRoot, 'doc/dashboard-interactions.md');
const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(join(workspace, '.master-agent'), { recursive: true });
const artifacts = mkdtempSync(join(workspace, '.master-agent/interaction-support-'));
let sourceCommit = null, sourceDirty = null;
try { sourceCommit = execFileSync('git', ['-c', `safe.directory=${codeAgentRoot.replaceAll('\\', '/')}`, '-C', codeAgentRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { /* Packaged installations need not have Git metadata. */ }
try { sourceDirty = Boolean(execFileSync('git', ['-c', `safe.directory=${codeAgentRoot.replaceAll('\\', '/')}`, '-C', codeAgentRoot, 'status', '--porcelain'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()); } catch { /* Optional provenance. */ }
const probes = [];
for (const kind of ['empty', 'existing']) {
  const projectPath = join(artifacts, kind); mkdirSync(projectPath);
  execFileSync('git', ['init', '--quiet', projectPath], { stdio: 'pipe' });
  if (kind === 'existing') writeFileSync(join(projectPath, 'README.md'), '# Existing sample service\n');
  const response = await callOnce(cliPath, projectPath, { protocol: PROTOCOL, version: PROTOCOL_VERSION, type: 'hello' });
  const result = response.result;
  probes.push({ kind, ok: response.ok, error: response.error?.code ?? null,
    codeAgent: result?.codeAgent, commands: result?.commands, approvals: result?.approvals, interactions: result?.interactions,
    // Availability is evidence only, not a substitute for the handoff's authenticated response contract.
    handoffPresent: existsSync(handoff) });
}
const evidence = { checkedAt: new Date().toISOString(), cliPath, buildModifiedAt: statSync(cliPath).mtime.toISOString(),
  sourceCommit, sourceDirty, handoff, handoffPresent: existsSync(handoff), probes, fullLifecycleTested: false,
  limitation: 'hello 기능 조회만 수행. 전체 질문·사람 승인·원래 세션 재개 왕복은 확정 인계 API가 필요합니다.', artifacts };
writeFileSync(join(artifacts, 'capabilities.json'), JSON.stringify(evidence, null, 2));
console.log(JSON.stringify(evidence, null, 2));
