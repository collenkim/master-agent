import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { createPublicKey, randomBytes, randomUUID, verify } from 'node:crypto';

/**
 * code-agent `master call` 의 페어링 계약(hello · pair.challenge · pair · heartbeat)을 흉내 내는 시험 대역 — 실제 code-agent 가 아니다.
 * 상태는 프로젝트 폴더 옆 `<폴더 이름>.fake-code-agent.json` 에 둔다. drop 이 남아 있으면 pair 를 적용·기록한 뒤 응답 없이 끝난다(응답 유실).
 */
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().filter(k => value[k] !== undefined).map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`
  : JSON.stringify(value);
const root = realpathSync(process.cwd());
const file = join(dirname(root), `${basename(root)}.fake-code-agent.json`);
const state = JSON.parse(readFileSync(file, 'utf8'));
const request = JSON.parse(readFileSync(0, 'utf8'));
state.calls = [...(state.calls ?? []), request.type];
const save = () => writeFileSync(file, JSON.stringify(state, null, 2));
const reply = (ok, body) => { save(); process.stdout.write(`${JSON.stringify({ protocol: 'code-agent.master', version: 1, ok, ...(ok ? { result: body } : { error: body }) })}\n`); };
const fail = (code, message) => reply(false, { code, message });
const lost = () => { if (!(state.drop > 0)) return false; state.drop--; save(); return true; };

if (request.type === 'hello') {
  reply(true, { codeAgent: { version: 'fake', stateSchema: 10 }, versions: [1], hosts: [{ kind: 'claude', supported: true }],
    project: { enabled: state.enabled === true, projectId: 'fake-project' },
    ownership: state.enabled ? { controller: state.owner, generation: state.generation, handover: null } : null,
    controllers: state.enabled ? [state.owner] : [],
    ...(state.pairing === false ? {} : { pairing: { supported: true, version: 1, trustedControllers: Object.keys(state.trusted ?? {}) } }),
    managedHost: state.managedHost ?? { selected: 'claude', source: 'execution', installedHosts: ['claude'], execution: { mode: 'claude' }, ready: true, problems: [] },
    commands: { read: ['heartbeat'], mutating: ['pair'] } });
} else if (request.type === 'pair.challenge') {
  const controller = request.payload?.controller;
  if (!state.trusted?.[controller]) fail('unauthorized', '신뢰하지 않은 제어자입니다.');
  else {
    const challenge = { challengeId: randomUUID(), nonce: randomBytes(16).toString('hex'), projectRoot: state.reportRoot ?? root, controller,
      expiresAt: new Date(Date.now() + 300000).toISOString(), project: { enabled: state.enabled === true, owner: state.enabled ? state.owner : null, handover: false } };
    state.challenges = { ...(state.challenges ?? {}), [challenge.challengeId]: { ...challenge, used: false } };
    reply(true, challenge);
  }
} else if (request.type === 'pair') {
  const recorded = state.commands?.[request.commandId];
  const { challengeId, controller, approval, signature } = request.payload ?? {};
  const challenge = state.challenges?.[challengeId];
  const signatureBytes = Buffer.from(signature ?? '', 'base64');
  if (recorded) { if (!lost()) reply(recorded.ok, recorded.ok ? recorded.result : recorded.error); }
  else if (!approval || Object.keys(approval).sort().join() !== 'actor,approvedAt,shownHash' || !/^sha256:[0-9a-f]{64}$/.test(approval.shownHash) ||
    !(Math.abs(Date.parse(approval.approvedAt) - Date.now()) < 120000)) fail('invalid-request', 'approval 은 { actor, approvedAt, shownHash: sha256:<hex 64> } 입니다.');
  else if (signatureBytes.length !== 64) fail('unauthorized', '서명 길이가 다릅니다.');
  else if (!challenge || challenge.used || challenge.controller !== controller || Date.parse(challenge.expiresAt) < Date.now()) fail('stale-state', '확인 값이 없거나 이미 썼습니다.');
  else if (!verify(null, Buffer.from(canonical({ domain: 'code-agent.master-pair.v1', challengeId, nonce: challenge.nonce, projectRoot: challenge.projectRoot,
    controller, commandId: request.commandId, approval })), createPublicKey(state.trusted[controller]), signatureBytes)) fail('unauthorized', '서명이 맞지 않습니다.');
  else if (state.enabled && state.owner && state.owner !== controller) fail('fenced', '다른 제어자가 소유 중입니다.');
  else {
    challenge.used = true;
    const outcome = state.enabled ? 'rotated' : 'enabled';
    Object.assign(state, { enabled: true, owner: controller, generation: (state.generation ?? 0) + 1, token: randomBytes(24).toString('hex'), applied: (state.applied ?? 0) + 1 });
    mkdirSync(state.tokenDir, { recursive: true });
    const tokenFile = join(state.tokenDir, `${controller}.token`);
    writeFileSync(tokenFile, state.token);
    const result = { outcome, projectId: 'fake-project', controller, generation: state.generation, owner: true, tokenFile: state.tokenFileOverride ?? tokenFile,
      humanChannel: { channelId: randomUUID(), expiresAt: new Date(Date.now() + 30 * 86400000).toISOString() } };
    state.commands = { ...(state.commands ?? {}), [request.commandId]: { ok: true, result } };
    if (!lost()) reply(true, result);
  }
} else if (request.type === 'heartbeat') {
  if (request.controller !== state.owner || request.token !== state.token) fail('unauthorized', '토큰이 맞지 않습니다.');
  else reply(true, { events: { logId: 'fake-log', latestSeq: 0 } });
} else fail('unsupported', `지원하지 않는 요청입니다: ${request.type}`);
