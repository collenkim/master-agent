import { validateShape } from './schema.mjs';
import { requireThat } from '../domain/contracts.mjs';
const text = { type: 'string' }, texts = { type: 'array', items: text };
const obj = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
export const recoverySchema = obj({ schemaVersion: { type: 'integer', enum: [1] },
  action: { type: 'string', enum: ['repair', 'reverify', 'replan', 'needs-context', 'needs-human'] },
  category: { type: 'string', enum: ['implementation', 'test', 'transient', 'scope', 'critical', 'unknown'] },
  summary: text, cause: text, references: texts, alternatives: texts,
  steps: { type: 'array', items: obj({ instruction: text, paths: texts, references: texts }) },
  question: text, recommendation: text, uncertainties: texts,
});
export function validateRecovery(data, context) {
  validateShape(data, recoverySchema, 'recovery');
  requireThat(data.summary.trim() && data.cause.trim() && data.references.length && data.alternatives.length, 'invalid-recovery', '원인·근거·대안이 필요합니다.');
  const references = new Set(context.references);
  requireThat([...data.references, ...data.steps.flatMap(s => s.references)].every(r => references.has(r)), 'invalid-recovery', '실제 제공한 근거만 인용할 수 있습니다.');
  for (const step of data.steps) requireThat(step.instruction.trim() && step.references.length && step.paths.length && step.paths.every(p => context.recipe.allowedPaths.includes(p)), 'recovery-out-of-scope', '수정 단계는 기존 허용 파일 안에 있어야 합니다.');
  if (['repair', 'reverify'].includes(data.action)) requireThat(!data.uncertainties.length && !data.question && data.category !== 'critical' && data.category !== 'scope', 'needs-review', '모호함·범위 변경·중대한 결정을 자동 실행할 수 없습니다.');
  if (data.action === 'repair') requireThat(data.steps.length && ['implementation', 'test', 'transient'].includes(data.category), 'invalid-recovery', '분류된 원인과 수정 계획이 필요합니다.');
  if (data.action === 'reverify') requireThat(data.category === 'transient' && !data.steps.length, 'invalid-recovery', '일시적 실패만 변경 없이 재검증할 수 있습니다.');
  if (data.action === 'needs-human') requireThat(data.category === 'critical' && data.question.trim() && data.recommendation.trim(), 'invalid-recovery', '사람 결정에는 중대한 문제와 질문·권고가 필요합니다.');
  if (data.action === 'needs-context') requireThat(data.question.trim() && data.uncertainties.length, 'invalid-recovery', '부족한 근거와 질문을 명시해야 합니다.');
  if (data.action === 'replan') requireThat(data.category === 'scope' && data.recommendation.trim(), 'invalid-recovery', '재계획에는 범위 변경 이유와 권고가 필요합니다.');
}
