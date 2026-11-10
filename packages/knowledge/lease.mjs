import { now } from '../domain/contracts.mjs';
import { diagnosticOf, knowledgeConnection } from './agent-knowledge.mjs';
import { BUNDLE_KIND, leaseRecord } from './evidence.mjs';
import { KnowledgeRetrieval } from './retrieval.mjs';

/**
 * 계획 근거 세대의 생산자 임대(agent-knowledge lease) 수명. 새 보관 체계를 만들지 않고 생산자 임대만 쓴다.
 * - 잡기: 형식 2 생산자에서 계획 입력으로 쓴 분석(retrieval.analysis) — 묶음 기록의 lease
 * - 연장: enabled 프로젝트의 배정·이어 실행·재부착 직전(renewForTask). 만료·소실이면 같은 세대·색인 ID로 다시 잡는다
 * - 놓기: 묶음 해제(분석 대체·계획 교체·목표 완료·취소)가 release-pending으로 표시하고 settleLeases가 생산자에서 놓는다
 * 생산자를 부를 수 없으면 기록만 남기고 다음 기회에 다시 시도한다 — 놓지 못한 임대는 기간(LEASE_TTL_SECONDS)이 지나면 생산자가 지운다.
 * off·shadow 프로젝트에서는 연장하지 않는다(생산자를 몰래 부르지 않는다). 해제는 master가 잡은 자원 정리라 모드와 무관하다.
 */
const SETTLE_LIMIT = 16;

function retrievalOf(options) { return options.retrieval ?? new KnowledgeRetrieval(options.store, { env: options.env ?? process.env }); }
function connectionOf(retrieval) {
  try { return { connection: knowledgeConnection(retrieval.env) }; }
  catch (error) { return { diagnostic: diagnosticOf(error) }; }
}
function saveLease(store, bundleId, lease, { requireRetained = true } = {}) {
  return store.transaction(() => {
    const current = store.get(BUNDLE_KIND, bundleId);
    if (!current || requireRetained && current.state !== 'retained') return current?.lease ?? null;
    store.put(BUNDLE_KIND, { ...current, lease }, current.revision);
    return lease;
  });
}

/**
 * 작업 하나를 배정·이어 실행하기 전 그 계획 묶음의 임대를 연장한다. 반환은 dispatchEvidence에 넘길 임대 기록(없으면 null).
 * 이미 놓은(release-pending·released) 묶음은 연장하지 않는다 — 묶음 검사(verifiedBundle)가 먼저 막는다.
 */
export async function renewForTask(store, bundleId, mode, options = {}) {
  const bundle = bundleId ? store.get(BUNDLE_KIND, bundleId) : null;
  if (!bundle?.lease) return null;
  if (mode !== 'enabled' || !['held', 'unavailable', 'lost'].includes(bundle.lease.state) || bundle.state !== 'retained') return bundle.lease;
  // 세대가 이미 사라졌다고 확인한 임대는 다시 묻지 않는다 — 같은 실패를 반복하지 않는다(재계획이 새 묶음·임대를 만든다)
  if (bundle.lease.state === 'lost') return bundle.lease;
  const retrieval = retrievalOf({ store, ...options });
  const { connection, diagnostic } = connectionOf(retrieval);
  if (!connection) {
    const record = saveLease(store, bundleId, leaseRecord({ ...bundle.lease, state: 'unavailable', diagnostic: diagnostic ?? { code: 'knowledge-not-configured' } }));
    store.transaction(() => store.event(bundle.missionId, 'knowledge-lease-failed', { bundleId, state: record.state, diagnostic: record.diagnostic }));
    return record;
  }
  const next = await retrieval.renewLease(connection, bundle.lease);
  const record = leaseRecord({ ...next, holder: next.holder ?? bundle.lease.holder, generation: next.generation ?? bundle.lease.generation, indexId: next.indexId ?? bundle.lease.indexId });
  saveLease(store, bundleId, record);
  if (bundle.lease.leaseId && record.leaseId && record.leaseId !== bundle.lease.leaseId) store.transaction(() => store.event(bundle.missionId, 'knowledge-lease-reacquired', { bundleId, generation: record.generation }));
  if (record.state !== 'held') store.transaction(() => store.event(bundle.missionId, 'knowledge-lease-failed', { bundleId, state: record.state, ...(record.reason ? { reason: record.reason } : {}), ...(record.diagnostic ? { diagnostic: record.diagnostic } : {}) }));
  return record;
}

/** 해제 대기 임대를 생산자에서 놓는다(최선 노력, 실패는 다음 기회에). missionId를 주면 그 목표 것만 */
export async function settleLeases(store, options = {}) {
  const pending = store.list(BUNDLE_KIND, options.missionId ? { missionId: options.missionId } : {}).filter(b => b.lease?.state === 'release-pending' && b.lease.leaseId).slice(0, SETTLE_LIMIT);
  if (!pending.length) return [];
  const retrieval = retrievalOf({ store, ...options });
  const { connection } = connectionOf(retrieval);
  if (!connection) return pending.map(b => ({ bundleId: b.id, state: 'release-pending' }));
  const settled = [];
  for (const bundle of pending) {
    const result = await retrieval.releaseLease(connection, bundle.lease.leaseId);
    const lease = result.state === 'released'
      ? { ...bundle.lease, state: 'released', released: result.released, releasedAt: now(), updatedAt: now() }
      : { ...bundle.lease, state: 'release-pending', attempts: (bundle.lease.attempts ?? 0) + 1, diagnostic: result.diagnostic, updatedAt: now() };
    store.transaction(() => {
      const current = store.get(BUNDLE_KIND, bundle.id);
      if (current?.lease?.state !== 'release-pending' || current.lease.leaseId !== bundle.lease.leaseId) return;
      store.put(BUNDLE_KIND, { ...current, lease }, current.revision);
      if (lease.state === 'released') store.event(current.missionId, 'knowledge-lease-released', { bundleId: current.id, reason: current.lease.releaseReason ?? null, released: result.released });
    });
    settled.push({ bundleId: bundle.id, state: lease.state });
  }
  return settled;
}
