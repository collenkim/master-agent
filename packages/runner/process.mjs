import { spawn, execFileSync } from 'node:child_process';
import { extname } from 'node:path';
import { requireThat } from '../domain/contracts.mjs';

const HOST_ENV = new Set(['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_PROJECT_DIR', 'CODEX_CI', 'CODEX_SANDBOX',
  'CODEX_SANDBOX_NETWORK_DISABLED', 'CODEX_THREAD_ID', 'CODE_AGENT_MASTER_RUN', 'CODE_AGENT_CROSS']);

export function childEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  for (const key of Object.keys(env)) if (HOST_ENV.has(key.toUpperCase()) || /^CODE_AGENT_(RUNTIME|ENTRY)/i.test(key)) delete env[key];
  return env;
}

/** 직접 시작한 자식 핸들만 사용한다. POSIX 호출자는 detached 프로세스 그룹으로 시작한다. */
export function killTree(child) {
  if (!Number.isInteger(child?.pid) || child.pid <= 0 || child.exitCode !== null || child.signalCode) return false;
  try {
    if (process.platform === 'win32') execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'],
      { shell: false, windowsHide: true, stdio: 'ignore', env: childEnv() });
    else process.kill(-child.pid, 'SIGKILL');
    return true;
  } catch { try { return child.kill('SIGKILL'); } catch { return false; } }
}

/** 시간·출력 제한 때 하위 프로세스를 함께 종료하고 제한된 출력만 보관한다. */
export function execFileTree(file, args, { timeout = 0, maxBuffer = 1024 * 1024, encoding = 'utf8', onSpawn, ...options } = {}) {
  return new Promise((resolve, reject) => {
    let timer, failure;
    // execFile does not forward detached to spawn, so it cannot create a POSIX process group.
    const child = spawn(file, args, { ...options, env: childEnv(options.env), shell: false, windowsHide: true,
      detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    const stop = code => {
      if (failure) return;
      failure = Object.assign(new Error(code), { code, killed: true });
      killTree(child);
    };
    const capture = stream => {
      const chunks = []; let bytes = 0;
      stream.on('data', chunk => {
        if (bytes < maxBuffer) chunks.push(chunk.subarray(0, maxBuffer - bytes));
        bytes += chunk.length;
        if (bytes > maxBuffer) stop('ERR_CHILD_PROCESS_STDIO_MAXBUFFER');
      });
      return () => { const buffer = Buffer.concat(chunks); return encoding && encoding !== 'buffer' ? buffer.toString(encoding) : buffer; };
    };
    const stdout = capture(child.stdout), stderr = capture(child.stderr);
    child.on('error', error => { failure ??= error; clearTimeout(timer); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const output = { stdout: stdout(), stderr: stderr() };
      if (!failure && (code !== 0 || signal)) failure = Object.assign(new Error(`Process exited (${signal ?? code})`),
        { code, signal, killed: child.killed });
      if (failure) reject(Object.assign(failure, output));
      else resolve(output);
    });
    if (timeout > 0) timer = setTimeout(() => stop('ETIMEDOUT'), timeout);
    if (child.pid && onSpawn) try { onSpawn(child.pid); } catch (error) { failure = error; killTree(child); }
  });
}

export function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  // EPERM은 다른 사용자 프로세스 등의 조회 권한 부족이므로 임대 회수나 중복 실행의 근거가 아니다.
  catch (error) { return error.code === 'EPERM'; }
}

export function spawnArgs(cliPath) {
  requireThat(typeof cliPath === 'string' && cliPath.length > 0 &&
    !['.cmd', '.bat', '.ps1', '.sh'].includes(extname(cliPath).toLowerCase()),
  'invalid-cli', '셸 래퍼 대신 실행 파일 또는 JS 진입점을 지정하세요.');
  return ['.js', '.mjs', '.cjs'].includes(extname(cliPath).toLowerCase())
    ? { executable: process.execPath, prefix: [cliPath] }
    : { executable: cliPath, prefix: [] };
}
