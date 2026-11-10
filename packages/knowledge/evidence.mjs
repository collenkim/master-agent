import { DomainError, hash, now, requireThat } from '../domain/contracts.mjs';
import { bindingOf } from './retrieval.mjs';
import { sourceState, staleSource } from './source-state.mjs';
import { decideHandoff, receiverCapability } from './handoff.mjs';

export { sourceState } from './source-state.mjs';

/**
 * 계획에 쓴 agent-knowledge 항목의 로컬 정본(묶음)과 배정 시 검사.
 * 묶음은 분석 한 번의 context.knowledge 전체를 봉인 해시와 함께 보관한다 — 생산자 세대 정리·DB 재생성과 무관하게 계획 입력을 재현한다.
 * 보존 대상은 현재 분석 run과 활성 계획의 묶음뿐이고, 나머지는 해제(본문 삭제·봉인 해시 유지)한다.
 * 형식 2 생산자에서 얻은 묶음은 생산자 세대 임대(lease)를 함께 기록한다 — 봉인 해시 밖이다(임대 ID·만료 시각은 계획 입력이 아니다).
 * 묶음을 해제하면 임대는 release-pending이 되고, 비동기 정리(lease.mjs settleLeases)가 생산자에서 놓는다.
 */
export const BUNDLE_KIND = 'agent-knowledge-bundle';
/** 시도에 남기는 인계 기록의 형식 — 수신자에게 보내는 payload 형식(handoff.mjs 형식 1)과 다르다 */
export const HANDOFF_SCHEMA = 'master-agent.knowledge-handoff';
export const HANDOFF_RECORD_VERSION = 2;
export const bundleIdOf = runId => `kb:${runId}`;
const fail = (code, message) => { throw new DomainError(code, message); };

/** 봉인 해시와 기대 해시를 대조한다. 해제는 변조와 구분한다(knowledge-bundle-released) */
export function verifiedBundle(store, bundleId, expectedHash) {
  const bundle = store.get(BUNDLE_KIND, bundleId);
  if (!bundle) fail('knowledge-integrity', '계획 근거 묶음을 찾을 수 없습니다. 재분석이 필요합니다.');
  if (bundle.state === 'released') fail('knowledge-bundle-released', '계획 근거 묶음이 이미 해제됐습니다. 재분석이 필요합니다.');
  if (bundle.state !== 'retained' || !bundle.knowledge || hash(bundle.knowledge) !== bundle.sealedHash || (expectedHash !== undefined && bundle.sealedHash !== expectedHash))
    fail('knowledge-integrity', '계획 근거 묶음의 봉인 해시가 맞지 않습니다. 해당 작업은 재검토가 필요합니다.');
  return bundle;
}

/** 임대 기록 정규화 — 묶음 기록에 남길 필드만(진단은 코드만) */
export function leaseRecord(lease) {
  if (!lease) return null;
  return { state: lease.state, holder: lease.holder ?? null, generation: lease.generation ?? null, indexId: lease.indexId ?? null,
    ...(lease.leaseId ? { leaseId: lease.leaseId } : {}), ...(lease.expiresAt ? { expiresAt: lease.expiresAt } : {}), ...(lease.reason ? { reason: lease.reason } : {}),
    ...(lease.diagnostic ? { diagnostic: lease.diagnostic } : {}), updatedAt: now() };
}
/** 묶음 기록(분석 시작 트랜잭션 안). lease는 형식 2 생산자에서 붙잡은 세대 임대(없으면 null) */
export function sealBundle(store, mission, runId, knowledge, lease = null) {
  const sealedHash = hash(knowledge);
  return store.put(BUNDLE_KIND, { id: bundleIdOf(runId), missionId: mission.id, runId, state: 'retained', sealedHash,
    bytes: Buffer.byteLength(JSON.stringify(knowledge)), items: knowledge.items.length, generation: knowledge.retrieval.generation,
    ...(knowledge.retrieval.indexId ? { indexId: knowledge.retrieval.indexId } : {}), knowledge, ...(lease ? { lease: leaseRecord(lease) } : {}), createdAt: now() });
}

/** 보존 대상: 현재 분석 run의 묶음과 활성 계획의 묶음 */
export function keptBundles(store, mission) {
  const run = mission.analysisRunId ? store.get('analysis-run', mission.analysisRunId) : null;
  return [run?.knowledge?.bundleId, mission.plans.at(-1)?.knowledge?.bundleId].filter(Boolean);
}
/**
 * 보존 대상이 아닌 묶음의 본문을 지운다(멱등). 묶음이 없는 목표에서는 아무것도 쓰지 않는다.
 * 잡고 있던 생산자 임대는 release-pending으로 바꾼다 — 생산자 호출은 트랜잭션 밖 settleLeases가 한다(실패해도 임대 기간이 지나면 생산자가 정리한다)
 */
export function releaseBundles(store, mission, keep, reason) {
  for (const bundle of store.list(BUNDLE_KIND, { missionId: mission.id })) {
    if (bundle.state !== 'retained' || keep.includes(bundle.id)) continue;
    const lease = bundle.lease?.leaseId && ['held', 'unavailable'].includes(bundle.lease.state) ? { ...bundle.lease, state: 'release-pending', releaseReason: reason, updatedAt: now() } : bundle.lease;
    store.put(BUNDLE_KIND, { ...bundle, state: 'released', knowledge: null, releasedAt: now(), releaseReason: reason, ...(lease ? { lease } : {}) }, bundle.revision);
  }
}

/**
 * 작업의 필수 지식 의존. knowledgeRequired가 있으면 그 목록이고(선언), 없는 기존 계획은 실제 의존을 모르므로 인용한 항목 모두를 필수로 본다(unknown).
 * confirmed 여부로 정하지 않는다 — 확정 여부는 판단 근거 자격이고, 필수 여부는 작업 진행에 그 내용의 검증이 필요한지다.
 */
export function requiredRefs(task) {
  const declared = Object.hasOwn(task, 'knowledgeRequired');
  return { declared, dependency: declared ? 'declared' : 'unknown', refs: new Set(declared ? task.knowledgeRequired : task.knowledgeRefs ?? []) };
}

/** 계획에 남길 지식 요약 — 작업이 인용한 ref만. 같은 항목을 여러 작업이 다르게 쓰면 작업별 필수 여부는 requiredRefs로 다시 정한다 */
export function planKnowledge(bundle, plan) {
  const used = new Set(plan.tasks.flatMap(t => t.knowledgeRefs ?? []));
  const required = new Set(plan.tasks.flatMap(t => [...requiredRefs(t).refs]));
  const retrieval = bundle.knowledge.retrieval;
  return { bundleId: bundle.id, bundleHash: bundle.sealedHash, generation: retrieval.generation, publishedAt: retrieval.publishedAt,
    settingsHash: retrieval.settingsHash, ...(retrieval.indexId ? { indexId: retrieval.indexId } : {}), ...(retrieval.configHash ? { configHash: retrieval.configHash } : {}),
    refs: bundle.knowledge.items.filter(i => used.has(i.ref)).map(i => ({ ref: i.ref, forProject: i.forProject, itemId: i.itemId, status: i.status, confirmed: i.confirmed, itemSha256: i.itemSha256,
      requiredBy: plan.tasks.filter(t => t.knowledgeRefs?.includes(i.ref) && requiredRefs(t).refs.has(i.ref)).map(t => t.id), required: required.has(i.ref) })) };
}

/** 항목이 지금 그 프로젝트 연결 범위(자기 지식 프로젝트·허용 연결 종류) 안인지 — 계획 뒤 재연결·연결 철회를 잡는다 */
function inBinding(binding, item) {
  if (!binding?.knowledgeProject) return false;
  if (item.scopeRole === 'project') return item.producerProjectId === binding.knowledgeProject;
  return (binding.allowedLinks ?? []).some(l => l.knowledgeProject === item.producerProjectId && l.kinds.includes(item.kind));
}
/**
 * 작업 ref가 활성 계획의 봉인 묶음 안에 있고 그 작업 프로젝트 범위인지 확인한다(로컬 검사, 생산자 호출 없음).
 * 모드와 무관하다 — 연결을 꺼도 이미 승인된 계획이 기대는 근거의 무결성 오류를 무시하지 않는다.
 */
export function taskEvidence(store, plan, task) {
  if (!plan.knowledge?.bundleId) fail('knowledge-integrity', '근거 묶음이 없는 계획의 작업이 지식 참조를 가집니다.');
  const bundle = verifiedBundle(store, plan.knowledge.bundleId, plan.knowledge.bundleHash);
  const byRef = new Map(bundle.knowledge.items.map(i => [i.ref, i]));
  const items = task.knowledgeRefs.map(ref => byRef.get(ref));
  if (items.some(i => !i || i.forProject !== task.projectId)) fail('knowledge-integrity', '작업의 지식 참조가 봉인 묶음 또는 작업 프로젝트 범위와 맞지 않습니다.');
  const binding = bindingOf(store, task.projectId);
  if (items.some(i => !inBinding(binding, i)))
    fail('knowledge-scope-changed', '계획 뒤 프로젝트의 agent-knowledge 연결 범위가 바뀌었습니다. mission analyze로 현재 연결 범위에서 다시 계획하세요.');
  return { bundle, items };
}
/**
 * 확정 항목의 원본이 바뀌었거나 사라졌으면 막는다. 상태별 개수를 돌려준다.
 * 원본은 작업 프로젝트 저장소에서만 확인한다 — 허용 연결 항목의 저장소는 목표 범위 밖이므로 읽지 않고 검증 불가로 기록한다.
 */
export function checkSources(project, items, required = new Set()) {
  const states = items.map(i => i.scopeRole === 'project' ? sourceState(project.path, i) : 'unverifiable');
  // 필수 의존은 확정 여부와 무관하게 계획 때 내용이어야 한다
  requireThat(!items.some((i, n) => (i.confirmed || required.has(i.ref)) && staleSource(states[n])), 'knowledge-source-changed',
    '계획에 쓴 확정 지식의 원본이 색인 뒤 바뀌었거나 사라졌습니다. mission analyze로 다시 계획하세요(새 분석은 바뀐 항목을 작업 근거로 쓰지 않습니다). 색인 갱신은 agent-knowledge 재색인으로 합니다.');
  return states.reduce((n, s) => ({ ...n, [s]: (n[s] ?? 0) + 1 }), {});
}

/** 보류 코드별 사용자 안내 — 진행 화면·요청함에 코드와 함께 보인다 */
export const KNOWLEDGE_GUIDANCE = Object.freeze({
  'knowledge-handoff-unsupported': '이 작업의 필수 지식 근거를 받을 수 있는 code-agent가 아닙니다(hello에 지식 인계 공지 없음). code-agent를 지식 인계를 지원하는 판으로 올리거나, 근거 없이 진행할지 다시 계획하세요.',
  'knowledge-receiver-unreachable': 'code-agent hello로 지식 인계 공지를 확인하지 못했습니다(통신 실패). 연결을 확인한 뒤 다시 배정하세요.',
  'knowledge-handoff-version': '필수 지식 근거는 인계 형식 2(색인 식별 포함)로만 보냅니다. code-agent가 지금 형식 2를 받지 않거나(색인 대조 등록 필요) 계획 묶음이 형식 2 생산자 결과가 아닙니다. 두 쪽을 맞춘 뒤 다시 분석·배정하세요.',
  'knowledge-handoff-ungated': '이 code-agent는 필수 근거 진행 게이트(requiredGate)를 공지하지 않아, 근거가 확인되지 않아도 작업을 막지 않습니다. 필수 근거를 보내지 않고 이 작업만 보류했습니다. 게이트를 지원하는 판으로 올리거나 근거 없이 진행할지 다시 계획하세요.',
  'knowledge-handoff-not-accepted': 'code-agent 프로젝트가 지식 참조를 받지 않습니다(agent-knowledge 플러그인 enabled·context.docs.refs 등록 필요). code-agent 쪽 설정을 확인하거나 다시 계획하세요.',
  'knowledge-handoff-scope': '필수 근거가 허용 연결(다른 지식 프로젝트) 항목이라 code-agent가 대조할 수 없습니다. 범위를 넓히지 않습니다 — 작업 프로젝트 근거로 다시 계획하세요.',
  'knowledge-handoff-unrepresentable': '필수 근거를 수신 형식으로 표현할 수 없습니다(항목 ID·커밋·해시 형식). 다시 계획하세요.',
  'knowledge-handoff-limit': '필수 근거가 수신 상한(개수·크기)을 넘습니다. 잘라 보내지 않습니다 — 작업을 나눠 다시 계획하세요.',
  'knowledge-generation-expired': '계획 근거 색인 세대가 생산자에서 지워졌습니다. code-agent가 같은 근거를 다시 조회할 수 없으니 mission analyze로 다시 계획하세요.',
  'knowledge-index-mismatch': '생산자 색인 DB가 계획 때와 다릅니다(indexId 불일치). 같은 DB로 연결하거나 다시 계획하세요.',
  'knowledge-lease-failed': '계획 근거 세대의 생산자 임대를 연장하지 못했습니다. agent-knowledge 연결을 확인한 뒤 다시 실행하세요.',
  'knowledge-handoff-rejected': 'code-agent가 지식 인계를 거부했습니다. 기록된 사유를 확인하고 설정을 맞추거나 다시 계획하세요.',
  'knowledge-handoff-unconfirmed': 'code-agent가 받은 지식 참조가 보낸 내용과 같은지 확인하지 못했습니다. 실행 결과를 검토하세요.',
  'knowledge-verification-failed': 'code-agent가 필수 지식 근거가 지금 근거와 맞지 않는다고 판정했습니다(해시·세대·원본 변경·범위). required를 낮추거나 최신 항목으로 갈음하지 않습니다 — 원본·색인을 확인하고 다시 계획하세요.',
  'knowledge-verification-pending': 'code-agent가 필수 지식 근거를 아직 검증하지 못했습니다(검증 전·만료·어댑터 장애). master는 같은 참조 재검증을 한 번만 요청합니다 — 지식 검색 연결을 확인한 뒤 code-agent knowledge verify로 다시 검증하세요.',
  'knowledge-blocked': 'code-agent 진행 게이트가 이 작업의 인계 필수 근거 때문에 멈췄습니다. 재검증(같은 참조) 또는 재계획(인계 교체)이 필요합니다 — code-agent status의 다음 동작을 확인하세요.',
  'knowledge-source-changed': '계획에 쓴 근거의 원본이 바뀌었거나 사라졌습니다. mission analyze로 다시 계획하세요.',
  'knowledge-integrity': '계획 근거 묶음이 없거나 봉인이 맞지 않습니다. 다시 계획하세요.',
  'knowledge-bundle-released': '계획 근거 묶음이 이미 해제됐습니다. 다시 계획하세요.',
  'knowledge-scope-changed': '계획 뒤 지식 연결 범위가 바뀌었습니다. 현재 범위로 다시 계획하세요.',
});
/**
 * 필수 근거를 실은 시도의 인계 결과가 진행을 막는지 — 접수·저장 미확인, 수신 거부, 수신자의 재확인 실패. 막지 않으면 null.
 * 접수(accepted)·저장 일치(matched)·재확인 통과(passed) 관찰은 막지 않을 뿐 승인·검증 완료 증거가 아니다
 */
export function deliveryBlock(handoff) {
  const d = handoff?.delivery;
  if (handoff?.status !== 'prepared' || !handoff.sentRequired || !d) return null;
  if (d.verification?.state === 'failed') return 'knowledge-verification-failed';
  if (d.verification?.state === 'unverified') return 'knowledge-verification-pending';
  if (d.state === 'rejected') return 'knowledge-handoff-rejected';
  return d.state !== 'accepted' || d.stored === 'mismatch' ? 'knowledge-handoff-unconfirmed' : null;
}
const LEASE_HOLDS = Object.freeze({ 'generation-not-found': 'knowledge-generation-expired', 'no-generation': 'knowledge-generation-expired', 'index-id-mismatch': 'knowledge-index-mismatch' });
/** 임대 상태가 필수 근거 인계에 주는 영향. null이면 영향 없음 */
export function leaseHold(lease) {
  if (!lease) return null;
  if (lease.state === 'lost') return LEASE_HOLDS[lease.reason] ?? 'knowledge-generation-expired';
  if (lease.state === 'unavailable') return 'knowledge-lease-failed';
  return null;
}

/**
 * 배정 직전 검사와 인계 결정. 작업에 지식 참조가 없으면 null(기존 경로 그대로).
 * 참조가 있으면 모드와 무관하게 봉인 묶음·연결 범위(taskEvidence)와 원본(HEAD·작업 트리)을 확인한다(로컬 검사).
 * 그다음 수신자 공지(capability, hello)와 임대 상태로 인계를 정한다:
 * - prepared: 수신 형식으로 변환·검증한 payload를 start submit에 싣는다
 * - not-sent: 보낼 참조가 없다(선택 참조만 있고 수신 불가·모드 off 등) — 기존 배정 그대로
 * - 필수 참조를 보낼 수 없으면 그 작업만 보류 코드로 막는다(throw) — 조용히 빼거나 자르지 않는다
 * off·shadow에서는 생산자를 부르지 않으므로 lease는 마지막 기록 그대로 쓴다(호출자가 갱신하지 않는다).
 */
export function dispatchEvidence(store, plan, task, project, { mode, capability = null, lease = null } = {}) {
  if (!task.knowledgeRefs?.length) return null;
  const { bundle, items } = taskEvidence(store, plan, task);
  const required = requiredRefs(task);
  const sourceCheck = checkSources(project, items, required.refs);
  const extra = { schema: HANDOFF_SCHEMA, recordVersion: HANDOFF_RECORD_VERSION, sourceCheck, dependsOnConfirmed: items.some(i => i.confirmed),
    ...(lease ? { lease: { state: lease.state, ...(lease.leaseId ? { leaseId: lease.leaseId } : {}), ...(lease.expiresAt ? { expiresAt: lease.expiresAt } : {}), ...(lease.reason ? { reason: lease.reason } : {}) } } : {}) };
  const leaseBlock = leaseHold(lease);
  const needed = items.filter(i => required.refs.has(i.ref));
  if (leaseBlock && needed.length && leaseBlock !== 'knowledge-lease-failed' || leaseBlock === 'knowledge-lease-failed' && needed.length && mode === 'enabled') {
    const error = new DomainError(leaseBlock, KNOWLEDGE_GUIDANCE[leaseBlock]);
    error.handoff = { ...extra, status: 'held', code: leaseBlock, bundleId: bundle.id, count: items.length, required: needed.length, optional: items.length - needed.length, receiver: null };
    throw error;
  }
  // 세대가 사라졌으면 선택 참조도 수신자가 되찾을 수 없다 — 빼고 사유를 남긴다
  const usable = leaseBlock && leaseBlock !== 'knowledge-lease-failed' ? items.filter(i => required.refs.has(i.ref)) : items;
  const dropped = items.filter(i => !usable.includes(i)).map(i => ({ ref: i.ref, reason: 'generation-expired' }));
  const decision = decideHandoff({ bundle, items: usable, capability: capability ?? receiverCapability(null), mode, required });
  if (decision.status === 'held') {
    const error = new DomainError(decision.code, KNOWLEDGE_GUIDANCE[decision.code] ?? '필수 지식 근거를 인계할 수 없습니다.');
    error.handoff = { ...decision, ...extra };
    throw error;
  }
  return { ...decision, ...extra, count: items.length, omitted: [...dropped, ...(decision.omitted ?? [])] };
}
