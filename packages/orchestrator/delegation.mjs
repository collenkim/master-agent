/** master 소유의 복구 동작에만 적용한다. code-agent의 사람 승인을 대신하지 않는다. */
export function delegationVerdict(context, proposal, used) {
  if (context.failure.state !== 'verification-failed') return { allowed: false, reason: '실패가 확인된 검증만 복구할 수 있습니다.', code: 'unconfirmed-failure' };
  if (used >= 2) return { allowed: false, reason: '한 시도에서 자동 복구 2회에 도달했습니다. 추가 근거·계획 검토가 필요합니다.', code: 'recovery-limit' };
  if (!['repair', 'reverify'].includes(proposal.action)) return { allowed: false, reason: '추가 정보·재계획·사람 결정이 먼저 필요합니다.', code: proposal.action };
  if (context.remote.work?.id !== context.codeAgentWorkId) return { allowed: false, reason: '외부 작업 ID가 다릅니다.', code: 'wrong-work' };
  if (context.remote.consents?.readable !== true || !Array.isArray(context.remote.consents.open) || context.remote.consents.open.length || context.remote.findings?.blocking || context.remote.questions?.unanswered?.length || context.remote.questions?.unverified?.length ||
      context.remote.request?.status !== 'confirmed' || context.remote.approval?.status !== 'approved') return { allowed: false, reason: '기존 code-agent 동의·요구 확정·계획 승인 절차가 필요합니다. 외부 승인 위임 API는 지원되지 않습니다.', code: 'external-approval-required' };
  if (proposal.action === 'repair' && context.remote.resume?.code !== 'ready') return { allowed: false, reason: 'code-agent가 수정 가능한 상태가 아닙니다. 기존 호스트에서 단계를 정리해야 합니다.', code: 'external-not-ready' };
  return { allowed: true, reason: '확인된 실패에 대해 기존 작업·파일 범위·검증 계약 안의 복구만 수행합니다.', code: 'master-recovery' };
}
