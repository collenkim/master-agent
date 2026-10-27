import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync, readFileSync, rmSync, realpathSync, statSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, dirname, basename, delimiter, isAbsolute, extname } from 'node:path';
import { DomainError, requireThat, string } from '../domain/contracts.mjs';
import { childEnv, killTree } from '../runner/process.mjs';

function npmClaudeEntry(directory) {
  if (!['claude', 'claude.cmd', 'claude.ps1'].some(name => existsSync(join(directory, name)))) return null;
  for (const root of [join(directory, 'node_modules', '@anthropic-ai', 'claude-code'),
    join(dirname(directory), 'lib', 'node_modules', '@anthropic-ai', 'claude-code')]) {
    try {
      const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
      if (pkg.name !== '@anthropic-ai/claude-code') continue;
      const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.claude;
      if (typeof bin !== 'string') continue;
      const path = realpathSync(join(root, bin));
      if (['.js', '.mjs', '.cjs'].includes(extname(path).toLowerCase()) && statSync(path).isFile()) return path;
    } catch { /* 다음 설치 후보를 확인한다. */ }
  }
  return null;
}

export function findCli(provider, explicit, { env = process.env, platform = process.platform, home = homedir() } = {}) {
  requireThat(['codex', 'claude'].includes(provider), 'invalid-provider', 'provider는 codex 또는 claude입니다.');
  let candidates = [];
  if (explicit) { requireThat(isAbsolute(explicit), 'invalid-cli', 'AI CLI는 절대 경로로 지정하세요.'); candidates = [explicit]; }
  else {
    const dirs = (env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean);
    candidates = dirs.map(d => join(d, platform === 'win32' ? `${provider}.exe` : provider));
    if (provider === 'claude') {
      candidates.push(join(home, '.local', 'bin', platform === 'win32' ? 'claude.exe' : 'claude'));
      const npmDirs = [...dirs, ...(platform === 'win32' && env.APPDATA ? [join(env.APPDATA, 'npm')] : [])];
      candidates.push(...[...new Set(npmDirs)].map(npmClaudeEntry).filter(Boolean));
    }
    else candidates.push(...dirs.map(d => join(d, 'node_modules', '@openai', 'codex', 'bin', 'codex.js')));
  }
  const file = candidates.find(f => existsSync(f));
  requireThat(file, 'provider-unavailable', `${provider} CLI가 없습니다. --ai-cli로 지정하세요.`);
  const extension = extname(file).toLowerCase();
  requireThat(!['.cmd', '.bat', '.ps1', '.sh'].includes(extension), 'invalid-cli', '셸 래퍼 대신 실행 파일 또는 JS 진입점을 지정하세요.');
  return ['.js', '.cjs', '.mjs'].includes(extension) ? { executable: process.execPath, prefix: [file] } : { executable: file, prefix: [] };
}

export function providerArgs(provider, { schemaPath, outputPath, schema, model }) {
  const args = provider === 'codex' ? [
    'exec', '--sandbox', 'read-only', '--ephemeral', '--ignore-user-config', '--skip-git-repo-check',
    '-c', 'approval_policy="never"', '-c', 'features.shell_tool=false', '-c', 'web_search="disabled"',
    '-c', 'project_doc_max_bytes=0', '--output-schema', schemaPath, '--output-last-message', outputPath, '--color', 'never',
  ] : [
    '--print', '--output-format', 'json', '--json-schema', JSON.stringify(schema),
    '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    '--setting-sources', '', '--settings', '{"disableAllHooks":true}', '--disable-slash-commands', '--no-session-persistence',
  ];
  if (model) { string(model, 'model'); args.push('--model', model); }
  if (provider === 'codex') args.push('-');
  return args;
}

/** prompt는 stdin으로만 전달하고 CLI 로그는 DB/오류 메시지에 복사하지 않는다. */
export function runProcess(executable, args, { cwd, input, timeoutMs = 180000, maxBytes = 2 * 1024 * 1024, captureExit = false }) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: childEnv(), detached: process.platform !== 'win32' });
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    let stdout = '', stderr = '', bytes = 0, failure;
    const stop = code => {
      if (failure) return;
      failure = new DomainError(code, code === 'provider-timeout' ? 'AI 응답 시간이 초과됐습니다.' : 'AI 출력 크기 제한을 넘었습니다.');
      killTree(child);
    };
    const timer = setTimeout(() => stop('provider-timeout'), timeoutMs);
    child.stdout.on('data', data => { bytes += Buffer.byteLength(data); if (bytes > maxBytes) stop('provider-output-limit'); else stdout += data; });
    child.stderr.on('data', data => { bytes += Buffer.byteLength(data); if (bytes > maxBytes) stop('provider-output-limit'); else stderr += data; });
    child.on('error', error => { clearTimeout(timer); reject(new DomainError('provider-start-failed', `AI CLI를 시작하지 못했습니다 (${error.code ?? 'unknown'}).`)); });
    child.on('close', code => {
      clearTimeout(timer);
      if (failure) return reject(failure);
      if (captureExit && Number.isInteger(code)) return resolve({ stdout, stderr, exitCode: code });
      if (code !== 0) {
        const category = /log.?in|authenticat|not logged|401/i.test(stderr + stdout) ? 'provider-auth-required' : 'provider-exit';
        return reject(new DomainError(category, `AI CLI가 결과를 반환하지 못했습니다 (종료 코드 ${code}). 인증·연결·CLI 버전을 확인하세요.`));
      }
      resolve({ stdout });
    });
    child.stdin.on('error', () => {}); // 조기 종료의 EPIPE는 close/error 결과로 처리한다.
    child.stdin.end(input, 'utf8');
  });
}

export class CliProvider {
  constructor({ provider, cliPath, model, timeoutMs = 180000 }) {
    requireThat(Number.isInteger(timeoutMs) && timeoutMs > 0, 'invalid-input', 'timeoutMs는 양의 정수입니다.');
    this.command = findCli(provider, cliPath); this.name = provider; this.model = model ?? 'cli-default'; this.timeoutMs = timeoutMs;
  }
  async generate({ prompt, schema }) {
    const parent = realpathSync(tmpdir()), root = realpathSync(mkdtempSync(join(parent, 'master-agent-planner-')));
    try {
      const schemaPath = join(root, 'schema.json'), outputPath = join(root, 'answer.json');
      writeFileSync(schemaPath, JSON.stringify(schema));
      const args = providerArgs(this.name, { schemaPath, outputPath, schema, model: this.model === 'cli-default' ? undefined : this.model });
      const response = await runProcess(this.command.executable, [...this.command.prefix, ...args], { cwd: root, input: prompt, timeoutMs: this.timeoutMs });
      let data;
      try {
        if (this.name === 'codex') {
          const raw = readFileSync(outputPath, 'utf8');
          requireThat(Buffer.byteLength(raw) <= 2 * 1024 * 1024, 'provider-output-limit', 'AI 결과 크기 제한 초과');
          data = JSON.parse(raw);
        } else {
          const envelope = JSON.parse(response.stdout);
          requireThat(envelope.is_error !== true && envelope.subtype === 'success', 'provider-response-error', 'AI 응답이 성공 상태가 아닙니다.');
          data = envelope.structured_output;
          requireThat(data && typeof data === 'object', 'provider-invalid-json', 'AI 구조화 결과가 없습니다.');
        }
      } catch (error) {
        if (error instanceof DomainError) throw error;
        throw new DomainError('provider-invalid-json', 'AI가 유효한 구조화 JSON을 반환하지 않았습니다.');
      }
      return { data, provider: this.name, model: this.model };
    } finally {
      requireThat(dirname(root) === parent && basename(root).startsWith('master-agent-planner-'), 'invalid-temp-path', '임시 경로 경계 오류');
      rmSync(root, { recursive: true, force: true });
    }
  }
}
