const text = { type: 'string' };
const array = items => ({ type: 'array', items });
const texts = array(text);
const choice = values => ({ type: 'string', enum: values });
const obj = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });

export const planSchema = obj({
  schemaVersion: { type: 'integer', enum: [1] }, summary: text, unresolved: texts,
  tasks: array(obj({
    id: text, projectId: text, domain: text, kind: choice(['analysis', 'contract', 'implementation', 'verification', 'integration']),
    goal: text, rationale: text, references: texts, dependsOn: texts, criteria: texts,
    allowedChanges: texts, exclusions: texts, outputs: texts, requiredCapabilities: texts,
    verification: text, planAcknowledgements: texts, coordination: text,
  })),
});

export const analysisSchema = obj({
  schemaVersion: { type: 'integer', enum: [1] },
  status: choice(['ready', 'needs-context', 'needs-human']), summary: text,
  requirements: array(obj({ id: text, description: text, sourceQuote: text, criterionIds: texts })),
  assessments: array(obj({ projectId: text, role: text, selected: { type: 'boolean' },
    feasibility: choice(['ready', 'needs-analysis', 'blocked']), rationale: text, references: texts, gaps: texts })),
  decisions: array(obj({ topic: text, choice: text, reason: text, alternatives: texts, references: texts, uncertainties: texts })),
  issues: array(obj({ id: text, kind: choice(['information', 'critical']), question: text, reason: text, references: texts,
    options: texts, recommendation: text })),
  plan: planSchema,
});

/** 모델/CLI의 스키마 준수 주장에 의존하지 않고 수신 경계에서 다시 검증한다. */
export function validateShape(value, schema = analysisSchema, path = 'analysis') {
  const fail = message => { const error = new Error(`${path}: ${message}`); error.code = 'invalid-analysis'; throw error; };
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('객체가 필요합니다.');
    if (Object.keys(value).some(k => !Object.hasOwn(schema.properties, k))) fail('허용하지 않는 필드가 있습니다.');
    for (const k of schema.required) if (!Object.hasOwn(value, k)) fail(`${k} 누락`);
    for (const [k, sub] of Object.entries(schema.properties)) validateShape(value[k], sub, `${path}.${k}`);
  } else if (schema.type === 'array') {
    if (!Array.isArray(value) || value.length > 256) fail('최대 256개 배열이 필요합니다.');
    value.forEach((v, i) => validateShape(v, schema.items, `${path}[${i}]`));
  } else if (schema.type === 'integer') {
    if (!Number.isInteger(value)) fail('정수가 필요합니다.');
  } else if (typeof value !== schema.type) fail(`${schema.type} 값이 필요합니다.`);
  if (typeof value === 'string' && value.length > 16000) fail('문자열 제한을 초과했습니다.');
  if (schema.enum && !schema.enum.includes(value)) fail('지원하지 않는 값입니다.');
  return value;
}
