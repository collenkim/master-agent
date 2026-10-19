import { createPrivateKey, sign } from 'node:crypto';
import { readFileSync, readdirSync, lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ControlClient } from './control.mjs';
import { requireThat } from '../domain/contracts.mjs';

export function canonicalInteraction(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalInteraction).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().filter(k => value[k] !== undefined).map(k => `${JSON.stringify(k)}:${canonicalInteraction(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
export function interactionApiSupported(hello) {
  return hello.codeAgent?.stateSchema >= 7 && hello.interactions?.schemaVersion === 1 && hello.interactions.humanChannel === 'dashboard-human' &&
    hello.interactions.signature === 'Ed25519' && ['interactions', 'interaction', 'interaction.result'].every(c => hello.commands?.read?.includes(c)) &&
    hello.commands?.mutating?.includes('interaction.respond');
}
export const pendingHumanResponse = (store, projectId) => store.list('interaction-command').some(c => c.projectId === projectId && ['sending', 'unknown', 'received'].includes(c.state));
/** Only the private key provisioned by code-agent's TTY human-enable may sign explicit UI submissions. */
export function findHumanKey(channelId, directory = join(homedir(), '.code-agent', 'dashboard-channels')) {
  if (!/^[0-9a-f-]{36}$/i.test(channelId ?? '')) return null;
  try {
    if (lstatSync(directory).isSymbolicLink()) return null;
    const names = readdirSync(directory).filter(n => new RegExp(`^[0-9a-f]{16}-${channelId}\\.pem$`, 'i').test(n));
    if (names.length !== 1) return null;
    const path = join(directory, names[0]), stat = lstatSync(path);
    return stat.isFile() && !stat.isSymbolicLink() && stat.size < 16384 ? path : null;
  } catch { return null; }
}
export function interactionClient(store, project, cliPath) {
  const binding = store.get('control-binding', project.id);
  requireThat(binding, 'interaction-unavailable', '먼저 project control로 code-agent 제어 연결을 등록하세요.');
  return new ControlClient({ cliPath, projectPath: project.path, ...binding, retries: 0, timeoutMs: 10000 });
}
export function signInteraction(binding, record, submission, commandId, keyPath) {
  requireThat(keyPath, 'interaction-human-channel', 'code-agent master human enable로 등록한 사람 채널 키가 필요합니다.');
  requireThat(record.humanChannel?.generation === binding.generation && Number.isInteger(binding.generation), 'stale-question', '사람 채널 소유권이 바뀌었습니다. 제어 연결을 갱신하세요.');
  const payload = { requestId: record.requestId, expectedRevision: record.revision, contentHash: record.contentHash,
    challenge: record.challenge, channelId: record.humanChannel.channelId, submission };
  const message = canonicalInteraction({ domain: 'code-agent.dashboard-human.v1', projectId: binding.codeAgentProjectId,
    controller: binding.controller, generation: binding.generation, commandId, body: payload });
  const privateKey = createPrivateKey(readFileSync(keyPath));
  requireThat(privateKey.asymmetricKeyType === 'ed25519', 'interaction-human-channel', '사람 채널 키 형식이 다릅니다.');
  payload.signature = sign(null, Buffer.from(message), privateKey).toString('base64');
  return { commandId, generation: binding.generation, payload };
}
