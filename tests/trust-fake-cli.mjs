import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';

/**
 * code-agent `master trust --controller <ID> --preview | --shown-hash <해시>` 의 대시보드 확인 계약을 흉내 내는 시험 대역 — 실제 code-agent 가 아니다.
 * 상태는 FAKE_TRUST_STATE 파일에 둔다. legacy 면 화면 신뢰를 모르는 예전 code-agent 처럼 사용법을 낸다. 호스트 표지가 보이면 거부한다.
 */
const file = process.env.FAKE_TRUST_STATE;
const state = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
const args = process.argv.slice(2);
const marked = process.env.CLAUDECODE === '1' || ['CODEX_CI', 'CODEX_SANDBOX', 'CODEX_THREAD_ID'].some(key => process.env[key] !== undefined);
state.calls = [...(state.calls ?? []), { args, marked, cwd: process.cwd() }];
writeFileSync(file, JSON.stringify(state, null, 2));
const stop = message => { process.stderr.write(`${message}\n`); process.exit(1); };

if (state.legacy || args[0] !== 'master' || args[1] !== 'trust' || args[2] !== '--controller' || !['--preview', '--shown-hash'].includes(args[4])) {
  stop('사용법: code-agent master trust --controller <ID> | trust --list | untrust --controller <ID>');
}
const controller = args[3];
const lines = [`이 PC 에서 대시보드 제어자 ${controller} 를 신뢰합니다.`, `- 개인 키: ${state.keyPath}`, `- 문구 판 ${state.revision ?? 1}`];
const shownHash = `sha256:${createHash('sha256').update(JSON.stringify(lines)).digest('hex')}`;
const reason = state.trusted ? `제어자 ${controller} 는 이미 신뢰합니다(지문 ${state.fingerprint}).` : null;
if (args[4] === '--preview') {
  process.stdout.write(`${JSON.stringify({ controller, trusted: Boolean(state.trusted), fingerprint: state.fingerprint ?? null, canTrust: !reason, reason, keyPath: state.keyPath, lines, shownHash, word: 'trust' })}\n`);
} else {
  if (marked) stop('policy-forbids: 호스트 세션의 셸에서는 대시보드 확인으로 신뢰하지 않습니다');
  if (reason) stop(`conflict: ${reason}`);
  if (args[5] !== shownHash) stop('stale-state: 확인한 뒤 신뢰 내용이 바뀌었습니다');
  mkdirSync(dirname(state.keyPath), { recursive: true });
  writeFileSync(state.keyPath, 'fake key');
  const fingerprint = `sha256:${'c'.repeat(64)}`;
  writeFileSync(file, JSON.stringify({ ...state, trusted: true, fingerprint }, null, 2));
  process.stdout.write(`${JSON.stringify({ controller, fingerprint, keyPath: state.keyPath, createdAt: new Date().toISOString(), channel: 'dashboard' })}\n`);
}
