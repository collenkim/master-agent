import { Engine } from '../orchestrator/engine.mjs';
import { LiveVerification, validateRecipe } from './live-verification.mjs';
import { hash, requireThat, string, strings } from '../domain/contracts.mjs';

/** 재사용 권한을 명시한 검증 계약만 새 작업에 연결한다. 모델이 실행 명령을 만들지 않는다. */
export class VerificationTemplates {
  constructor(store) { this.store = store; this.engine = new Engine(store); }
  register(id, template, revision) {
    return this.store.transaction(() => {
      const m = this.engine.checked(id, revision);
      requireThat(m.mode === 'live' && !['succeeded', 'cancelled', 'analyzing'].includes(m.state), 'invalid-state', 'live 목표의 분석 외 단계에서 등록하세요.');
      string(template.id, 'template.id'); string(template.domain, 'template.domain'); strings(template.kinds, 'template.kinds', true);
      requireThat(template.kinds.every(k => ['implementation', 'verification', 'integration', 'analysis', 'contract'].includes(k)), 'invalid-template', '지원하지 않는 작업 종류입니다.');
      const project = this.store.need('project', template.projectId);
      requireThat(m.scope.projectIds.includes(project.id) && project.domains.includes(template.domain), 'invalid-template', '목표 범위의 프로젝트 도메인이 필요합니다.');
      strings(template.criteria, 'template.criteria', true); strings(template.outputs, 'template.outputs', true);
      requireThat(template.criteria.every(c => m.criteria.some(item => item.id === c)), 'invalid-template', '목표의 완료 조건만 등록할 수 있습니다.');
      const recipe = { ...template.recipe, taskId: template.id };
      validateRecipe(recipe, { id: template.id, criteria: template.criteria, outputs: template.outputs });
      const d = this.engine.decision(m, 'register-verification-template', { actor: 'operator', reason: '지정 프로젝트·도메인·종류·완료 조건·파일 범위에서 검증 계약 재사용을 허용합니다.',
        evidence: [`project:${project.id}@${project.revision}`], alternatives: ['작업별 등록', '범위 내 계약 자동 연결'], nextAction: 'bind-verification-template', verification: '기존 명령·조건·산출물 연결 유지', inputHash: hash(template) });
      m.verificationTemplates ??= {};
      m.verificationTemplates[template.id] = { ...structuredClone(template), recipe, projectPath: project.path, criteriaHash: hash(m.criteria.filter(c => template.criteria.includes(c.id))), decisionId: d.id };
      return this.engine.save(m, 'verification-template-registered', { templateId: template.id, decisionId: d.id });
    });
  }
  candidates(m, task) {
    return Object.values(m.verificationTemplates ?? {}).filter(t => t.projectId === task.projectId && t.domain === task.domain && t.kinds.includes(task.kind) &&
      t.projectPath === this.store.need('project', task.projectId).path && hash([...t.criteria].sort()) === hash([...task.criteria].sort()) &&
      t.criteriaHash === hash(m.criteria.filter(c => t.criteria.includes(c.id))) && task.allowedChanges.every(p => t.recipe.allowedPaths.includes(p)) &&
      task.outputs.every(name => t.outputs.includes(name)));
  }
  apply(id, taskId, revision) {
    const m = this.engine.checked(id, revision), task = m.plans.at(-1)?.proposal.tasks.find(t => t.id === taskId);
    requireThat(task, 'invalid-state', '현재 계획 작업이 필요합니다.');
    const candidates = this.candidates(m, task);
    requireThat(candidates.length === 1, 'template-selection-required', '일치하는 검증 템플릿이 없거나 여러 개입니다.');
    const template = candidates[0];
    const recipe = { ...template.recipe, taskId, allowedPaths: [...task.allowedChanges], artifacts: template.recipe.artifacts.filter(a => task.outputs.includes(a.name)) };
    return new LiveVerification(this.store).configure(id, recipe, revision, { templateId: template.id, decisionId: template.decisionId });
  }
}
