import { hash, now } from '../domain/contracts.mjs';

/** 재접속·진척 표시에 필요한 값만 보존한다. 실행 전 권한·질문·소유권은 호스트에서 다시 조회한다. */
export function remoteStateSummary(state, runId = null) {
  if (!state) return null;
  return { stateVersion: state.stateVersion, observedAt: state.observedAt ?? now(), hash: hash(state), runId,
    status: state.resume?.code ?? null, phase: state.work?.phase ?? null,
    work: state.work ? { id: state.work.id, phase: state.work.phase } : null,
    resume: state.resume ? { code: state.resume.code } : null,
    openConsents: state.consents?.open?.length ?? 0,
    deliveryConsentsOnly: Boolean(state.consents?.open?.length && state.consents.open.every(c => c.action === 'deliver')),
    unansweredQuestions: state.questions?.unanswered?.length ?? 0 };
}
