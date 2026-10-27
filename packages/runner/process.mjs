import { execFile, execFileSync } from 'node:child_process';

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

/** 상태 조회도 시간·출력 제한 때 하위 프로세스를 함께 종료한다. */
export function execFileTree(file, args, { timeout = 0, maxBuffer = 1024 * 1024, onSpawn, ...options } = {}) {
  return new Promise((resolve, reject) => {
    let timer, failure;
    const child = execFile(file, args, { ...options, env: childEnv(options.env), shell: false, windowsHide: true,
      detached: process.platform !== 'win32', maxBuffer: Infinity }, (error, stdout, stderr) => {
      clearTimeout(timer);
      if (failure || error) {
        const result = failure ?? error;
        Object.assign(result, { stdout, stderr });
        reject(result);
      } else resolve({ stdout, stderr });
    });
    const stop = code => {
      if (failure) return;
      failure = Object.assign(new Error(code), { code, killed: true });
      killTree(child);
    };
    if (timeout > 0) timer = setTimeout(() => stop('ETIMEDOUT'), timeout);
    if (child.pid && onSpawn) try { onSpawn(child.pid); } catch (error) { failure = error; killTree(child); }
    for (const stream of [child.stdout, child.stderr]) {
      let bytes = 0;
      stream?.on('data', chunk => { bytes += Buffer.byteLength(chunk); if (bytes > maxBuffer) stop('ERR_CHILD_PROCESS_STDIO_MAXBUFFER'); });
    }
  });
}
