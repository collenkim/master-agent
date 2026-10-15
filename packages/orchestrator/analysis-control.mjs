import { Engine } from './engine.mjs';
import { requireThat, now } from '../domain/contracts.mjs';

/** 읽기 전용 분석의 결과 적용 권한을 취소한다. 개발 프로세스 종료와 구분한다. */
export function stopAnalysis(store, id, runId, expectedRevision) {
  const engine = new Engine(store);
  return store.transaction(() => {
    const m = engine.checked(id, expectedRevision);
    const analysis = store.get('analysis-run', runId), recovery = store.get('recovery-run', runId);
    const run = analysis ?? recovery;
    const attempt = recovery ? m.attempts.find(a => a.recoveryBusy === runId) : undefined;
    requireThat(run?.missionId === id && (analysis ? m.analysisRunId === runId && !m.plans.some(p => p.analysisId === runId) &&
      (run.status === 'running' || ['analyzing', 'paused'].includes(m.state) && ['ready', 'needs-context', 'needs-human', 'invalid'].includes(run.status)) :
      attempt && run.state === 'analyzing' && !run.executedAt), 'invalid-state', '현재 진행 중인 읽기 전용 분석만 중단할 수 있습니다.');
    const d = engine.decision(m, 'stop-analysis', { actor: 'operator', reason: '진행 중 분석의 결과 적용 권한을 취소하고 재분석을 준비합니다.', evidence: [runId],
      alternatives: ['응답 대기', '현재 분석 무효화'], nextAction: 'reanalyze', verification: '현재 분석 ID·목표 버전 대조; 실행 잠금 유지' });
    if (analysis) { run.status = 'interrupted'; m.planningHold = true; }
    else { run.state = 'interrupted'; delete attempt.recoveryBusy; }
    run.finishedAt = now(); run.interruptionDecisionId = d.id;
    store.put(analysis ? 'analysis-run' : 'recovery-run', run, run.revision);
    if (m.state !== 'paused') m.state = 'blocked';
    m.reason = '분석 결과 적용을 중단했습니다. 새 분석은 별도 호출해야 합니다.';
    return engine.save(m, 'analysis-interrupted', { runId, decisionId: d.id });
  });
}
