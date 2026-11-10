import { DomainError, hash, now, requireThat } from '../domain/contracts.mjs';
import { bindingOf } from './retrieval.mjs';
import { sourceState, staleSource } from './source-state.mjs';

export { sourceState } from './source-state.mjs';

/**
 * 계획에 쓴 agent-knowledge 항목의 로컬 정본(묶음)과 배정 시 검사.
 * 묶음은 분석 한 번의 context.knowledge 전체를 봉인 해시와 함께 보관한다 — 생산자 세대 정리·DB 재생성과 무관하게 계획 입력을 재현한다.
 * 보존 대상은 현재 분석 run과 활성 계획의 묶음뿐이고, 나머지는 해제(본문 삭제·봉인 해시 유지)한다.
 */
export const BUNDLE_KIND = 'agent-knowledge-bundle';
export const HANDOFF_SCHEMA = 'master-agent.knowledge-handoff';
const HANDOFF_LIMITS = Object.freeze({ items: 40, bytes: 32 * 1024 });
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

/** 묶음 기록(분석 시작 트랜잭션 안) */
export function sealBundle(store, mission, runId, knowledge) {
  const sealedHash = hash(knowledge);
  return store.put(BUNDLE_KIND, { id: bundleIdOf(runId), missionId: mission.id, runId, state: 'retained', sealedHash,
    bytes: Buffer.byteLength(JSON.stringify(knowledge)), items: knowledge.items.length, generation: knowledge.retrieval.generation, knowledge, createdAt: now() });
}

/** 보존 대상: 현재 분석 run의 묶음과 활성 계획의 묶음 */
export function keptBundles(store, mission) {
  const run = mission.analysisRunId ? store.get('analysis-run', mission.analysisRunId) : null;
  return [run?.knowledge?.bundleId, mission.plans.at(-1)?.knowledge?.bundleId].filter(Boolean);
}
/** 보존 대상이 아닌 묶음의 본문을 지운다(멱등). 묶음이 없는 목표에서는 아무것도 쓰지 않는다 */
export function releaseBundles(store, mission, keep, reason) {
  for (const bundle of store.list(BUNDLE_KIND, { missionId: mission.id })) {
    if (bundle.state !== 'retained' || keep.includes(bundle.id)) continue;
    store.put(BUNDLE_KIND, { ...bundle, state: 'released', knowledge: null, releasedAt: now(), releaseReason: reason }, bundle.revision);
  }
}

/** 계획에 남길 지식 요약 — 작업이 인용한 ref만 */
export function planKnowledge(bundle, plan) {
  const used = new Set(plan.tasks.flatMap(t => t.knowledgeRefs ?? []));
  return { bundleId: bundle.id, bundleHash: bundle.sealedHash, generation: bundle.knowledge.retrieval.generation, publishedAt: bundle.knowledge.retrieval.publishedAt,
    settingsHash: bundle.knowledge.retrieval.settingsHash,
    refs: bundle.knowledge.items.filter(i => used.has(i.ref)).map(i => ({ ref: i.ref, forProject: i.forProject, itemId: i.itemId, status: i.status, confirmed: i.confirmed, itemSha256: i.itemSha256 })) };
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
export function checkSources(project, items) {
  const states = items.map(i => i.scopeRole === 'project' ? sourceState(project.path, i) : 'unverifiable');
  requireThat(!items.some((i, n) => i.confirmed && staleSource(states[n])), 'knowledge-source-changed',
    '계획에 쓴 확정 지식의 원본이 색인 뒤 바뀌었거나 사라졌습니다. mission analyze로 다시 계획하세요(새 분석은 바뀐 항목을 작업 근거로 쓰지 않습니다). 색인 갱신은 agent-knowledge 재색인으로 합니다.');
  return states.reduce((n, s) => ({ ...n, [s]: (n[s] ?? 0) + 1 }), {});
}

/** 수신 측이 범위·세대/커밋·해시를 검증할 수 있는 인계 블록(본문 없음). code-agent와 합의한 계약이 없어 보내지 않는다 */
export function handoffBlock(bundle, items) {
  const retrieval = bundle.knowledge.retrieval;
  const block = { schema: HANDOFF_SCHEMA, version: 1, bundleId: bundle.id, bundleHash: bundle.sealedHash, generation: retrieval.generation, publishedAt: retrieval.publishedAt,
    items: items.map(i => ({ ref: i.ref, itemId: i.itemId, producerProjectId: i.producerProjectId, sourceId: i.sourceId, kind: i.kind, status: i.status, confirmed: i.confirmed,
      commit: i.commit, path: i.path, startLine: i.startLine, endLine: i.endLine, blobSha: i.blobSha, documentSha256: i.documentSha256, itemSha256: i.itemSha256 })) };
  const bytes = Buffer.byteLength(JSON.stringify(block));
  return { block, hash: hash(block), bytes, withinLimits: block.items.length <= HANDOFF_LIMITS.items && bytes <= HANDOFF_LIMITS.bytes };
}

/**
 * 배정 직전 검사. 작업에 지식 참조가 없으면 null(기존 경로 그대로).
 * 참조가 있으면 모드와 무관하게 봉인 묶음·연결 범위(taskEvidence)와 확정 항목 원본(HEAD·작업 트리)을 확인한다 — 모두 로컬 검사다.
 * 모드는 미전송 사유만 바꾼다(enabled: 합의된 수신 계약 없음 / 그 외: 연결 해제).
 */
export function dispatchEvidence(store, plan, task, project, { mode } = {}) {
  if (!task.knowledgeRefs?.length) return null;
  const { bundle, items } = taskEvidence(store, plan, task);
  const sourceCheck = checkSources(project, items);
  const handoff = handoffBlock(bundle, items);
  return { status: 'not-sent', reason: mode === 'enabled' ? 'no-agreed-contract' : 'knowledge-disabled', schema: HANDOFF_SCHEMA, version: 1, count: items.length,
    hash: handoff.hash, bytes: handoff.bytes, withinLimits: handoff.withinLimits, dependsOnConfirmed: items.some(i => i.confirmed), bundleId: bundle.id, sourceCheck };
}
