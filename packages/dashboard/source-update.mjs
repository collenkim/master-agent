import { mkdtempSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { normalizedPath } from '../catalog/catalog.mjs';
import { DomainError, requireThat } from '../domain/contracts.mjs';
import { childEnv, execFileTree } from '../runner/process.mjs';

const SHOWN_HASH = /^sha256:[0-9a-f]{64}$/;
const RELEASE = /^[a-zA-Z0-9][a-zA-Z0-9.+_-]{0,199}$/;

/** Public CLI only; kill the entire process tree on timeout, including install scripts. */
export async function runUpdateCli(cliPath, args, cwd, onSpawn = () => {}, timeoutMs = args[0] === 'version' ? 15000 : 120000) {
  const env = childEnv({ GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' });
  const js = ['.js', '.mjs', '.cjs'].includes(extname(cliPath).toLowerCase());
  let recordError;
  try {
    const { stdout, stderr } = await execFileTree(js ? process.execPath : cliPath, [...(js ? [cliPath] : []), ...args], {
      cwd, env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: timeoutMs,
      onSpawn(pid) { try { onSpawn(pid); } catch (error) { recordError = error; throw error; } },
    });
    return { code: 0, uncertain: false, stdout, stderr };
  } catch (error) {
    const timedOut = error.code === 'ETIMEDOUT';
    return { code: recordError ? 'spawn-record-failed' : timedOut ? 'timeout' : error.code ?? error.signal ?? 'failed',
      uncertain: Boolean(recordError || timedOut || error.signal || error.killed),
      stdout: error.stdout ?? '', stderr: recordError?.message ?? error.stderr ?? '' };
  }
}

export function updateError(result) {
  const message = String(result.stderr || result.stdout || '').trim();
  if (/^사용법|^usage:/i.test(message)) return new DomainError('source-update-unsupported', '이 code-agent는 설치·적용 화면 확인을 지원하지 않습니다. code-agent를 업데이트하세요.');
  if (result.code === 'timeout') return new DomainError('source-update-timeout', 'code-agent 응답 제한 시간이 지나 하위 프로세스까지 종료했습니다. 설치·적용 상태를 다시 확인하세요.');
  const refused = /^(stale-state|policy-forbids|conflict):\s*(.*)/.exec(message);
  return new DomainError(refused?.[1] ?? 'source-update-failed', refused?.[2] || message.slice(0, 1000) || `code-agent 실행 실패 (${result.code}).`);
}

function response(result) {
  // Older CLIs can return usage with exit code zero.
  if (result.code !== 0 || result.uncertain || /^사용법|^usage:/i.test(String(result.stdout).trim())) throw updateError(result);
  try { return JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1)); }
  catch { throw new DomainError('source-update-failed', 'code-agent 업데이트 응답 JSON이 없습니다.'); }
}
function shown(view) {
  requireThat(Array.isArray(view?.lines) && view.lines.length > 0 && view.lines.every(line => typeof line === 'string') &&
    typeof view.shownHash === 'string' && SHOWN_HASH.test(view.shownHash), 'source-update-failed', 'code-agent 확인 문구·해시가 계약과 다릅니다.');
  return view;
}

export function applicationOutput(result) {
  const view = response({ ...result, code: 0 });
  requireThat(view?.code === result.code && typeof view.text === 'string', 'source-update-failed', 'code-agent 적용 결과가 계약과 다릅니다.');
  return view.text;
}

/** Installation is owned by code-agent. No project cwd, build cache or private release-store access. */
export function createSourceInstaller({ run = runUpdateCli, timeoutMs = 35 * 60000 } = {}) {
  async function installCall(cli, args, timeout) {
    const cwd = mkdtempSync(join(tmpdir(), 'master-agent-install-'));
    try { return response(await run(cli, ['update', '--install-only', ...args, '--json'], cwd, undefined, timeout)); }
    finally { rmdirSync(cwd); }
  }
  return {
    async preview(cli) {
      const view = shown(await installCall(cli, ['--preview'], 120000));
      requireThat(typeof view.canInstall === 'boolean', 'source-update-failed', 'code-agent 설치 가능 여부가 계약과 다릅니다.');
      return view;
    },
    async install(cli, shownHash) {
      requireThat(SHOWN_HASH.test(shownHash), 'invalid-input', '설치 확인 해시가 필요합니다.');
      const result = await installCall(cli, ['--shown-hash', shownHash], timeoutMs);
      requireThat(typeof result?.id === 'string' && RELEASE.test(result.id) && typeof result.commit === 'string' &&
        typeof result.created === 'boolean' && Array.isArray(result.log) && result.log.every(line => typeof line === 'string'),
      'source-update-failed', 'code-agent 설치 결과가 계약과 다릅니다.');
      return result;
    },
    async previewApply(cli, release, cwd) {
      requireThat(RELEASE.test(release), 'invalid-input', '릴리스 ID가 필요합니다.');
      const view = shown(response(await run(cli, ['update', '--release', release, '--preview', '--json'], cwd)));
      requireThat(view.release === release && typeof view.target === 'string' && normalizedPath(view.target) === normalizedPath(cwd),
        'source-update-failed', 'code-agent 적용 대상·릴리스가 일치하지 않습니다.');
      return view;
    },
  };
}
