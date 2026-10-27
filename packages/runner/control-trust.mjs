import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { extname } from 'node:path';
import { DASHBOARD_CONTROLLER, validController } from '../code-agent-adapter/pairing.mjs';
import { DomainError, requireThat } from '../domain/contracts.mjs';
import { childEnv, killTree } from './process.mjs';

const SHOWN_HASH = /^sha256:[0-9a-f]{64}$/;
const REFUSALS = { 'stale-state': 'stale-state', conflict: 'control-trust-exists', 'policy-forbids': 'control-trust-refused' };
let running = null;

function unsupported(controller) {
  return new DomainError('control-trust-unsupported', `이 대시보드가 쓰는 code-agent는 화면에서 PC 신뢰를 지원하지 않습니다. code-agent를 업데이트하거나 터미널에서 code-agent master trust --controller ${controller}를 실행하세요.`);
}

/** code-agent master trust 한 번 — JSON 한 줄을 받는다. 거부는 code-agent 의 `코드: 사유` 를 대시보드 오류 코드로 옮긴다 */
function runTrust(cliPath, controller, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const env = childEnv();
    const js = ['.js', '.mjs', '.cjs'].includes(extname(cliPath).toLowerCase());
    const child = spawn(js ? process.execPath : cliPath, [...(js ? [cliPath] : []), 'master', 'trust', '--controller', controller, ...args],
      { cwd: homedir(), shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32', env });
    let stdout = '', stderr = '', done = false;
    const fail = error => { if (!done) { done = true; reject(error); } };
    const timer = setTimeout(() => { killTree(child); fail(new DomainError('control-unavailable', 'code-agent PC 신뢰 응답 시간이 지났습니다.')); }, timeoutMs);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', data => { stdout += data.slice(0, 256 * 1024); });
    child.stderr.on('data', data => { stderr += data.slice(0, 4000); });
    child.on('error', error => { clearTimeout(timer); fail(new DomainError('control-unavailable', `code-agent를 시작하지 못했습니다(${error.code ?? 'unknown'}).`)); });
    child.on('close', code => {
      clearTimeout(timer);
      if (done) return;
      if (code !== 0) {
        const message = stderr.trim().split(/\r?\n/)[0] ?? '', refused = /^([a-z-]+): (.*)$/.exec(message);
        if (/^사용법/.test(message)) return fail(unsupported(controller));
        return fail(refused && REFUSALS[refused[1]] ? new DomainError(REFUSALS[refused[1]], refused[2]) : new DomainError('control-trust-failed', message.slice(0, 500) || `code-agent가 ${code}로 끝났습니다.`));
      }
      let parsed;
      try { parsed = JSON.parse(stdout.trim().split(/\r?\n/).at(-1)); } catch { return fail(new DomainError('control-trust-failed', 'code-agent PC 신뢰 응답 JSON이 없습니다.')); }
      done = true; resolve(parsed);
    });
  });
}

/** 확인 화면 내용 — code-agent 가 정한 문구와 그 해시를 그대로 보인다. 아무것도 쓰지 않는다 */
export async function trustPreview({ cliPath, controller = DASHBOARD_CONTROLLER, timeoutMs = 10000 } = {}) {
  requireThat(validController(controller), 'invalid-input', '제어자 이름 형식이 잘못됐습니다.');
  const preview = await runTrust(cliPath, controller, ['--preview'], timeoutMs);
  requireThat(preview?.controller === controller && Array.isArray(preview.lines) && preview.lines.every(line => typeof line === 'string') &&
    typeof preview.canTrust === 'boolean' && typeof preview.shownHash === 'string' && SHOWN_HASH.test(preview.shownHash) && preview.word === 'trust',
    'control-trust-failed', 'code-agent PC 신뢰 확인 내용이 계약과 다릅니다.');
  return { controller, canTrust: preview.canTrust, trusted: preview.trusted === true, fingerprint: typeof preview.fingerprint === 'string' ? preview.fingerprint : null,
    reason: typeof preview.reason === 'string' ? preview.reason : null, lines: preview.lines.map(line => line.slice(0, 1000)).slice(0, 20), shownHash: preview.shownHash, word: 'trust' };
}

/**
 * 사람이 확인 화면에서 확인 단어를 입력한 PC 신뢰 한 건. 보인 내용의 해시가 code-agent 의 지금 내용과 같아야 code-agent 가 키를 만든다.
 * 요청 실행기·AI 계획·복구·백그라운드 경로에서는 부르지 않는다. 개인 키는 code-agent 키 저장소에만 있고 화면·DB에 남기지 않는다.
 */
export async function trustDashboard({ cliPath, controller = DASHBOARD_CONTROLLER, shownHash, word, timeoutMs = 15000 } = {}) {
  requireThat(validController(controller), 'invalid-input', '제어자 이름 형식이 잘못됐습니다.');
  requireThat(word === 'trust', 'invalid-input', '확인 단어 trust를 그대로 입력해야 신뢰합니다.');
  requireThat(typeof shownHash === 'string' && SHOWN_HASH.test(shownHash), 'invalid-input', '확인한 내용의 해시가 필요합니다.');
  requireThat(!running, 'request-busy', 'PC 신뢰를 등록하고 있습니다. 결과를 확인한 뒤 다시 시도하세요.');
  running = runTrust(cliPath, controller, ['--shown-hash', shownHash], timeoutMs);
  try {
    const result = await running;
    requireThat(result?.controller === controller && typeof result.fingerprint === 'string' && /^sha256:[0-9a-f]{64}$/.test(result.fingerprint) && result.channel === 'dashboard',
      'control-trust-failed', 'code-agent PC 신뢰 결과가 계약과 다릅니다.');
    return { controller, fingerprint: result.fingerprint, createdAt: typeof result.createdAt === 'string' ? result.createdAt : null, channel: 'dashboard' };
  } finally { running = null; }
}
