import { isAbsolute, relative, resolve } from 'node:path';
import { OpenControlClient } from '../code-agent-adapter/control.mjs';
import { DASHBOARD_CONTROLLER, connectionState, controlProbe, findTrustKey, signPairing, validController } from '../code-agent-adapter/pairing.mjs';
import { pendingHumanResponse } from '../code-agent-adapter/interactions.mjs';
import { bindControl } from './control-host.mjs';
import { hash, now, requireThat, string } from '../domain/contracts.mjs';

const UNSETTLED = ['sending', 'unknown', 'bind-failed'];
const sameRoot = (a, b) => process.platform === 'win32' ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b);
const inside = (root, path) => { const rel = relative(resolve(root), resolve(path)); return rel === '' || !rel.startsWith('..') && !isAbsolute(rel); };
const failure = error => ({ code: error.code ?? 'control-pairing-failed', message: String(error.message ?? '').slice(0, 500) });
const inflight = new Map();

/** 화면·응답에 내보내는 연결 기록 — 서명·토큰 파일 경로는 넣지 않는다 */
export function pairingReceipt(record) {
  return { id: record.id, projectId: record.projectId, controller: record.controller, state: record.state, outcome: record.result?.outcome ?? null,
    generation: record.result?.generation ?? null, expiresAt: record.result?.humanChannel?.expiresAt ?? null, error: record.error ?? null,
    createdAt: record.createdAt, pairedAt: record.pairedAt ?? null };
}

function requireIdle(store, project) {
  requireThat(!project.deletedAt, 'not-found', '등록 해제된 프로젝트입니다.');
  requireThat(!store.get('project-maintenance', project.id)?.active, 'project-busy', 'code-agent 업데이트 중에는 연결하지 않습니다.');
  requireThat(!store.lock(project.id), 'project-busy', '실행 중이거나 확인되지 않은 작업이 있는 프로젝트는 연결을 바꾸지 않습니다.');
  requireThat(!pendingHumanResponse(store, project.id), 'project-busy', '전송·적용 중인 사람 응답이 있습니다. 결과를 확인한 뒤 연결하세요.');
}

function shownLines(project, probe, connection, controller) {
  const host = probe.managedHost;
  return [
    `프로젝트: ${project.name} (${project.id})`,
    `경로: ${project.path}`,
    `제어자: ${controller}`,
    `개발 호스트: ${host?.selected ? `${host.selected}${host.source ? ` (${host.source})` : ''} · ${host.ready === false ? `준비 안 됨 — ${host.problems.map(p => p.message || p.code).join(' / ') || '사유 미제공'}` : host.ready ? '준비됨' : '준비 상태 미확인'}` : 'code-agent가 선택 호스트를 알리지 않았습니다'}`,
    connection.outcome === 'rotated' ? '이미 켜진 연동의 제어 토큰을 새로 발급합니다. 이전 토큰 파일은 더 이상 쓰지 않습니다.' : 'code-agent master 연동을 켜고 이 대시보드를 소유 제어자로 등록합니다.',
    '연결은 승인 권한이 아닙니다. 위임 승인은 code-agent에서 사람이 따로 준 범위에서만 받습니다.',
    '사람 응답 채널을 함께 만듭니다. 채널에는 code-agent가 정한 만료일이 있으며 만료 전에 다시 연결로 갱신합니다.',
  ];
}

/** 확인 화면 내용 — 토큰 없이 hello 만 읽는다. shownHash 는 사람이 본 내용 그대로의 해시다 */
export async function pairingPreview(store, projectId, { cliPath, controller = DASHBOARD_CONTROLLER, resolveKey = findTrustKey, timeoutMs = 10000 } = {}) {
  const project = store.need('project', projectId);
  requireThat(!project.deletedAt, 'not-found', '등록 해제된 프로젝트입니다.');
  requireThat(validController(controller), 'invalid-input', '제어자 이름 형식이 잘못됐습니다.');
  const hello = await new OpenControlClient({ cliPath, projectPath: project.path, timeoutMs, retries: 0 }).result('hello');
  const probe = controlProbe(hello);
  const connection = connectionState({ projectId, probe, binding: store.get('control-binding', projectId), controller, keyAvailable: Boolean(resolveKey(controller)) });
  const lines = shownLines(project, probe, connection, controller);
  return { projectId, projectRevision: project.revision, controller, state: connection.state, code: connection.code, canPair: connection.canPair,
    outcome: connection.outcome ?? null, message: connection.message, guidance: connection.guidance, command: connection.command ?? null, lines,
    shownHash: `sha256:${hash({ projectId, projectRevision: project.revision, controller, lines, codeAgentProjectId: typeof hello.project?.projectId === 'string' ? hello.project.projectId : null })}` };
}

/**
 * 사람이 확인 화면(또는 TTY 확인 단어)으로 승인한 연결 한 건. hello → pair.challenge → PC 신뢰 키 서명 → pair → bindControl.
 * 요청 실행기·AI 계획·복구·백그라운드 경로에서는 부르지 않는다. 응답을 잃으면 같은 commandId 로 다시 보내 기록된 결과를 받는다.
 */
export async function pairControl(store, projectId, { cliPath, controller = DASHBOARD_CONTROLLER, approval, commandId, projectRevision, resolveKey = findTrustKey, timeoutMs = 15000 } = {}) {
  string(commandId, 'commandId');
  requireThat(commandId.length <= 128 && /^[A-Za-z0-9._:-]+$/.test(commandId), 'invalid-input', 'commandId 형식이 잘못됐습니다.');
  requireThat(approval && typeof approval.actor === 'string' && approval.actor && typeof approval.shownHash === 'string' && approval.shownHash, 'invalid-input', '사람 확인(actor·shownHash)이 필요합니다.');
  const previous = store.get('control-pairing', commandId);
  if (previous) {
    requireThat(previous.projectId === projectId && previous.controller === controller && previous.approval.shownHash === approval.shownHash, 'request-conflict', '같은 commandId에 다른 연결을 보낼 수 없습니다.');
    return UNSETTLED.includes(previous.state) ? retryPairing(store, commandId, { cliPath, timeoutMs }) : previous;
  }
  const project = store.need('project', projectId);
  requireThat(projectRevision === undefined || project.revision === projectRevision, 'stale-state', '확인한 뒤 프로젝트 정보가 바뀌었습니다. 다시 확인하세요.');
  requireIdle(store, project);
  requireThat(!store.list('control-pairing').some(p => p.projectId === projectId && UNSETTLED.includes(p.state)), 'request-busy', '결과를 확인하지 못한 연결 요청이 있습니다. 같은 접수 번호로 결과를 먼저 확인하세요.');
  const keyPath = resolveKey(controller);
  requireThat(keyPath, 'control-trust-missing', `이 대시보드 서버 계정에서 PC 신뢰 키를 찾지 못했습니다. 터미널에서 code-agent master trust --controller ${controller}를 실행하세요.`);
  const preview = await pairingPreview(store, projectId, { cliPath, controller, resolveKey, timeoutMs });
  requireThat(preview.shownHash === approval.shownHash, 'stale-state', '확인한 뒤 연결 내용이 바뀌었습니다. 최신 내용을 다시 확인하세요.');
  requireThat(preview.canPair, preview.code ?? 'control-pairing-unavailable', `${preview.message} ${preview.guidance}`.trim());
  const client = new OpenControlClient({ cliPath, projectPath: project.path, timeoutMs, retries: 0 });
  const challenge = await client.result('pair.challenge', { payload: { controller } });
  requireThat(typeof challenge?.challengeId === 'string' && typeof challenge.nonce === 'string' && challenge.controller === controller &&
    typeof challenge.projectRoot === 'string' && sameRoot(challenge.projectRoot, project.path) && Date.parse(challenge.expiresAt) > Date.now(),
    'control-pairing-invalid', '연결 확인 값(challenge)이 이 프로젝트·제어자와 맞지 않습니다.');
  requireThat(!challenge.project?.handover && (!challenge.project?.owner || challenge.project.owner === controller), 'control-owned-by-other', '다른 제어자가 소유 중입니다. 정식 인계 절차를 따르세요.');
  const signed = { actor: approval.actor, approvedAt: approval.approvedAt ?? now(), shownHash: approval.shownHash };
  const wire = signPairing({ challenge, controller, commandId, approval: signed, keyPath });
  store.transaction(() => {
    requireThat(!store.get('control-pairing', commandId), 'request-conflict', '같은 commandId로 이미 연결을 보냈습니다.');
    const current = store.need('project', projectId);
    requireThat(current.revision === project.revision, 'stale-state', '확인한 뒤 프로젝트 정보가 바뀌었습니다.');
    requireIdle(store, current);
    requireThat(!store.list('control-pairing').some(p => p.projectId === projectId && UNSETTLED.includes(p.state)), 'request-busy', '결과를 확인하지 못한 연결 요청이 있습니다.');
    store.put('control-pairing', { id: commandId, projectId, controller, state: 'sending', approval: signed, challengeId: challenge.challengeId,
      challengeExpiresAt: challenge.expiresAt, expected: preview.outcome, wire, createdAt: now() });
    store.event(projectId, 'control-pairing-sending', { commandId, controller, expected: preview.outcome });
  });
  return transmit(store, commandId, { cliPath, timeoutMs });
}

/** 결과 미확인(sending·unknown)은 같은 commandId·같은 서명으로 다시 보내고, 등록 실패(bind-failed)는 받은 결과로 다시 등록한다 */
export async function retryPairing(store, commandId, { cliPath, timeoutMs = 15000 } = {}) {
  const record = store.need('control-pairing', commandId);
  requireThat(UNSETTLED.includes(record.state), 'invalid-input', '결과 미확인 또는 등록 실패 연결만 같은 접수 번호로 다시 확인합니다.');
  return record.state === 'bind-failed' ? settle(store, commandId, { cliPath }) : transmit(store, commandId, { cliPath, timeoutMs });
}

function patch(store, commandId, states, change, event) {
  return store.transaction(() => {
    const current = store.need('control-pairing', commandId);
    if (!states.includes(current.state)) return current;
    if (event) store.event(current.projectId, event[0], event[1]);
    return store.put('control-pairing', { ...current, ...change, updatedAt: now() }, current.revision);
  });
}

function validResult(result, record, project) {
  requireThat(['enabled', 'rotated'].includes(result?.outcome) && result.controller === record.controller && result.owner === true && Number.isInteger(result.generation) &&
    typeof result.tokenFile === 'string' && isAbsolute(result.tokenFile) && !inside(project.path, result.tokenFile),
    'control-pairing-invalid', 'code-agent 연결 결과가 계약과 다릅니다(소유자·세대·저장소 밖 토큰 파일 절대 경로가 필요합니다).');
  const channel = result.humanChannel;
  return { outcome: result.outcome, codeAgentProjectId: typeof result.projectId === 'string' ? result.projectId : null, controller: result.controller,
    generation: result.generation, tokenFile: result.tokenFile,
    humanChannel: typeof channel?.channelId === 'string' ? { channelId: channel.channelId, expiresAt: Number.isFinite(Date.parse(channel.expiresAt)) ? channel.expiresAt : null } : null };
}

function transmit(store, commandId, { cliPath, timeoutMs = 15000 }) {
  if (inflight.has(commandId)) return inflight.get(commandId);
  const run = (async () => {
    const record = store.need('control-pairing', commandId);
    if (!['sending', 'unknown'].includes(record.state)) return record;
    const project = store.need('project', record.projectId);
    let change;
    try {
      const result = await new OpenControlClient({ cliPath, projectPath: project.path, timeoutMs }).result('pair', record.wire);
      change = { state: 'received', result: validResult(result, record, project), receivedAt: now(), error: null };
    } catch (error) { change = { state: error.code === 'control-unavailable' ? 'unknown' : 'failed', error: failure(error) }; }
    patch(store, commandId, ['sending', 'unknown'], change, change.state === 'failed' ? ['control-pairing-failed', { commandId, code: change.error.code }] : null);
    return change.state === 'received' ? settle(store, commandId, { cliPath }) : store.need('control-pairing', commandId);
  })().finally(() => inflight.delete(commandId));
  inflight.set(commandId, run);
  return run;
}

/** code-agent 가 연결을 받은 뒤 master DB 에 등록한다. 토큰 파일 경로만 저장한다 */
async function settle(store, commandId, { cliPath }) {
  const record = store.need('control-pairing', commandId), result = record.result;
  try {
    await bindControl(store, record.projectId, { cliPath, controller: record.controller, tokenFile: result.tokenFile,
      pairing: { commandId, outcome: result.outcome, humanChannel: result.humanChannel, pairedAt: now() } });
  } catch (error) {
    return patch(store, commandId, ['received', 'bind-failed'], { state: 'bind-failed', error: failure(error) }, ['control-pairing-bind-failed', { commandId, code: error.code ?? 'internal-error' }]);
  }
  return patch(store, commandId, ['received', 'bind-failed'], { state: 'paired', pairedAt: now(), error: null },
    ['control-paired', { commandId, controller: record.controller, outcome: result.outcome, generation: result.generation }]);
}
