import { createHash } from 'node:crypto';
import { DomainError, hash } from '../domain/contracts.mjs';

/**
 * master → code-agent 지식 근거 인계(submit payload의 `knowledge`).
 * 수신 계약의 정본은 code-agent src/agent/master/protocol.ts `knowledgeHandoffOf`(형식 1·2)와 hello `knowledge` 공지다.
 * 내부 봉인 묶음(발췌·검색 요약 포함)을 그대로 싣지 않는다. 수신 파서와 같은 규칙으로 변환·검증한 참조만 보낸다.
 *
 * - 생산자 응답 형식(responseVersion)과 이 인계 형식(version)은 별개의 번호다.
 * - 송신 결정은 공통 계약(agent-knowledge docs/integration.md 「송신 결정」, docs/contract/handoff-cases.json)을 따른다.
 * - 수신자가 지금 받는다고 공지한 형식(hello refs.versions, 없으면 [1])만 쓴다. refs.supportedVersions 는 그 빌드가 읽을 줄 아는 형식일 뿐이다.
 * - 필수 참조는 진행 게이트를 공지한 수신자(refs.requiredGate)에게 형식 2로만 보낸다 — 게이트가 없으면 knowledge-handoff-ungated,
 *   두 쪽이 형식 2를 함께 쓸 수 없으면 knowledge-handoff-version 으로 그 작업을 보류한다(형식 1로 내려 보내지 않는다: DB 신원을 가를 수 없다).
 * - 선택 참조만 있으면 함께 쓰는 가장 높은 형식으로 보낸다(형식 1은 항목 단위라 조각을 부모 항목으로 합치고, 40자 commit 만 나타낸다).
 * - 필수 참조를 보낼 수 없으면(미지원·미수락·게이트 없음·형식·상한·표현 불가·수신 범위 밖) 조용히 버리거나 자르지 않고 그 작업을 보류한다.
 * - 선택 참조는 보낼 수 없으면 사유와 함께 빼고 기존 경로로 진행한다.
 * - 접수(accepted)는 수신자가 참조를 저장했다는 뜻일 뿐 근거 검증 통과가 아니다.
 */
export const HANDOFF_CONTRACT = 'code-agent.master.knowledge';
export const MASTER_HANDOFF_VERSIONS = Object.freeze([1, 2]);
/** 수신자가 바이트 상한을 공지하지 않을 때 master가 스스로 지키는 상한 — 프롬프트 밖 구조화 필드라도 한 건을 작게 둔다 */
export const DEFAULT_MAX_BYTES = 32 * 1024;
const V1_ITEM_ID_CHARS = 512;
const CONTROL_CHAR = /\p{Cc}/u;
const COMMIT40 = /^[0-9a-f]{40}$/, SHA256 = /^[0-9a-f]{64}$/, GIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/, INDEX_ID = /^[0-9a-f]{32}$/;
const SOURCE_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/, HANDLE = /^[A-Za-z0-9_.:-]{1,64}$/;
const V1_KEYS = ['itemId', 'generation', 'commit', 'itemSha256', 'required'];
const V2_REQUIRED = ['indexId', 'indexGeneration', 'itemId', 'itemSha256', 'commit', 'sourceId', 'path', 'startLine', 'endLine'];
const V2_KEYS = [...V2_REQUIRED, 'segmentId', 'segmentSha256', 'segmentStartLine', 'segmentEndLine', 'handle', 'projectId', 'documentSha256', 'blobSha', 'required'];

const positiveInt = (v, max = 1_000_000) => Number.isSafeInteger(v) && v >= 1 && v <= max;

/**
 * hello 응답의 지식 인계 공지를 정규화한다. 공지가 없으면 지식 인계 이전 빌드(supported=false)다.
 * 알 수 없는 공지 형식은 지원하지 않는 것으로 본다 — 모르는 형식에 추측으로 싣지 않는다.
 */
const versionList = list => [...new Set(list.filter(v => positiveInt(v, 1000)))].sort((a, b) => a - b);
const NO_RECEIVER = { supported: false, accepted: false, mode: null, versions: [], max: 0, maxBytes: null, requiredGate: false, gate: null };
export function receiverCapability(hello) {
  if (hello?.unreachable) return { known: false, ...NO_RECEIVER, reason: 'receiver-unreachable' };
  const k = hello?.knowledge;
  if (k === undefined || k === null) return { known: false, ...NO_RECEIVER, reason: 'receiver-without-knowledge' };
  if (typeof k !== 'object' || k.schemaVersion !== 1 || !k.refs || typeof k.refs !== 'object') return { known: true, ...NO_RECEIVER, reason: 'receiver-unknown-capability' };
  const mode = ['off', 'shadow', 'enabled'].includes(k.mode) ? k.mode : null;
  // 형식 목록(공통 계약 hello 공지): refs.versions 가 지금 받는 형식이다(형식 2는 code-agent 어댑터가 색인 식별을 대조하는 등록일 때만).
  // refs.supportedVersions 는 그 빌드가 읽을 줄 아는 형식일 뿐 보낼 형식이 아니다. versions 를 공지하지 않은 수신자는 형식 1만 받는다(code-agent 3c5bbac)
  const versions = Array.isArray(k.refs.versions) ? versionList(k.refs.versions) : [1];
  const readable = Array.isArray(k.refs.supportedVersions) ? versionList(k.refs.supportedVersions) : null;
  // 지원 여부는 공지 꼴만 본다 — 지금 받는 형식이 비었으면 미수락이지 미지원이 아니다
  const supported = k.refs.supported === true && positiveInt(k.refs.max, 10000);
  // 진행 게이트 공지 — 있으면 수신자가 필수 근거 검증 결과를 상태 조회(state.knowledge)·재개 코드로 낸다. 없으면 그 결과를 통신 계약으로 받을 수 없다
  const gate = k.gate && typeof k.gate === 'object' && typeof k.gate.resume === 'string' ? { resume: k.gate.resume,
    actions: Array.isArray(k.gate.actions) ? k.gate.actions.filter(a => typeof a === 'string') : [],
    command: k.gate.command?.type === 'knowledge' && Array.isArray(k.gate.command.actions) ? { type: 'knowledge', actions: k.gate.command.actions.filter(a => typeof a === 'string') } : null } : null;
  // requiredGate: 필수 참조가 확인되기 전·실패하면 그 작업의 진행을 막고 상태로 알리는 수신자인가(없으면 false — 3c5bbac 는 required 를 받아도 막지 않는다)
  return { known: true, supported, accepted: supported && k.refs.accepted === true && versions.length > 0, mode, versions, ...(readable ? { readable } : {}), max: supported ? k.refs.max : 0,
    maxBytes: positiveInt(k.refs.maxBytes, 64 * 1024 * 1024) ? k.refs.maxBytes : null, requiredGate: supported && k.refs.requiredGate === true, gate,
    reason: supported ? null : 'receiver-capability-invalid' };
}
/** 두 쪽이 모두 받는 가장 높은 인계 형식. 없으면 null. canV2=false(색인 식별이 없는 V1 생산자 묶음)면 형식 1만 고른다 */
export function negotiatedVersion(capability, canV2 = true) {
  return [...MASTER_HANDOFF_VERSIONS].reverse().find(v => capability.versions.includes(v) && (v !== 2 || canV2)) ?? null;
}

/** code-agent core/serialize.ts canonicalJson 과 같은 바이트 — 키 정렬, 배열 순서 유지, 객체의 undefined 제외 */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : 1).map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
const refKey = ref => `${ref.itemId}\u0000${ref.segmentId ?? ''}`;
/** 인계의 정본 해시 — code-agent protocol.ts knowledgeDigest 와 같다(참조 순서 무관). 접수 영수증·작업 고정 인계와 대조한다 */
export function knowledgeDigest(payload) {
  const refs = [...payload.refs].sort((a, b) => refKey(a) < refKey(b) ? -1 : refKey(a) > refKey(b) ? 1 : 0);
  return `sha256:${createHash('sha256').update(canonicalJson({ version: payload.version, refs }), 'utf8').digest('hex')}`;
}

/**
 * 형식 1 참조 하나 — code-agent knowledgeHandoffOf와 같은 규칙으로 미리 검사한다. 표현할 수 없으면 사유를 돌려준다.
 * 형식 1에는 indexId·조각 식별이 없다. 조각을 가리킨 항목도 부모 항목 전체(itemSha256)로 대조하므로 더 엄격한 쪽이다.
 */
export function v1Ref(item, generation, required) {
  const id = item.itemId;
  if (typeof id !== 'string' || !id.length || id.length > V1_ITEM_ID_CHARS || !id.trim() || CONTROL_CHAR.test(id) || !id.includes(':') || !id.includes('#')) return { problem: 'item-id-format' };
  if (!positiveInt(generation, Number.MAX_SAFE_INTEGER)) return { problem: 'generation-format' };
  if (!COMMIT40.test(item.commit ?? '')) return { problem: 'commit-format' };
  if (!SHA256.test(item.itemSha256 ?? '')) return { problem: 'item-hash-format' };
  return { ref: { itemId: id, generation, commit: item.commit, itemSha256: item.itemSha256, required } };
}
const safeRelative = path => typeof path === 'string' && path !== '' && path.length <= 512 && !path.includes('\\') && !CONTROL_CHAR.test(path) && !path.startsWith('/') && !/^[A-Za-z]:/.test(path) &&
  !path.split('/').some(part => part === '' || part === '.' || part === '..');
/**
 * 형식 2 참조 하나 — 생산자 V2 items[].ref(ItemRef) 필드 이름 그대로에 required 를 더한다(code-agent refV2 와 같은 규칙).
 * 조각이면 조각 식별·해시·줄 범위를 함께 보낸다 — 수신자가 조각 단위로 대조한다. 값이 없는 선택 필드는 보내지 않는다(null 금지)
 */
export function v2Ref(item, required) {
  const id = item.itemId;
  if (typeof id !== 'string' || !id.length || id.length > V1_ITEM_ID_CHARS || !id.trim() || CONTROL_CHAR.test(id) || !id.includes(':') || !id.includes('#')) return { problem: 'item-id-format' };
  if (!INDEX_ID.test(item.indexId ?? '')) return { problem: 'index-id-format' };
  if (!positiveInt(item.indexGeneration, Number.MAX_SAFE_INTEGER)) return { problem: 'generation-format' };
  if (!SHA256.test(item.itemSha256 ?? '')) return { problem: 'item-hash-format' };
  if (!GIT_SHA.test(item.commit ?? '')) return { problem: 'commit-format' };
  if (!SOURCE_NAME.test(item.sourceId ?? '') || !safeRelative(item.path) || !id.startsWith(`${item.sourceId}:${item.path}#`)) return { problem: 'source-path-format' };
  if (!positiveInt(item.startLine, Number.MAX_SAFE_INTEGER) || !positiveInt(item.endLine, Number.MAX_SAFE_INTEGER) || item.startLine > item.endLine) return { problem: 'line-range-format' };
  const ref = { indexId: item.indexId, indexGeneration: item.indexGeneration, itemId: id, itemSha256: item.itemSha256, commit: item.commit, sourceId: item.sourceId,
    path: item.path, startLine: item.startLine, endLine: item.endLine };
  if (item.segmentId !== undefined && item.segmentId !== null) {
    if (typeof item.segmentId !== 'string' || item.segmentId.length > 600 || CONTROL_CHAR.test(item.segmentId) || !item.segmentId.startsWith(`${id}#`) || !SHA256.test(item.segmentSha256 ?? '') ||
      !positiveInt(item.segmentStartLine, Number.MAX_SAFE_INTEGER) || !positiveInt(item.segmentEndLine, Number.MAX_SAFE_INTEGER) || item.segmentStartLine > item.segmentEndLine ||
      item.segmentStartLine < item.startLine || item.segmentEndLine > item.endLine) return { problem: 'segment-format' };
    Object.assign(ref, { segmentId: item.segmentId, segmentSha256: item.segmentSha256, segmentStartLine: item.segmentStartLine, segmentEndLine: item.segmentEndLine });
  }
  if (typeof item.handle === 'string' && HANDLE.test(item.handle)) ref.handle = item.handle;
  if (typeof item.producerProjectId === 'string' && SOURCE_NAME.test(item.producerProjectId)) ref.projectId = item.producerProjectId;
  if (SHA256.test(item.documentSha256 ?? '')) ref.documentSha256 = item.documentSha256;
  if (GIT_SHA.test(item.blobSha ?? '')) ref.blobSha = item.blobSha;
  return { ref: { ...ref, required } };
}
const BUILDERS = { 1: (entries) => ({ version: 1, refs: entries.map(e => e.wire) }), 2: (entries) => ({ version: 2, refs: entries.map(e => e.wire) }) };

/** 수신자가 그 형식으로 받아 줄 꼴인지 다시 확인한다(변환 뒤 검증) — 엄격 파서가 거부할 값을 보내지 않는다 */
export function checkPayload(payload, capability) {
  const fail = message => { throw new DomainError('knowledge-handoff-invalid', message); };
  if (!payload || ![1, 2].includes(payload.version) || !capability.versions.includes(payload.version) || Object.keys(payload).some(k => !['version', 'refs'].includes(k))) fail('인계는 수신자가 받는 형식의 { version, refs }입니다.');
  if (!Array.isArray(payload.refs) || payload.refs.length < 1 || payload.refs.length > capability.max) fail('인계 참조 수가 수신 상한을 벗어났습니다.');
  if (Buffer.byteLength(canonicalJson(payload), 'utf8') > (capability.maxBytes ?? DEFAULT_MAX_BYTES)) fail('인계 크기가 수신 상한을 넘습니다.');
  const seen = new Set();
  for (const ref of payload.refs) {
    const keys = payload.version === 1 ? V1_KEYS : V2_KEYS;
    if (Object.keys(ref).some(k => !keys.includes(k)) || typeof ref.required !== 'boolean') fail(`인계 참조에 형식 ${payload.version} 밖 필드가 있습니다.`);
    if (payload.version === 2 && V2_REQUIRED.some(k => ref[k] === undefined || ref[k] === null)) fail('형식 2 필수 필드가 없습니다.');
    const again = payload.version === 1 ? v1Ref(ref, ref.generation, ref.required) : v2Ref({ ...ref, producerProjectId: ref.projectId }, ref.required);
    if (again.problem || canonicalJson(again.ref) !== canonicalJson(ref)) fail('인계 참조 형식이 수신 규칙과 맞지 않습니다.');
    if (seen.has(refKey(ref))) fail('인계 참조의 항목·조각 ID가 겹칩니다.');
    seen.add(refKey(ref));
  }
  return payload;
}

/**
 * 작업 하나의 인계 결정. 반환 { status, ... }:
 * - prepared: payload를 start submit에 싣는다(필수·선택 표시 포함)
 * - not-sent: 보낼 참조가 없다(선택 참조만 있고 수신 불가·모드 off 등) — 기존 배정 그대로. reason 은 enabled 면 공통 계약 코드(knowledge-handoff-*)다
 * - held: 필수 참조를 보낼 수 없다 — 이 작업만 보류하고 재검토·재계획을 기다린다(code로 사유)
 * mode는 master 프로젝트의 검색 모드다. off·shadow에서는 선택 참조를 새로 넘기지 않지만 이미 승인된 필수 의존은 계속 인계·검증을 요구한다.
 */
export function decideHandoff({ bundle, items, capability, mode, required }) {
  const retrieval = bundle.knowledge.retrieval;
  const base = { contract: HANDOFF_CONTRACT, bundleId: bundle.id, generation: retrieval.generation, ...(retrieval.indexId ? { indexId: retrieval.indexId } : {}),
    dependency: required.dependency, receiver: { known: capability.known, supported: capability.supported, accepted: capability.accepted, mode: capability.mode, versions: capability.versions, max: capability.max,
      ...(capability.maxBytes ? { maxBytes: capability.maxBytes } : {}), requiredGate: Boolean(capability.requiredGate), gate: Boolean(capability.gate),
      ...(capability.gate?.command ? { commands: capability.gate.command.actions } : {}) } };
  const needed = items.filter(i => required.refs.has(i.ref)), optional = items.filter(i => !required.refs.has(i.ref));
  const counts = { count: items.length, required: needed.length, optional: optional.length };
  const held = (code, extra = {}) => ({ ...base, ...counts, status: 'held', code, ...extra });
  const notSent = (reason, omitted = []) => ({ ...base, ...counts, status: 'not-sent', reason, omitted });
  // 공통 계약 송신 결정 순서: 수신 불가(통신 실패·미지원) → 미수락 → (필수가 있으면) 게이트·형식 2 → 상한. 형식이 맞아도 받지 않는 수신자는 미수락이다
  const unusable = capability.reason === 'receiver-unreachable' ? 'knowledge-receiver-unreachable' : !capability.supported ? 'knowledge-handoff-unsupported' : !capability.accepted ? 'knowledge-handoff-not-accepted' : null;
  // 선택 참조만이면 빼고 기존 경로로 진행한다 — 뺀 참조마다 같은 사유를 남긴다(공통 계약 송신 결정 사례의 omitted)
  const omitAll = reason => notSent(reason, items.map(i => ({ ref: i.ref, reason })));
  if (unusable) return needed.length ? held(unusable) : omitAll(mode === 'enabled' ? unusable : 'knowledge-disabled');
  // 형식 2는 V2 생산자 묶음(색인 식별이 있는 항목)일 때만 만들 수 있다
  const canV2 = Boolean(retrieval.indexId) && items.every(i => i.scopeRole !== 'project' || INDEX_ID.test(i.indexId ?? ''));
  let version;
  if (needed.length) {
    // 필수 참조: 진행 게이트가 없는 수신자는 required 를 받아도 막지 않는다 — 보내지 않고 보류한다. 형식 1에는 indexId 가 없어 다른 DB의 같은 세대를 가를 수 없다
    if (!capability.requiredGate) return held('knowledge-handoff-ungated');
    if (!canV2 || !capability.versions.includes(2)) return held('knowledge-handoff-version', { sender: canV2 ? [1, 2] : [1], receiver: capability.versions });
    version = 2;
  } else {
    version = negotiatedVersion(capability, canV2);
    if (!version) return omitAll(mode === 'enabled' ? 'knowledge-handoff-version' : 'knowledge-disabled');
  }
  // 수신자는 자기 저장소 원본의 항목만 대조한다 — 허용 연결(외부 계약) 항목은 수신 범위 밖이다. 필수면 범위를 넓히지 않고 보류한다
  const outside = items.filter(i => i.scopeRole !== 'project');
  if (needed.some(i => i.scopeRole !== 'project')) return held('knowledge-handoff-scope', { refs: outside.filter(i => required.refs.has(i.ref)).map(i => i.ref) });
  const omitted = [];
  const entries = [];
  for (const item of items) {
    const isRequired = required.refs.has(item.ref);
    if (!isRequired && mode !== 'enabled') { omitted.push({ ref: item.ref, reason: 'knowledge-disabled' }); continue; }
    if (item.scopeRole !== 'project') { omitted.push({ ref: item.ref, reason: 'receiver-scope' }); continue; }
    const converted = version === 2 ? v2Ref(item, isRequired) : v1Ref(item, item.indexGeneration ?? retrieval.generation, isRequired);
    if (converted.problem) {
      if (isRequired) return held('knowledge-handoff-unrepresentable', { refs: [item.ref], problem: converted.problem });
      omitted.push({ ref: item.ref, reason: converted.problem }); continue;
    }
    // 형식 1은 항목 단위다 — 같은 항목의 조각들은 부모 항목 참조 하나로 합친다(하나라도 필수면 필수). 형식 2는 항목·조각 단위로 가른다.
    // 같은 열쇠에 다른 해시는 표현할 수 없다
    const same = entries.find(e => refKey(e.wire) === refKey(converted.ref));
    if (same) {
      const { required: _a, ...left } = same.wire, { required: _b, ...right } = converted.ref;
      if (canonicalJson(left) !== canonicalJson(right)) {
        if (isRequired || same.required) return held('knowledge-handoff-unrepresentable', { refs: [same.ref, item.ref], problem: 'item-id-collision' });
        omitted.push({ ref: item.ref, reason: 'item-id-collision' }); continue;
      }
      same.merged.push(item.ref);
      if (isRequired && !same.required) { same.required = true; same.wire = { ...same.wire, required: true }; }
      continue;
    }
    entries.push({ ref: item.ref, required: isRequired, wire: converted.ref, merged: [] });
  }
  // 보낼 참조가 하나도 남지 않았다(선택 참조가 모두 수신 범위 밖·표현 불가·세대 소실). 모드가 enabled면 꺼짐과 구별한다 — 개별 사유는 omitted
  if (!entries.length) return notSent(mode === 'enabled' ? 'no-sendable-refs' : 'knowledge-disabled', omitted);
  // 상한: 필수는 자르지 않는다. 필수만으로 넘치면 보류(작업을 나눠 재계획), 선택은 뒤에서부터 뺀다
  const maxBytes = capability.maxBytes ?? DEFAULT_MAX_BYTES;
  const requiredEntries = entries.filter(e => e.required), optionalEntries = entries.filter(e => !e.required);
  const bytesOf = list => Buffer.byteLength(canonicalJson(BUILDERS[version](list)), 'utf8');
  if (requiredEntries.length > capability.max || requiredEntries.length && bytesOf(requiredEntries) > maxBytes)
    return held('knowledge-handoff-limit', { limit: { max: capability.max, maxBytes, required: requiredEntries.length } });
  let chosen = [...requiredEntries, ...optionalEntries];
  while (chosen.length > capability.max || bytesOf(chosen) > maxBytes) {
    const drop = chosen.findLast(e => !e.required);
    omitted.push({ ref: drop.ref, reason: 'receiver-limit' });
    chosen = chosen.filter(e => e !== drop);
  }
  const payload = checkPayload(BUILDERS[version](chosen), capability);
  return { ...base, ...counts, status: 'prepared', version, payload, hash: hash(payload), digest: knowledgeDigest(payload), bytes: bytesOf(chosen), sent: chosen.length,
    sentRequired: chosen.filter(e => e.required).length, refs: chosen.map(e => ({ ref: e.ref, itemId: e.wire.itemId, ...(e.wire.segmentId ? { segmentId: e.wire.segmentId } : {}), required: e.required,
      ...(e.merged.length ? { merged: e.merged } : {}) })), omitted };
}

/**
 * 접수 응답과 보낸 인계를 대조한다. 수신자가 돌려준 참조 수가 다르거나, 정본 해시(digest)·형식을 돌려줬는데 보낸 인계와 다르면 접수로 보지 않는다.
 * 3c5bbac 수신자는 참조 수만 돌려준다(digest 없음 — 수만 대조). receipt('stored')·verification 은 수신자의 말 그대로 남긴다(접수 ≠ 검증)
 */
export function receiptOf(handoff, accepted) {
  const k = accepted?.knowledge, refs = k?.refs;
  const digest = typeof k?.digest === 'string' ? k.digest : null;
  const counted = Number.isInteger(refs) && refs === handoff.payload.refs.length;
  const same = digest === null || digest === knowledgeDigest(handoff.payload);
  return { at: new Date().toISOString(), runId: accepted?.runId ?? null, acceptedRefs: Number.isInteger(refs) ? refs : null,
    ...(digest ? { receiverDigest: digest, digestMatched: same } : {}), ...(typeof k?.receipt === 'string' ? { receipt: k.receipt } : {}),
    ...(typeof k?.verification === 'string' ? { receiverVerification: k.verification } : {}),
    ...(Number.isInteger(k?.version) ? { receiverVersion: k.version } : {}),
    state: counted && same && (k?.version === undefined || k.version === handoff.payload.version) ? 'accepted' : 'receipt-mismatch' };
}

/**
 * code-agent 진행 게이트 판정(상태 조회의 knowledge — knowledgeGate.ts knowledgeView)을 master 의 검증 관찰로 옮긴다.
 * - verified → passed(기록 시각·만료 포함). 통과는 근거 대조가 끝났다는 뜻일 뿐 승인·테스트·완료 증거가 아니다.
 * - blocked + knowledge-replan → failed(참조가 지금 근거와 맞지 않는다 — 재계획), blocked + knowledge-reverify → unverified(같은 참조 재검증으로 풀린다)
 * - 다른 인계(digest 불일치)나 다른 작업의 판정은 이 인계의 결과로 쓰지 않는다
 */
export function gateVerification(view, handoff, workId) {
  const base = { source: 'code-agent-gate' };
  if (!view || typeof view !== 'object' || typeof view.state !== 'string') return { state: 'not-reported', ...base };
  if (workId && view.workId !== workId) return { state: 'not-reported', ...base, reason: 'other-work' };
  if (view.digest !== handoff.digest) return { state: 'not-reported', ...base, reason: 'digest-mismatch', digest: typeof view.digest === 'string' ? view.digest : null };
  const refs = list => (Array.isArray(list) ? list : []).slice(0, 20).map(r => ({ itemId: String(r?.itemId ?? ''), ...(typeof r?.segmentId === 'string' ? { segmentId: r.segmentId } : {}),
    reason: typeof r?.reason === 'string' ? r.reason.slice(0, 64) : 'unknown', ...(typeof r?.cause === 'string' ? { cause: r.cause } : {}), ...(typeof r?.recovery === 'string' ? { recovery: r.recovery } : {}) }));
  const at = typeof view.verifiedAt === 'string' ? { verifiedAt: view.verifiedAt, expiresAt: view.expiresAt ?? null, by: view.by ?? null } : {};
  if (view.state === 'verified') return { state: 'passed', ...base, ...at, checked: Number.isInteger(view.refs) ? view.refs : null, ...(view.optional?.length ? { optionalFailures: refs(view.optional) } : {}) };
  if (view.state === 'blocked') {
    const action = view.action === 'knowledge-replan' ? 'knowledge-replan' : 'knowledge-reverify';
    return { state: action === 'knowledge-replan' ? 'failed' : 'unverified', ...base, ...at, action, failures: refs(view.blocked) };
  }
  if (view.state === 'pending') return { state: 'pending', ...base };
  return { state: 'not-reported', ...base };
}

/** 수신자가 작업에 고정해 둔 인계가 보낸 인계와 같은지(정본 해시, 순서 무관) — 저장 확인일 뿐 내용 검증이 아니다 */
export function sameStoredRefs(payload, stored) {
  if (!stored || stored.version !== payload.version || !Array.isArray(stored.refs)) return false;
  // 수신자는 required 생략을 true 로 저장한다 — 같은 규칙으로 맞춘 뒤 대조한다
  return knowledgeDigest({ version: stored.version, refs: stored.refs.map(r => ({ ...r, required: r.required ?? true })) }) === knowledgeDigest(payload);
}
