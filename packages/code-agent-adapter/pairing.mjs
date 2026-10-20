import { createPrivateKey, sign } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { canonicalInteraction } from './interactions.mjs';
import { codeAgentStoreDir } from './discovery.mjs';
import { requireThat } from '../domain/contracts.mjs';

/** 대시보드가 code-agent 에 쓰는 제어자 이름 — PC 신뢰(code-agent master trust)도 이 이름으로 한다 */
export const DASHBOARD_CONTROLLER = 'dashboard';
const PAIR_DOMAIN = 'code-agent.master-pair.v1';
const RENEW_MS = 7 * 24 * 3600 * 1000;
export const validController = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value);
const text = (value, limit = 500) => typeof value === 'string' ? value.slice(0, limit) : null;
const legacyGuidance = projectId => `프로젝트 폴더에서 code-agent master enable --controller dashboard --token-out <저장소 밖 토큰 파일>을 직접 실행하세요. 기존 연결이 있으면 enable을 반복하지 마세요.\n개발 호스트는 code-agent execution claude|codex 또는 both --main claude|codex로 선택합니다. 실행 파일·모델·권한을 지정하려면 enable에 --host <호스트 설정 JSON>을 사용하세요. 미선택 상태는 등록된 기본 호스트를 따르며 설치된 파일만으로 Codex를 선택하지 않습니다.\nmaster-agent project control ${projectId} --controller <기존 제어자 ID> --token-file <토큰 파일 절대경로> --db <현재 대시보드 DB>\n질문·승인을 웹에서 처리하려면 code-agent master human enable --controller <제어자 ID>도 실행하세요. 토큰 내용은 답변에 입력하지 마세요.`;

export const trustStoreDir = codeAgentStoreDir;

/** code-agent master trust 가 만든 PC 신뢰 개인 키의 경로. 링크·큰 파일은 쓰지 않는다. 키 내용은 서명할 때만 읽는다 */
export function findTrustKey(controller, directory = join(codeAgentStoreDir(), 'master-trust')) {
  if (!validController(controller) || !isAbsolute(directory)) return null;
  try {
    if (lstatSync(directory).isSymbolicLink()) return null;
    const path = join(directory, `${controller}.pem`), stat = lstatSync(path);
    return stat.isFile() && !stat.isSymbolicLink() && stat.size < 16384 ? path : null;
  } catch { return null; }
}

export const pairingSupported = hello => hello?.pairing?.supported === true && hello.pairing.version === 1 &&
  (hello.pairing.domain === undefined || hello.pairing.domain === PAIR_DOMAIN) && (hello.pairing.signature === undefined || hello.pairing.signature === 'Ed25519');

/** 토큰 없이 받은 hello 에서 연결 판단에 쓰는 값만 남긴다 */
export function controlProbe(hello) {
  const ownership = hello?.ownership, managed = hello?.managedHost;
  const execution = managed?.execution;
  return {
    codeAgentVersion: text(hello?.codeAgent?.version, 100),
    enabled: hello?.project?.enabled === true,
    owner: validController(ownership?.controller) ? ownership.controller : null,
    generation: Number.isInteger(ownership?.generation) ? ownership.generation : null,
    handover: Boolean(ownership?.handover),
    pairing: pairingSupported(hello) ? { supported: true, version: 1,
      trustedControllers: (Array.isArray(hello.pairing.trustedControllers) ? hello.pairing.trustedControllers : []).filter(validController).slice(0, 32) } : { supported: false },
    managedHost: managed && typeof managed === 'object' ? {
      selected: text(managed.selected, 32), source: text(managed.source, 32),
      installedHosts: (Array.isArray(managed.installedHosts) ? managed.installedHosts : []).filter(h => typeof h === 'string').slice(0, 8).map(h => h.slice(0, 32)),
      execution: execution && typeof execution === 'object' ? { mode: text(execution.mode, 16), main: text(execution.main, 16) } : text(execution, 64),
      ready: typeof managed.ready === 'boolean' ? managed.ready : null,
      problems: (Array.isArray(managed.problems) ? managed.problems : []).slice(0, 20).map(p => ({ code: text(p?.code, 64) ?? 'unknown', message: text(p?.message) ?? '' })),
    } : null,
  };
}

/** 선택될 개발 호스트가 준비되지 않았다고 code-agent 가 알렸을 때만 문제로 본다(알리지 않으면 판단하지 않는다) */
export function hostReadinessIssue(probe) {
  const host = probe?.managedHost;
  if (host?.ready !== false) return null;
  const problems = host.problems.map(p => p.message || p.code).filter(Boolean);
  return { code: 'host-not-ready', message: `선택될 개발 호스트(${host.selected ?? '미확인'})가 이 프로젝트에서 실행 준비되지 않았습니다.${problems.length ? ` ${problems.join(' / ')}` : ''}`,
    guidance: '프로젝트에서 code-agent init으로 선택 호스트의 실행 절차·hook을 설치하거나 code-agent execution claude|codex로 설치된 호스트를 고르세요. Codex는 프로젝트·hook 신뢰도 확인하세요. 자동 설치·우회는 하지 않습니다.' };
}

/**
 * 프로젝트 카드와 준비 점검이 함께 쓰는 연결 상태. 상태를 보여 줄 뿐 페어링하지 않는다 — 연결은 사람이 화면·터미널에서 확인할 때만 한다.
 * canPair 는 대시보드가 PC 신뢰 키로 연결(또는 갱신)할 수 있는지다. 연결은 승인 권한이 아니다.
 */
export function connectionState({ projectId, probe, binding, controller = DASHBOARD_CONTROLLER, keyAvailable = false, installed = true, now = Date.now() }) {
  const listed = Boolean(probe?.pairing?.supported && probe.pairing.trustedControllers.includes(controller));
  const trusted = listed && keyAvailable;
  const trust = `code-agent master trust --controller ${controller}`;
  const handover = '다른 제어자가 소유 중입니다. 그 제어자에서 project handover로 넘기고 이 DB에서 project accept로 인수하세요. 강제로 빼앗지 않습니다.';
  if (!installed) return { state: 'not-installed', code: 'host-not-installed', canPair: false, message: 'code-agent가 설치되지 않은 프로젝트입니다.', guidance: '프로젝트에서 code-agent init과 doctor로 설치를 확인하세요.' };
  if (binding) {
    const expiresAt = binding.pairing?.humanChannel?.expiresAt ?? null, left = expiresAt ? Date.parse(expiresAt) - now : null;
    const base = { controller: binding.controller, owner: binding.owner, expiresAt, boundAt: binding.boundAt ?? null };
    if (!binding.owner) return { ...base, state: 'observer', code: 'control-not-owner', canPair: false, message: '관찰자로 등록된 연결입니다(소유자 아님).', guidance: handover };
    if (probe && !(probe.owner === binding.controller && probe.generation === binding.generation && !probe.handover)) {
      const other = probe.handover || (probe.owner && probe.owner !== binding.controller);
      return { ...base, state: 'stale', code: other ? 'control-owned-by-other' : 'control-not-owner', canPair: !other && trusted && binding.controller === controller, outcome: probe.enabled ? 'rotated' : 'enabled',
        message: other ? `code-agent 제어권이 ${probe.owner ?? '다른 제어자'}에게 있습니다.` : 'code-agent의 연동 상태·세대가 저장된 연결과 다릅니다.',
        guidance: other ? handover : trusted ? '다시 연결로 새 토큰을 발급해 이 DB의 연결을 갱신하세요.' : `PC 신뢰(${trust}) 후 다시 연결하거나 project control로 다시 등록하세요.` };
    }
    const renewal = left !== null && left < RENEW_MS;
    return { ...base, state: 'connected', code: null, canPair: renewal && trusted && binding.controller === controller, outcome: 'rotated', renewal, expired: left !== null && left <= 0, verified: Boolean(probe),
      message: left !== null && left <= 0 ? '사람 응답 채널이 만료되었습니다.' : renewal ? '사람 응답 채널 만료가 7일 안에 다가옵니다.' : '연결됨', guidance: renewal ? '다시 연결로 토큰과 사람 응답 채널을 갱신하세요.' : '' };
  }
  if (!probe) return { state: 'unknown', code: 'control-not-bound', canPair: false, message: 'master 제어 연결이 없습니다.', guidance: legacyGuidance(projectId) };
  if (probe.handover || probe.enabled && probe.owner && probe.owner !== controller) {
    return { state: 'owned-by-other', code: 'control-owned-by-other', canPair: false, owner: probe.owner,
      message: `code-agent 연동이 켜져 있고 제어자 ${probe.owner ?? '(인계 중)'}가 소유 중입니다. 이 DB에는 연결이 없습니다.`, guidance: handover };
  }
  if (probe.enabled) {
    return { state: 'enabled-unbound', code: 'control-enabled-unbound', canPair: trusted, outcome: 'rotated', owner: probe.owner,
      message: 'code-agent 연동은 켜져 있지만 이 대시보드 DB에 연결이 등록되지 않았습니다.',
      guidance: trusted ? '제어 연결을 누르면 토큰을 새로 발급해 이 DB에 등록합니다. 다른 DB가 같은 제어자로 쓰고 있었다면 그 연결은 더 이상 쓰지 못합니다.'
        : `기존 토큰 파일로 master-agent project control ${projectId} --controller ${probe.owner ?? '<제어자 ID>'} --token-file <토큰 파일 절대경로> --db <현재 대시보드 DB>를 실행하세요.${probe.pairing.supported ? ` 또는 터미널에서 ${trust}로 PC를 신뢰한 뒤 대시보드에서 연결하세요.` : ''}` };
  }
  if (!probe.pairing.supported) return { state: 'legacy', code: 'control-not-bound', canPair: false, message: 'master 제어 연결이 없습니다. 이 code-agent는 대시보드 연결(페어링)을 지원하지 않습니다.', guidance: legacyGuidance(projectId) };
  if (!trusted) return { state: 'trust-missing', code: 'control-trust-missing', canPair: false, command: trust,
    message: listed ? 'code-agent는 대시보드를 신뢰하지만 이 대시보드 서버 계정에서 PC 신뢰 키를 찾지 못했습니다.' : '이 PC가 대시보드 제어자를 아직 신뢰하지 않습니다.',
    guidance: `사람이 터미널에서 한 번 ${trust}를 실행하세요(확인 단어 trust). PC당 한 번이며 이후 프로젝트는 대시보드의 제어 연결로 연결합니다.${listed ? ' 대시보드 서버와 같은 계정·CODE_AGENT_HOME인지 확인하세요.' : ''}` };
  return { state: 'pairing-available', code: 'control-pairing-available', canPair: true, outcome: 'enabled',
    message: 'master 제어 연결이 없습니다. 이 PC는 대시보드 제어자를 신뢰하므로 화면에서 바로 연결할 수 있습니다.',
    guidance: '프로젝트 카드의 제어 연결 또는 공통 요청함의 "제어 연결 후 기존 요청 이어 실행"을 선택하고 확인 화면에서 연결하세요. 연결은 승인 권한이 아닙니다.' };
}

/** 서명 대상 — code-agent doc/master-control.md 의 pair 계약 */
export function pairMessage({ challenge, controller, commandId, approval }) {
  return canonicalInteraction({ domain: PAIR_DOMAIN, challengeId: challenge.challengeId, nonce: challenge.nonce, projectRoot: challenge.projectRoot, controller, commandId, approval });
}

/** 사람이 화면·터미널에서 확인한 제출에서만 부른다. 개인 키는 이 순간에만 읽고 어디에도 남기지 않는다 */
export function signPairing({ challenge, controller, commandId, approval, keyPath }) {
  requireThat(keyPath, 'control-trust-missing', `PC 신뢰 키가 필요합니다. 터미널에서 code-agent master trust --controller ${controller}를 실행하세요.`);
  const privateKey = createPrivateKey(readFileSync(keyPath));
  requireThat(privateKey.asymmetricKeyType === 'ed25519', 'control-trust-missing', 'PC 신뢰 키 형식이 다릅니다(Ed25519).');
  const signature = sign(null, Buffer.from(pairMessage({ challenge, controller, commandId, approval })), privateKey).toString('base64');
  return { commandId, payload: { challengeId: challenge.challengeId, controller, approval, signature } };
}
