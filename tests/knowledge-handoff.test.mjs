import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { canonicalJson, checkPayload, decideHandoff, gateVerification, knowledgeDigest, receiptOf, receiverCapability, sameStoredRefs } from '../packages/knowledge/handoff.mjs';
import { deliveryBlock } from '../packages/knowledge/evidence.mjs';

/**
 * master → code-agent 지식 인계의 순수 규칙. 송신 결정과 수신 형식의 정본은 공통 계약(agent-knowledge docs/integration.md 「인계 형식」·
 * 「송신 결정」)과 그 정본 사례(docs/contract/handoff-cases.json — tests/fixtures 에 복사)다. 수신 구현은 code-agent protocol.ts(knowledgeHandoffOf·
 * knowledgeDigest), control.ts hello knowledge 공지, knowledgeGate.ts 게이트 판정이다. 실제 수신자와의 주고받기는 knowledge-integration.test.mjs 가 본다.
 */
const COMMIT = 'fddc93b1a7e12289b877735ee567d002578680dc';
const SHA = c => c.repeat(64);
const INDEX = 'e87e206a6dffee1071ec027094015496';
const item = (ref, extra = {}) => ({ ref, scopeRole: 'project', itemId: `kb:docs/rules.md#${ref}`, sourceId: 'kb', producerProjectId: 'orders', path: 'docs/rules.md', startLine: 3, endLine: 9,
  commit: COMMIT, blobSha: 'bc16e633a7abaa97a669620ee458dadda03640c7', documentSha256: SHA('d'), itemSha256: SHA('a'), ...extra });
const v2Item = (ref, extra = {}) => item(ref, { indexId: INDEX, indexGeneration: 1, handle: 'ak-90bde07ff56f7dbe3cfe', ...extra });
const bundle = (indexId = null) => ({ id: 'bundle-1', knowledge: { retrieval: { generation: 1, ...(indexId ? { indexId } : {}) } } });
const hello = (refs, gate) => ({ knowledge: { schemaVersion: 1, mode: 'enabled', refs: { supported: true, accepted: true, max: 20, ...refs }, ...(gate ? { gate } : {}) } });
const GATE = { resume: 'knowledge-blocked', actions: ['knowledge-reverify', 'knowledge-replan'], command: { type: 'knowledge', actions: ['verify', 'replace'] } };
/** code-agent 게이트 빌드가 색인 대조 등록에서 내는 공지(control.ts knowledgeCapability) */
const GATED_V2 = { versions: [1, 2], supportedVersions: [1, 2], maxBytes: 32768, requiredGate: true };
const required = (...refs) => ({ declared: true, dependency: 'declared', refs: new Set(refs) });

test('수신 공지: versions 가 지금 받는 형식이고 supportedVersions 는 읽을 줄 아는 형식일 뿐, 공지 없는 이전 빌드는 형식 1·게이트 없음', () => {
  // 게이트 빌드의 기본 등록(색인 대조 없음): 읽을 줄은 1·2, 지금 받는 것은 1
  const current = receiverCapability(hello({ versions: [1], supportedVersions: [1, 2], maxBytes: 32768, requiredGate: true }, GATE));
  assert.deepEqual([current.versions, current.readable, current.requiredGate, current.maxBytes], [[1], [1, 2], true, 32768]);
  assert.deepEqual(current.gate.command.actions, ['verify', 'replace']);
  const old = receiverCapability(hello({}));
  assert.deepEqual([old.versions, old.gate, old.requiredGate, old.accepted], [[1], null, false, true]);
  // 지금 받는 형식이 비면 미수락이지 미지원이 아니다(지원 여부는 공지 꼴만 본다)
  const none = receiverCapability(hello({ versions: [], supportedVersions: [1, 2], requiredGate: true }));
  assert.deepEqual([none.supported, none.accepted], [true, false]);
  // 게이트 공지는 refs.requiredGate === true 만 인정한다
  assert.equal(receiverCapability(hello({ requiredGate: 'yes' })).requiredGate, false);
  assert.equal(receiverCapability({ unreachable: true }).reason, 'receiver-unreachable');
  assert.equal(receiverCapability({}).reason, 'receiver-without-knowledge');
  assert.equal(receiverCapability({ knowledge: { schemaVersion: 9, refs: {} } }).supported, false);
  assert.equal(receiverCapability(hello({ max: 0 })).supported, false);
});

test('정본 해시: code-agent knowledgeDigest 와 같은 바이트(키 정렬·참조 순서 무관) — 실제 수신자가 돌려준 값과 같다', () => {
  // code-agent 3c5bbac+게이트 빌드의 실제 접수 응답 digest(임시 저장소 실측)
  const real = { version: 1, refs: [{ itemId: 'kb:docs/rules.md#br-001-취소', generation: 1, commit: COMMIT, itemSha256: '4def204d325b7c0e6b6d9229ca30576e3e2a3166b844469564fc142b42d7fdd7', required: true }] };
  assert.equal(knowledgeDigest(real), 'sha256:a41e52b6434cb5e485fe548093bb35771caca5268c03db8ddd15657e53c12180');
  const a = { version: 1, refs: [{ itemId: 'kb:x#b', generation: 1, commit: COMMIT, itemSha256: SHA('b'), required: true }, { itemId: 'kb:x#a', generation: 1, commit: COMMIT, itemSha256: SHA('a'), required: false }] };
  assert.equal(knowledgeDigest(a), knowledgeDigest({ version: 1, refs: [...a.refs].reverse() }));
  assert.notEqual(knowledgeDigest(a), knowledgeDigest({ version: 2, refs: a.refs }));
  assert.equal(canonicalJson({ b: 1, a: [2, { d: undefined, c: 'x' }] }), '{"a":[2,{"c":"x"}],"b":1}');
});

test('형식 2: 필수 참조는 게이트 수신자에게 형식 2로만 — 조각은 따로, 같은 열쇠는 하나(필수 우선), null 선택 필드는 보내지 않는다', () => {
  const capability = receiverCapability(hello(GATED_V2, GATE));
  const seg = { segmentId: 'kb:docs/rules.md#r1#s1', segmentSha256: SHA('c'), segmentStartLine: 4, segmentEndLine: 6 };
  const items = [v2Item('r1', { itemId: 'kb:docs/rules.md#r1' }), v2Item('r1', { ...seg, ref: 'r1-seg', itemId: 'kb:docs/rules.md#r1' }), v2Item('r1', { ref: 'r1-dup', itemId: 'kb:docs/rules.md#r1' })];
  const d = decideHandoff({ bundle: bundle(INDEX), items, capability, mode: 'enabled', required: required('r1-dup') });
  assert.equal(d.status, 'prepared');
  assert.equal(d.version, 2);
  assert.equal(d.receiver.requiredGate, true);
  assert.equal(d.payload.refs.length, 2, '항목 참조와 조각 참조는 다른 열쇠다');
  const whole = d.payload.refs.find(r => !r.segmentId), part = d.payload.refs.find(r => r.segmentId);
  assert.equal(whole.required, true, '같은 열쇠의 하나가 필수면 필수로 합친다');
  assert.deepEqual(d.refs.find(r => !r.segmentId).merged, ['r1-dup']);
  assert.equal(part.segmentSha256, SHA('c'));
  assert.equal(whole.projectId, 'orders');
  assert.ok(!Object.values(whole).includes(null));
  assert.equal(d.digest, knowledgeDigest(d.payload));
  assert.doesNotThrow(() => checkPayload(d.payload, capability));
  // 수신자가 지금 형식 1만 받으면(색인 대조 없는 등록) 필수 참조는 형식 1로 내려 보내지 않고 보류한다
  const v1Receiver = receiverCapability(hello({ ...GATED_V2, versions: [1] }, GATE));
  const heldV1 = decideHandoff({ bundle: bundle(INDEX), items, capability: v1Receiver, mode: 'enabled', required: required('r1-dup') });
  assert.deepEqual([heldV1.status, heldV1.code, heldV1.receiver], ['held', 'knowledge-handoff-version', heldV1.receiver]);
  // 선택 참조만이면 같은 묶음도 형식 1(항목 단위 — 조각은 부모 항목으로 합친다)
  const v1 = decideHandoff({ bundle: bundle(INDEX), items, capability: v1Receiver, mode: 'enabled', required: required() });
  assert.equal(v1.version, 1);
  assert.equal(v1.payload.refs.length, 1);
  assert.deepEqual(Object.keys(v1.payload.refs[0]).sort(), ['commit', 'generation', 'itemId', 'itemSha256', 'required']);
  // V1 생산자 묶음(색인 식별 없음)의 필수 참조는 수신자가 2를 받아도 보낼 형식이 없다. 선택 참조는 형식 1
  assert.equal(decideHandoff({ bundle: bundle(), items: [item('r1')], capability, mode: 'enabled', required: required('r1') }).code, 'knowledge-handoff-version');
  assert.equal(decideHandoff({ bundle: bundle(), items: [item('r1')], capability, mode: 'enabled', required: required() }).version, 1);
});

test('진행 게이트가 없는 수신자(3c5bbac)에게는 필수 참조를 보내지 않고 보류한다 — 미수락이 먼저다', () => {
  const old = receiverCapability(hello({}));
  const d = decideHandoff({ bundle: bundle(INDEX), items: [v2Item('r1')], capability: old, mode: 'enabled', required: required('r1') });
  assert.deepEqual([d.status, d.code], ['held', 'knowledge-handoff-ungated']);
  // 형식이 맞지 않아도 받지 않는 수신자면 미수락으로 막는다(형식 불일치보다 먼저)
  const closed = receiverCapability(hello({ ...GATED_V2, accepted: false, versions: [1] }));
  assert.equal(decideHandoff({ bundle: bundle(), items: [item('r1')], capability: closed, mode: 'enabled', required: required('r1') }).code, 'knowledge-handoff-not-accepted');
  const notSent = decideHandoff({ bundle: bundle(), items: [item('r1')], capability: closed, mode: 'enabled', required: required() });
  assert.deepEqual([notSent.status, notSent.reason], ['not-sent', 'knowledge-handoff-not-accepted']);
});

test('형식 2 표현 불가 필수 참조는 자르거나 형식 1로 몰래 낮추지 않고 보류한다', () => {
  const capability = receiverCapability(hello({ versions: [2], requiredGate: true }));
  const bad = v2Item('r1', { path: '../escape.md', itemId: 'kb:../escape.md#r1' });
  const d = decideHandoff({ bundle: bundle(INDEX), items: [bad], capability, mode: 'enabled', required: required('r1') });
  assert.equal(d.status, 'held');
  assert.equal(d.code, 'knowledge-handoff-unrepresentable');
  // 형식 2만 받는 수신자에게 V1 생산자 묶음은 선택 참조도 보낼 형식이 없다
  const none = decideHandoff({ bundle: bundle(), items: [item('r1')], capability, mode: 'enabled', required: required() });
  assert.deepEqual([none.status, none.reason], ['not-sent', 'knowledge-handoff-version']);
});

test('크기 상한: 정본 JSON 바이트로 재고, 필수만으로 넘치면 보류, 선택은 뒤에서부터 사유와 함께 뺀다', () => {
  const items = Array.from({ length: 6 }, (_, i) => v2Item(`r${i}`, { itemId: `kb:docs/rules.md#r${i}-${'x'.repeat(300)}` }));
  const small = receiverCapability(hello({ ...GATED_V2, maxBytes: 2400 }));
  const d = decideHandoff({ bundle: bundle(INDEX), items, capability: small, mode: 'enabled', required: required('r0') });
  assert.equal(d.status, 'prepared');
  assert.ok(d.bytes <= 2400);
  assert.ok(d.omitted.every(o => o.reason === 'receiver-limit') && d.omitted.length > 0);
  assert.deepEqual(d.omitted.map(o => o.ref), ['r5', 'r4', 'r3', 'r2', 'r1'].slice(0, d.omitted.length), '선택은 뒤에서부터 뺀다');
  assert.equal(d.payload.refs[0].required, true);
  const held = decideHandoff({ bundle: bundle(INDEX), items, capability: small, mode: 'enabled', required: required('r0', 'r1', 'r2', 'r3', 'r4', 'r5') });
  assert.deepEqual([held.status, held.code], ['held', 'knowledge-handoff-limit']);
});

test('접수 영수증: 참조 수·형식·정본 해시가 모두 같아야 accepted — 해시 없는 이전 수신자는 수만, 접수는 검증이 아니다', () => {
  // 3c5bbac 에는 선택 참조만 형식 1로 간다
  const d = decideHandoff({ bundle: bundle(), items: [item('r1'), item('r2', { itemId: 'kb:docs/rules.md#r2', itemSha256: SHA('b') })], capability: receiverCapability(hello({})), mode: 'enabled', required: required() });
  assert.deepEqual([d.status, d.version, d.sentRequired], ['prepared', 1, 0]);
  const ok = receiptOf(d, { runId: 'run-1', knowledge: { refs: 2, version: 1, digest: d.digest, receipt: 'stored', verification: 'pending' } });
  assert.equal(ok.state, 'accepted');
  assert.equal(ok.digestMatched, true);
  assert.equal(ok.receiverVerification, 'pending');
  assert.equal(receiptOf(d, { knowledge: { refs: 2, version: 1, digest: `sha256:${SHA('0')}` } }).state, 'receipt-mismatch');
  assert.equal(receiptOf(d, { knowledge: { refs: 2, version: 2, digest: d.digest } }).state, 'receipt-mismatch');
  assert.equal(receiptOf(d, { knowledge: { refs: 1 } }).state, 'receipt-mismatch');
  assert.equal(receiptOf(d, { knowledge: { refs: 2 } }).state, 'accepted', '3c5bbac 수신자는 참조 수만 돌려준다');
  assert.equal(receiptOf(d, {}).state, 'receipt-mismatch');
  // 수신자 저장본: required 생략은 true 로 맞춰 정본 해시로 비교(순서 무관)
  const stored = { version: 1, refs: d.payload.refs.map(r => (r.required ? (({ required: _r, ...rest }) => rest)(r) : r)).reverse() };
  assert.equal(sameStoredRefs(d.payload, stored), true);
  assert.equal(sameStoredRefs(d.payload, { ...stored, refs: stored.refs.slice(1) }), false);
});

test('게이트 판정 대응: verified→passed, replan→failed(막힘), reverify→unverified(재검증 대기), 다른 작업·다른 인계는 쓰지 않는다', () => {
  const handoff = { status: 'prepared', sentRequired: 1, digest: 'sha256:abc' };
  const view = extra => ({ workId: 'MA-1', digest: 'sha256:abc', refs: 1, required: 1, blocked: [], optional: [], ...extra });
  assert.equal(gateVerification(view({ state: 'verified', verifiedAt: '2026-11-10T00:00:00.000Z', by: 'context' }), handoff, 'MA-1').state, 'passed');
  const failed = gateVerification(view({ state: 'blocked', action: 'knowledge-replan', blocked: [{ itemId: 'kb:x#a', reason: 'content-changed', cause: 'source-changed', recovery: 'replan' }] }), handoff, 'MA-1');
  assert.deepEqual([failed.state, failed.action, failed.failures[0].reason], ['failed', 'knowledge-replan', 'content-changed']);
  const pending = gateVerification(view({ state: 'blocked', action: 'knowledge-reverify', blocked: [{ itemId: 'kb:x#a', reason: 'not-verified' }] }), handoff, 'MA-1');
  assert.equal(pending.state, 'unverified');
  assert.equal(gateVerification(view({ state: 'verified' }), handoff, 'MA-2').state, 'not-reported');
  assert.equal(gateVerification(view({ state: 'verified', digest: 'sha256:other' }), handoff, 'MA-1').reason, 'digest-mismatch');
  assert.equal(gateVerification(null, handoff, 'MA-1').state, 'not-reported');
  // 진행 막힘: 재계획 판정은 verification-failed, 재검증 대기는 verification-pending, 통과는 막지 않을 뿐(완료 증거 아님)
  const block = verification => deliveryBlock({ ...handoff, delivery: { state: 'accepted', stored: 'matched', verification } });
  assert.equal(block(failed), 'knowledge-verification-failed');
  assert.equal(block(pending), 'knowledge-verification-pending');
  assert.equal(block({ state: 'passed' }), null);
  assert.equal(deliveryBlock({ ...handoff, sentRequired: 0, delivery: { state: 'accepted', verification: failed } }), null, '선택 참조만 보낸 시도는 막지 않는다');
});

/*
 * 공통 계약 정본 사례 — agent-knowledge `1d1fdba`의 docs/contract/handoff-cases.json 을 tests/fixtures/agent-knowledge-handoff-cases.json 으로
 * 그대로 복사했다. 다른 저장소를 읽지 않고 재현한다. 정본이 바뀌면 다시 복사하고 이 시험을 돌린다.
 */
const CASES = JSON.parse(readFileSync(new URL('./fixtures/agent-knowledge-handoff-cases.json', import.meta.url), 'utf8'));
const PLACEHOLDERS = { '<index-id>': INDEX, '<index-id:other>': 'f'.repeat(32), '<handle>': 'ak-90bde07ff56f7dbe3cfe' };
const fill = value => JSON.parse(JSON.stringify(value).replace(/<index-id(?::other)?>|<handle>/g, m => PLACEHOLDERS[m]));
/** 정본 refPool 의 생산자 ref 를 master 봉인 묶음 항목 꼴로 옮긴다(링크 프로젝트 항목은 허용 연결 항목) */
const poolItem = (use, n, role, canV2) => {
  const { projectId, segmentId, segmentSha256, segmentStartLine, segmentEndLine, indexId, indexGeneration, handle, ...rest } = CASES.refPool[use];
  return { ref: `k${n}-${use}`, scopeRole: role === 'link' ? 'link' : 'project', producerProjectId: projectId, ...rest,
    ...(segmentId ? { segmentId, segmentSha256, segmentStartLine, segmentEndLine } : {}), indexGeneration, ...(canV2 ? { indexId, handle } : {}) };
};

test('공통 계약 송신 결정 사례(hello)를 master 송신 결정이 참조·뺀 목록·정본 해시까지 그대로 따른다', () => {
  assert.equal(CASES.schema, 'agent-knowledge.handoff-cases');
  assert.equal(CASES.hello.length, 19);
  for (const c of CASES.hello) {
    const capability = receiverCapability(c.knowledge === null ? {} : { knowledge: c.knowledge });
    const canV2 = c.senderVersions.includes(2);
    const items = c.refs.map((r, n) => poolItem(r.use, n, r.role, canV2));
    const needed = c.refs.flatMap((r, n) => r.required ? [items[n].ref] : []);
    const index = canV2 ? CASES.refPool[c.refs[0]?.use ?? 'auth-item'].indexId : null;
    const d = decideHandoff({ bundle: bundle(index), items, capability, mode: 'enabled', required: required(...needed) });
    const byRef = new Map(items.map(i => [i.ref, i]));
    const omitted = list => list.map(o => ({ itemId: byRef.get(o.ref).itemId, ...(byRef.get(o.ref).segmentId ? { segmentId: byRef.get(o.ref).segmentId } : {}), reason: o.reason }));
    let got;
    if (!items.length) got = { action: 'none' };
    else if (d.status === 'held') got = { action: 'hold', reason: d.code };
    else if (d.status === 'prepared') got = { action: 'send', version: d.version, refs: d.refs.map(r => ({ itemId: r.itemId, ...(r.segmentId ? { segmentId: r.segmentId } : {}), required: r.required })),
      omitted: omitted(d.omitted), digest: d.digest };
    else got = { action: 'omit', reason: d.reason, omitted: omitted(d.omitted) };
    assert.deepEqual(got, c.expect, c.id);
    if (d.status === 'prepared') assert.doesNotThrow(() => checkPayload(d.payload, capability), c.id);
  }
});

test('공통 계약 수신 사례: 수신자가 받는 꼴은 master 검사도 받고 정본 해시가 같으며, 수신자가 거절하는 꼴은 master 가 보내지 않는다', () => {
  assert.equal(CASES.cases.length, 33);
  let accepted = 0, refused = 0;
  for (const raw of CASES.cases) {
    const c = fill(raw);
    const capability = receiverCapability(hello({ versions: c.receiverVersions, max: CASES.limits.maxRefs, maxBytes: CASES.limits.maxBytes, requiredGate: true }));
    if (c.expect.accepted) {
      // 수신자가 정규화한 꼴(required 채움) = master 가 만드는 꼴. master 는 required 를 늘 적는다. 접수 범위(submit)·생산자 확인(verification)은 수신자 몫이다
      const payload = { version: c.knowledge.version, refs: c.expect.refs };
      assert.doesNotThrow(() => checkPayload(payload, capability), c.id);
      if (c.expect.digest) assert.equal(knowledgeDigest(payload), c.expect.digest, c.id);
      accepted++;
    } else {
      assert.throws(() => checkPayload(c.knowledge, capability), e => e.code === 'knowledge-handoff-invalid', `${c.id}: ${c.expect.reason}`);
      refused++;
    }
  }
  assert.deepEqual([accepted, refused], [14, 19]);
});
