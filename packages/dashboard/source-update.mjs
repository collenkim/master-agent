import { execFile, execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync, renameSync, realpathSync, rmSync } from 'node:fs';
import { dirname, join, resolve, delimiter, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { normalizedPath } from '../catalog/catalog.mjs';
import { hash, requireThat } from '../domain/contracts.mjs';

export function runSourceCommand(file, args, cwd, timeout = 120000, env = {}) {
  return new Promise(resolveResult => {
    let timer, timedOut = false;
    const child = execFile(file, args, { cwd, windowsHide: true, shell: false, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', ...env } },
    (error, stdout, stderr) => {
      clearTimeout(timer);
      // A killed or signalled child has no exit code; that is never a success.
      resolveResult({ code: timedOut ? 'timeout' : error ? error.code ?? error.signal ?? 'failed' : 0, stdout, stderr });
    });
    timer = setTimeout(() => {
      timedOut = true;
      // npm runs scripts in child shells; stop the whole tree this call started.
      if (process.platform === 'win32' && child.pid) {
        try { execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch { child.kill(); }
      } else child.kill('SIGKILL');
    }, timeout);
  });
}

function npmCli() {
  const candidates = [process.env.npm_execpath, join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
    resolve(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js')];
  for (const path of (process.env.PATH ?? process.env.Path ?? '').split(delimiter)) {
    try { candidates.push(realpathSync(join(path, 'npm'))); } catch { /* next installation */ }
  }
  const found = candidates.find(p => p && /[/\\]npm-cli\.js$/.test(p) && existsSync(p));
  requireThat(found, 'npm-unavailable', 'Node.js와 함께 설치된 npm CLI를 찾지 못했습니다.');
  return found;
}

/** URL credentials stay in memory; neither preview nor stored progress exposes them. */
export const sourceSummary = source => ({ root: source.root, branch: source.branch, remote: source.remote,
  ref: source.ref, head: source.head, dirty: source.dirty });

export function createSourceBuilder({ cacheRoot, run = runSourceCommand } = {}) {
  const git = async (cwd, args) => {
    const result = await run('git', args, cwd);
    requireThat(result.code === 0, 'source-unavailable', 'code-agent Git 설치·브랜치·upstream 설정과 접근 권한을 확인하세요.');
    return result.stdout.trim();
  };
  async function audit(cli) {
    const root = resolve(cli, '../../..');
    requireThat(existsSync(join(root, '.git')) && JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).name === 'code-agent',
      'source-unavailable', '원격 업데이트에는 upstream이 설정된 code-agent Git 소스 설치가 필요합니다. npm·단일 실행 파일은 기존 배포 경로로 갱신하거나 현재 설치본 적용을 선택하세요.');
    requireThat(normalizedPath(await git(root, ['rev-parse', '--show-toplevel'])) === normalizedPath(root), 'source-unavailable', 'code-agent 패키지 루트와 Git 루트가 다릅니다.');
    const branch = await git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    const remote = await git(root, ['config', '--get', `branch.${branch}.remote`]);
    const ref = await git(root, ['config', '--get', `branch.${branch}.merge`]);
    requireThat(remote !== '.' && !remote.startsWith('-') && /^refs\/heads\/[^\r\n]+$/.test(ref), 'source-unavailable', '단일 원격 추적 브랜치가 필요합니다.');
    let url = await git(root, ['remote', 'get-url', remote]);
    requireThat(url && !url.startsWith('-') && !/[\r\n]/.test(url), 'source-unavailable', '원격 저장소 설정을 확인하세요.');
    if (!isAbsolute(url) && !/^[^/\\]+:/.test(url)) url = resolve(root, url);
    const head = await git(root, ['rev-parse', 'HEAD']);
    const dirty = Boolean(await git(root, ['status', '--porcelain', '--untracked-files=normal']));
    const source = { root, branch, remote, ref, url, head, dirty };
    return { ...source, fingerprint: hash(source) };
  }
  async function prepare(expected, { progress = () => {}, stopped = () => false } = {}) {
    requireThat(cacheRoot, 'source-unavailable', '업데이트 빌드 보관 경로가 필요합니다.');
    const current = await audit(join(expected.root, 'dist/agent/cli.js'));
    requireThat(current.fingerprint === expected.fingerprint, 'stale-state', '미리보기 이후 소스·브랜치·upstream 상태가 바뀌었습니다. 다시 조회하세요.');
    // Every build has a unique permanent directory. Only a build that wrote build.json is reused; never an interrupted one.
    const buildRoot = join(resolve(cacheRoot), randomUUID()), root = join(buildRoot, 'node_modules/code-agent');
    mkdirSync(dirname(root), { recursive: true });
    progress({ phase: 'clone', state: 'running', buildRoot });
    const npm = npmCli();
    const clean = output => String(output ?? '').replaceAll(expected.url, '[remote]').replace(/(https?:\/\/)[^\s/@]+@/g, '$1[credentials]@').slice(-6000);
    async function step(phase, file, args, cwd, timeout, env) {
      requireThat(!stopped(), 'update-stopped', '서버 종료로 새 버전 준비를 중단했습니다.');
      progress({ phase, state: 'running' });
      const result = await run(file, args, cwd, timeout, env);
      // Git diagnostics can contain arbitrary configured credential-bearing URLs.
      const output = file === 'git' ? undefined : clean(`${result.stdout ?? ''}\n${result.stderr ?? ''}`);
      progress({ phase, state: result.code === 0 ? 'completed' : 'failed', ...(output ? { output } : {}) });
      const hint = file === 'git' ? /fast-forward|divergent|diverged/i.test(`${result.stdout}\n${result.stderr}`)
        ? '브랜치가 분기되었습니다. 원격 브랜치와 로컬 커밋을 확인하세요.' : 'Git 인증·연결·추적 브랜치를 확인하세요.' : '해당 단계 출력을 확인하세요.';
      requireThat(result.code === 0, 'source-update-failed', result.code === 'timeout' ? `${phase} 단계가 제한 시간을 넘어 중단했습니다. ${hint}`
        : `${phase} 단계 실패 (종료 코드 ${result.code}). ${hint}`);
      return result.stdout;
    }
    // Same entry check code-agent runs before registering a release; it repeats the module-load check when adopting the package.
    async function verify(packageRoot) {
      const help = await step('verify', process.execPath, [join(packageRoot, 'dist/agent/cli.js'), 'help'], packageRoot, 120000, { CODE_AGENT_RUNTIME_SELF: '1' });
      requireThat(help.startsWith('code-agent'), 'invalid-package', '새 빌드의 도움말 출력이 예상과 다릅니다. 프로젝트에 적용하지 않았습니다.');
    }
    function completed(commit) {
      const found = readdirSync(resolve(cacheRoot), { withFileTypes: true }).filter(entry => entry.isDirectory()).flatMap(entry => {
        const dir = join(resolve(cacheRoot), entry.name), pkg = join(dir, 'node_modules/code-agent');
        try {
          const record = JSON.parse(readFileSync(join(dir, 'build.json'), 'utf8'));
          return record.commit === commit && existsSync(join(pkg, 'dist/agent/cli.js')) && existsSync(join(pkg, 'template')) ? [{ dir, pkg, at: String(record.completedAt) }] : [];
        } catch { return []; }
      });
      return found.sort((a, b) => b.at.localeCompare(a.at))[0];
    }
    await step('clone', 'git', ['clone', '--no-local', '--single-branch', '--branch', expected.branch, '--', expected.root, root], buildRoot);
    requireThat(await git(root, ['rev-parse', 'HEAD']) === expected.head, 'stale-state', '사본 생성 중 소스 HEAD가 바뀌었습니다. 다시 조회하세요.');
    await git(root, ['remote', 'set-url', 'origin', expected.url]);
    await step('pull', 'git', ['pull', '--ff-only', 'origin', expected.ref], root, 180000);
    const commit = await git(root, ['rev-parse', 'HEAD']);
    requireThat(commit === await git(root, ['rev-parse', 'FETCH_HEAD']), 'source-diverged', '로컬 전용 커밋 또는 분기 이력이 있습니다. 원격 추적 브랜치를 정리한 뒤 다시 시도하세요.');
    progress({ phase: 'pull', state: 'completed', commit });
    const previous = completed(commit);
    if (previous) {
      // The same commit was already built and verified; this fresh clone is unused, so drop it.
      rmSync(buildRoot, { recursive: true, force: true });
      progress({ phase: 'reuse', state: 'completed', buildRoot: previous.dir });
      await verify(previous.pkg);
      requireThat(!stopped(), 'update-stopped', '서버 종료로 적용 전에 멈췄습니다.');
      progress({ phase: 'validate', state: 'running', commit });
      return { cli: join(previous.pkg, 'dist/agent/cli.js'), commit, buildRoot: previous.dir };
    }
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    requireThat(pkg.name === 'code-agent' && typeof pkg.scripts?.build === 'string' && existsSync(join(root, 'package-lock.json')),
      'invalid-package', '받은 소스에 code-agent 패키지·lockfile·build 명령이 필요합니다.');
    await step('install', process.execPath, [npm, 'ci', '--include=dev', '--no-audit', '--no-fund'], root, 900000);
    await step('build', process.execPath, [npm, 'run', 'build'], root, 900000);
    requireThat(existsSync(join(root, 'dist/agent/cli.js')) && existsSync(join(root, 'template')), 'invalid-package', '빌드 진입점 또는 템플릿이 없습니다.');
    await verify(root);
    requireThat(!stopped(), 'update-stopped', '서버 종료로 적용 전에 멈췄습니다.');
    // Retain Git evidence outside the package. The public templates-only command then
    // adopts this verified npm-shaped snapshot into code-agent's immutable release store.
    renameSync(join(root, '.git'), join(buildRoot, 'git-metadata'));
    writeFileSync(join(buildRoot, 'build.json'), JSON.stringify({ commit, completedAt: new Date().toISOString() }));
    progress({ phase: 'validate', state: 'running', commit });
    return { cli: join(root, 'dist/agent/cli.js'), commit, buildRoot };
  }
  return { audit, prepare };
}
