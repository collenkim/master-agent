import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SimulationRunner } from './simulation.mjs';

export function demoDefinition(root, prefix = randomUUID()) {
  const domains = ['order', 'payment', 'coupon'];
  const projects = domains.map(domain => ({
    id: `${prefix}-${domain}`, name: `모의 ${domain}`, path: join(root, prefix, domain),
    domains: [domain], capabilities: ['simulation'], constraints: ['실제 개발 작업 없음'],
    currentPlans: [], references: [`demo:${domain}@1`],
  }));
  const tasks = projects.map((p, index) => ({
    id: `implement-${domains[index]}`, projectId: p.id, domain: domains[index], kind: 'implementation',
    goal: `${domains[index]} 역할 수행을 모의 실행`, rationale: `${p.references[0]}의 도메인 책임에 배정`,
    references: p.references, dependsOn: [], criteria: ['cancel-flow'],
    allowedChanges: ['simulation-only'], exclusions: ['actual-repository'], outputs: [`${domains[index]}-result`],
    requiredCapabilities: ['simulation'], verification: '후행 통합 작업에서 모의 산출물을 대조',
  }));
  tasks.push({
    id: 'integrate', projectId: projects[0].id, domain: 'order', kind: 'integration',
    goal: '주문·결제·쿠폰의 모의 결과 통합', rationale: '주문 흐름에서 세 결과를 함께 확인',
    references: projects[0].references, dependsOn: tasks.map(t => t.id), criteria: ['cancel-flow'],
    allowedChanges: [], exclusions: ['actual-repository'], outputs: ['integration-report'],
    requiredCapabilities: ['simulation'], verification: '완료 조건과 세 선행 산출물의 모의 검증',
  });
  return {
    projects, group: { id: `${prefix}-commerce`, name: '모의 커머스', projectIds: projects.map(p => p.id) },
    mission: { goal: '주문 취소 시 환불과 쿠폰 복구 흐름의 모의 실행', requestKey: `demo-${prefix}`, mode: 'simulation', scope: { projectIds: [], groupIds: [`${prefix}-commerce`] }, criteria: [{ id: 'cancel-flow', description: '세 프로젝트 결과가 통합 검증에 연결된다.' }] },
    plan: { schemaVersion: 1, summary: '고정 예제 계획입니다. AI가 생성한 계획이 아닙니다.', unresolved: [], tasks },
  };
}
export async function runDemo(engine, root) {
  const definition = demoDefinition(root);
  for (const p of definition.projects) { mkdirSync(p.path, { recursive: true }); engine.catalog.register(p); }
  engine.catalog.group(definition.group);
  let m = engine.create(definition.mission);
  m = engine.plan(m.id, definition.plan, m.revision);
  return engine.run(m.id, new SimulationRunner());
}
