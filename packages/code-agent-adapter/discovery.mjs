import { existsSync, readFileSync, realpathSync, statSync, accessSync, constants } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, delimiter, isAbsolute, extname, resolve } from 'node:path';
import { requireThat } from '../domain/contracts.mjs';

/** code-agent 의 키 저장소 자리(storeDir) — CODE_AGENT_HOME 이 있으면 그 자리, 없으면 ~/.code-agent. 신뢰 키·사람 채널 키가 여기 있다 */
export function codeAgentStoreDir({ env = process.env, home = homedir() } = {}) {
  const override = env.CODE_AGENT_HOME;
  return override && override.trim() !== '' ? override : join(home, '.code-agent');
}

function executable(path, platform) {
  try {
    if (!isAbsolute(path) || !statSync(path).isFile()) return null;
    const actual = realpathSync(path), extension = extname(actual).toLowerCase();
    if (['.js', '.mjs', '.cjs', '.exe'].includes(extension)) return actual;
    if (platform !== 'win32' && !extension) { accessSync(actual, constants.X_OK); return actual; }
  } catch { /* Try the next installed entry. */ }
  return null;
}

/** Resolve npm links/shims to the package entry, without executing shell wrappers. */
function packageEntry(root, platform) {
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    if (pkg.name !== 'code-agent') return null;
    const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.['code-agent'];
    return typeof bin === 'string' ? executable(resolve(root, bin), platform) : null;
  } catch { return null; }
}

export function findCodeAgent(explicit, { env = process.env, platform = process.platform, home = homedir(), required = true } = {}) {
  const override = explicit ?? env.CODE_AGENT_CLI;
  if (override) {
    const entry = executable(override, platform);
    requireThat(entry, 'invalid-cli', 'code-agent의 존재하는 절대 JS 또는 실행 파일 경로가 필요합니다. 셸 래퍼는 실행하지 않습니다.');
    return entry;
  }
  const directories = (env.PATH ?? env.Path ?? '').split(delimiter).filter(isAbsolute);
  directories.push(...(platform === 'win32' ? [env.APPDATA && join(env.APPDATA, 'npm')] : [join(home, '.local', 'bin')]).filter(Boolean));
  for (const dir of new Set(directories)) {
    const direct = executable(join(dir, platform === 'win32' ? 'code-agent.exe' : 'code-agent'), platform);
    if (direct) return direct;
    if (['code-agent', 'code-agent.cmd', 'code-agent.ps1'].some(name => existsSync(join(dir, name)))) {
      for (const root of [join(dir, 'node_modules', 'code-agent'), join(dirname(dir), 'lib', 'node_modules', 'code-agent')]) {
        const entry = packageEntry(root, platform);
        if (entry) return entry;
      }
    }
  }
  requireThat(!required, 'code-agent-unavailable', '설치된 code-agent를 찾지 못했습니다. 설치와 PATH를 확인하세요. 별도 빌드는 CODE_AGENT_CLI 또는 --cli로 지정할 수 있습니다.');
  return null;
}
