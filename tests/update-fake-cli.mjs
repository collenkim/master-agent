import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';

// Public update JSON contract fixture, not a code-agent implementation.
const file = process.env.FAKE_UPDATE_STATE, state = JSON.parse(readFileSync(file, 'utf8'));
const args = process.argv.slice(2), cwd = process.cwd();
const marked = Object.keys(process.env).filter(key => /^(CLAUDECODE|CLAUDE_CODE_ENTRYPOINT|CLAUDE_PROJECT_DIR|CODEX_CI|CODEX_SANDBOX|CODEX_SANDBOX_NETWORK_DISABLED|CODEX_THREAD_ID|CODE_AGENT_MASTER_RUN|CODE_AGENT_CROSS|CODE_AGENT_RUNTIME.*|CODE_AGENT_ENTRY.*)$/.test(key));
appendFileSync(file + '.calls', JSON.stringify({ args, cwd, marked }) + '\n');
const stop = (message, code = 1) => { console.error(message); process.exit(code); };
const emit = view => { console.log(JSON.stringify(view)); process.exit(0); };
const id = '2.0.0-abcdef123456';
if (args[0] === 'version') emit({ schema: 'code-agent.version v1', running: { kind: 'bundle', version: '1.0.0', entryPackage: null },
  project: { root: cwd, busy: state.busy?.[cwd] ?? [], applied: state.applied?.[cwd] ?? null, pending: null } });
if (state.legacy) { console.log('사용법: code-agent update'); process.exit(0); }
if (marked.length) stop('policy-forbids: host markers passed');
if (state.refusal) stop(state.refusal);
if (state.timeout) {
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore', windowsHide: true });
  writeFileSync(file + '.pid', String(child.pid));
  setInterval(() => {}, 1000);
} else {
  const installing = args.includes('--install-only'), release = args[args.indexOf('--release') + 1];
  if (!installing && release !== id) stop('conflict: wrong release');
  const lines = installing ? [`설치 문구 <script>window.injected=true</script>`, `판 ${state.revision ?? 1}`]
    : [`대상: ${cwd}`, `릴리스: ${id}`, `판 ${state.revisions?.[cwd] ?? 1}`];
  const shownHash = `sha256:${createHash('sha256').update(JSON.stringify(lines)).digest('hex')}`;
  if (args.includes('--preview')) {
    if (state.malformed) { console.log('not-json'); process.exit(0); }
    emit(installing ? { source: 'fixture', store: 'fixture-store', lines, shownHash, canInstall: !state.blocked, reason: state.blocked ?? null }
      : { target: state.wrongRoot ? 'wrong' : cwd, release: id, lines, shownHash });
  }
  if (args[args.indexOf('--shown-hash') + 1] !== shownHash) stop('stale-state: 확인한 내용이 바뀌었습니다');
  if (installing) {
    state.installed = true; writeFileSync(file, JSON.stringify(state));
    emit({ id, commit: 'abcdef123456', created: true, log: ['fixture install completed'] });
  }
  if (!state.installed) stop('conflict: not installed');
  const failure = state.failures?.[cwd];
  if (failure === 3) { console.log(JSON.stringify({ code: 3, text: 'deferred' })); process.exit(3); }
  if (failure) stop('conflict: fixture apply failure', failure);
  state.applied = { ...state.applied, [cwd]: state.wrongVersion ? 'wrong' : id };
  writeFileSync(file, JSON.stringify(state)); emit({ code: 0, text: 'applied' });
}
