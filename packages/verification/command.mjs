import { randomUUID } from 'node:crypto';
import { runProcess } from '../reasoning/cli-provider.mjs';
import { hash, now } from '../domain/contracts.mjs';
import { sealOf } from './seal.mjs';

/** 정상 프로세스 반환을 검증 요약보다 먼저 보존한다. 반환 없는 intent는 재실행하지 않는다. */
export async function runCheck(store, binding, check, cwd) {
  const record = store.put('command-run', { id: randomUUID(), ...binding, checkId: check.id, commandHash: hash(check), state: 'started', startedAt: now() });
  try {
    const output = await runProcess(check.executable, check.args, { cwd, input: '', timeoutMs: check.timeoutMs, maxBytes: 1024 * 1024, captureExit: true });
    const finished = { ...record, state: 'returned', exitCode: output.exitCode, outputHash: hash(output.stdout), diagnosticHash: hash(output.stderr), finishedAt: now() };
    finished.seal = sealOf(finished); store.put('command-run', finished, record.revision);
    return output;
  } catch (error) {
    const current = store.need('command-run', record.id);
    if (current.state === 'started') {
      current.state = 'unknown'; current.error = error.code ?? 'command-error'; current.finishedAt = now(); current.seal = sealOf(current);
      store.put('command-run', current, current.revision);
    }
    throw error;
  }
}
