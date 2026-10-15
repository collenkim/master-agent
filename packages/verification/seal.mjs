import { hash, requireThat } from '../domain/contracts.mjs';
export const sealOf = value => { const { seal, revision, ...body } = value; return hash(body); };
export const assertSealed = value => requireThat(value.seal === sealOf(value), 'invalid-evidence', '증거 기록이 변경됐습니다.');
