import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';

// 격리 시험 전용 code-agent master call 대역. 네트워크·실제 code-agent를 호출하지 않는다.
const file = join(dirname(process.cwd()), 'branch-transport.json');
const state = JSON.parse(readFileSync(file, 'utf8')), request = JSON.parse(readFileSync(0, 'utf8'));
state.calls.push({ type: request.type, commandId: request.commandId, payload: request.payload });
let result;
if (request.type === 'hello') result = { commands: { mutating: ['task-branch'] } };
else if (request.type === 'task-branch') {
  result = state.commands[request.commandId];
  if (!result) {
    const { taskNumber, commit } = request.payload;
    execFileSync('git', ['update-ref', `refs/heads/task/${taskNumber}`, commit, '0'.repeat(40)], { stdio: 'pipe', windowsHide: true });
    result = { branch: `task/${taskNumber}`, commit }; state.commands[request.commandId] = result; state.applied++;
  }
  if (state.drop > 0) { state.drop--; writeFileSync(file, JSON.stringify(state)); process.exit(0); }
} else throw new Error(`지원하지 않는 시험 요청: ${request.type}`);
writeFileSync(file, JSON.stringify(state));
process.stdout.write(JSON.stringify({ protocol: 'code-agent.master', version: 1, type: request.type, commandId: request.commandId, ok: true, result }) + '\n');
