import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setup } from './helpers.mjs';
import { Knowledge } from '../packages/knowledge/sources.mjs';
import { Planner } from '../packages/reasoning/planner.mjs';

export function planningSetup(t) {
  const setupResult = setup(t, { plan: false });
  const knowledge = new Knowledge(setupResult.store);
  for (const p of setupResult.fixture.projects) {
    writeFileSync(join(p.path, 'POLICY.md'), `# ${p.domains[0]} 정책\n담당 도메인은 ${p.domains[0]}이다. 주문 취소 흐름의 해당 역할을 수행한다.\n`);
    knowledge.collect(p.id, { schemaVersion: 1, sources: [{ path: 'POLICY.md', kind: 'policy' }] }, 1);
  }
  const planner = new Planner(setupResult.store);
  return { ...setupResult, knowledge, planner };
}

export function answerFor(context) {
  const criterionIds = context.mission.criteria.map(c => c.id);
  const projects = context.projects;
  const tasks = projects.map((p, i) => ({
    id: `implement-${i}`, projectId: p.id, domain: p.domains[0], kind: 'implementation',
    goal: `${p.domains[0]} 구현`, rationale: '프로젝트 책임에 따른 배정', references: [p.sources[0].id], dependsOn: [],
    criteria: criterionIds, allowedChanges: ['simulation-only'], exclusions: ['actual-repository'], outputs: [`output-${i}`],
    requiredCapabilities: ['simulation'], verification: '후행 통합 검증', planAcknowledgements: p.currentPlans, coordination: p.currentPlans.length ? '기존 계획을 대조한 후 실행' : '',
  }));
  tasks.push({ ...tasks[0], id: 'integrate', kind: 'integration', goal: '통합 검증', outputs: ['integration-report'], dependsOn: tasks.map(t => t.id) });
  return {
    schemaVersion: 1, status: 'ready', summary: '근거에 기반한 세 프로젝트 계획',
    requirements: [{ id: 'r1', description: context.mission.goal, sourceQuote: context.mission.goal, criterionIds }],
    assessments: projects.map(p => ({ projectId: p.id, role: p.domains[0], selected: true, feasibility: 'ready', rationale: '정책의 도메인 책임', references: [p.sources[0].id], gaps: [] })),
    decisions: [{ topic: '배정', choice: '각 도메인에 분배', reason: '정책과 일치', alternatives: ['단일 프로젝트 수정', '도메인별 분배'], references: projects.map(p => p.sources[0].id), uncertainties: [] }],
    issues: [], plan: { schemaVersion: 1, summary: '각 도메인 구현 후 통합 검증', unresolved: [], tasks },
  };
}
export function blockedAnswer(context, critical = false) {
  const a = answerFor(context);
  a.status = critical ? 'needs-human' : 'needs-context';
  a.issues = [{ id: 'q1', kind: critical ? 'critical' : 'information', question: '환불 확정 조건은 무엇인가?', reason: '정책에서 조건이 미정의됨', references: [context.projects[0].sources[0].id], options: ['확정 이벤트', '즉시 확정'], recommendation: '확정 이벤트를 기준으로 검토' }];
  a.plan.tasks = []; a.plan.unresolved = ['환불 확정 조건'];
  return a;
}
