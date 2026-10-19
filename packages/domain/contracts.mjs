import { createHash } from 'node:crypto';

export class DomainError extends Error {
  constructor(code, message) { super(message); this.name = 'DomainError'; this.code = code; }
}
export function requireThat(ok, code, message) { if (!ok) throw new DomainError(code, message); }
export function object(value, label) {
  requireThat(value && typeof value === 'object' && !Array.isArray(value), 'invalid-input', `${label}: 객체가 필요합니다.`);
  return value;
}
export function string(value, label) {
  requireThat(typeof value === 'string' && value.trim().length > 0, 'invalid-input', `${label}: 빈 문자열은 허용하지 않습니다.`);
  return value;
}
export function strings(value, label, nonempty = false) {
  requireThat(Array.isArray(value) && (!nonempty || value.length > 0), 'invalid-input', `${label}: 배열이 필요합니다.`);
  value.forEach(item => string(item, label));
  requireThat(new Set(value).size === value.length, 'invalid-input', `${label}: 중복 항목이 있습니다.`);
  return value;
}
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
export const hash = value => createHash('sha256').update(canonical(value)).digest('hex');
export const now = () => new Date().toISOString();

export function validateProject(input) {
  object(input, 'project');
  for (const key of ['id', 'name', 'path']) string(input[key], key);
  for (const key of ['domains', 'capabilities', 'constraints', 'currentPlans', 'references']) strings(input[key], key);
  requireThat(input.domains.length && input.references.length, 'invalid-input', '도메인과 근거가 필요합니다.');
}

export function validateMission(input) {
  object(input, 'mission'); string(input.goal, 'goal'); string(input.requestKey, 'requestKey');
  requireThat(input.taskNumber === undefined || typeof input.taskNumber === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(input.taskNumber),
    'invalid-input', 'TASK 번호는 영문·숫자로 시작하는 64자 이하의 영문·숫자·점·밑줄·하이픈이어야 합니다.');
  requireThat(['live', 'simulation'].includes(input.mode), 'invalid-input', 'mode는 live 또는 simulation입니다.');
  object(input.scope, 'scope');
  strings(input.scope.projectIds, 'scope.projectIds'); strings(input.scope.groupIds, 'scope.groupIds');
  requireThat(Array.isArray(input.criteria) && input.criteria.length, 'invalid-input', '완료 조건이 필요합니다.');
  input.criteria.forEach(c => { object(c, 'criterion'); string(c.id, 'criterion.id'); string(c.description, 'criterion.description'); });
  strings(input.criteria.map(c => c.id), 'criteria.id', true);
}

/** 계획의 의미적 타당성은 이후 AI 평가와 프로젝트 분석이 보완한다. 여기서는 실행 불변식을 검사한다. */
export function validatePlan(plan, mission, projects) {
  object(plan, 'plan');
  requireThat(plan.schemaVersion === 1, 'unsupported-version', '계획 스키마 버전 1이 필요합니다.');
  string(plan.summary, 'summary');
  strings(plan.unresolved, 'unresolved');
  requireThat(plan.unresolved.length === 0, 'needs-review', '미해결 항목이 있습니다. 재검토한 계획이 필요합니다.');
  requireThat(Array.isArray(plan.tasks) && plan.tasks.length, 'invalid-plan', '계획 작업이 필요합니다.');
  strings(plan.tasks.map(t => t.id), 'task.id', true);
  const tasks = new Map(plan.tasks.map(t => [t.id, t]));
  const criteria = new Set(mission.criteria.map(c => c.id));
  for (const t of plan.tasks) {
    object(t, 'task');
    for (const k of ['projectId', 'domain', 'goal', 'rationale', 'verification']) string(t[k], `task.${k}`);
    requireThat(['analysis', 'contract', 'implementation', 'verification', 'integration'].includes(t.kind), 'invalid-plan', `작업 종류 오류: ${t.id}`);
    for (const k of ['dependsOn', 'criteria', 'allowedChanges', 'exclusions', 'outputs', 'requiredCapabilities', 'references']) strings(t[k], `task.${k}`);
    requireThat(t.criteria.length && t.outputs.length && t.references.length, 'invalid-plan', `${t.id}: 조건·산출물·근거가 필요합니다.`);
    const project = projects.find(p => p.id === t.projectId);
    requireThat(project && mission.scope.projectIds.includes(t.projectId), 'out-of-scope', `${t.id}: 허용되지 않은 프로젝트입니다.`);
    requireThat(project.domains.includes(t.domain), 'domain-mismatch', `${t.id}: 프로젝트 도메인과 다릅니다.`);
    requireThat(t.requiredCapabilities.every(c => project.capabilities.includes(c)), 'capability-mismatch', `${t.id}: 실행 기능이 부족합니다.`);
    requireThat(t.references.every(ref => project.references.includes(ref)), 'unknown-reference', `${t.id}: 등록된 근거가 아닙니다.`);
    requireThat(t.criteria.every(c => criteria.has(c)), 'unknown-criterion', `${t.id}: 정의되지 않은 완료 조건입니다.`);
    requireThat(t.dependsOn.every(id => tasks.has(id) && id !== t.id), 'invalid-dependency', `${t.id}: 선행 작업이 잘못됐습니다.`);
    if (project.currentPlans.length) {
      strings(t.planAcknowledgements, 'planAcknowledgements', true);
      requireThat(project.currentPlans.every(p => t.planAcknowledgements.includes(p)), 'plan-conflict', `${t.id}: 기존 계획 대조가 필요합니다.`);
      string(t.coordination, 'coordination');
    }
  }
  const visiting = new Set(), visited = new Set();
  const visit = id => {
    requireThat(!visiting.has(id), 'cyclic-plan', '작업 의존 관계가 순환합니다.');
    if (visited.has(id)) return;
    visiting.add(id); tasks.get(id).dependsOn.forEach(visit); visiting.delete(id); visited.add(id);
  };
  tasks.forEach((_, id) => visit(id));
  const verifiers = plan.tasks.filter(t => ['verification', 'integration'].includes(t.kind));
  requireThat([...criteria].every(id => verifiers.some(t => t.criteria.includes(id))), 'missing-verification', '모든 완료 조건에 검증 작업이 필요합니다.');
  const ancestors = id => {
    const found = new Set();
    const collect = key => tasks.get(key).dependsOn.forEach(dep => { if (!found.has(dep)) { found.add(dep); collect(dep); } });
    collect(id); return found;
  };
  for (const task of plan.tasks.filter(t => !['verification', 'integration'].includes(t.kind))) {
    requireThat(task.criteria.every(c => verifiers.some(v => v.criteria.includes(c) && ancestors(v.id).has(task.id))), 'missing-verification', `${task.id}: 후행 검증이 필요합니다.`);
  }
  if (new Set(plan.tasks.map(t => t.projectId)).size > 1) {
    requireThat(plan.tasks.some(t => t.kind === 'integration' && [...criteria].every(c => t.criteria.includes(c)) &&
      plan.tasks.filter(n => n.id !== t.id).every(n => ancestors(t.id).has(n.id))), 'missing-integration', '여러 프로젝트의 전체 작업을 묶는 통합 검증이 필요합니다.');
  }
  return plan;
}
