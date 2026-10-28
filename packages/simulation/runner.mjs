/** 고정된 테스트 결과를 생성한다. 모델 호출·저장소 수정·실제 검증을 하지 않는다. */
export class SimulationRunner {
  mode = 'simulation';
  constructor({ failTaskIds = [] } = {}) { this.failTaskIds = new Set(failTaskIds); }
  async execute(ticket) {
    const failed = this.failTaskIds.has(ticket.taskId);
    return {
      schemaVersion: 1, mode: 'simulation', status: failed ? 'failed' : 'succeeded',
      summary: `${ticket.taskId}: 모의 ${failed ? '실패' : '성공'}. 실제 개발 결과가 아닙니다.`,
      artifacts: failed ? [] : ticket.task.outputs.map(name => ({ name, contents: JSON.stringify({ simulation: true, taskId: ticket.taskId, attemptId: ticket.id, name, inputs: ticket.inputEvidence }) })),
      checks: failed ? [] : ticket.task.criteria.map(criterionId => ({ criterionId, passed: true })),
    };
  }
}
