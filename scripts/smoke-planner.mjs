import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import assert from 'node:assert/strict';
import { Store } from '../packages/storage/store.mjs';
import { Engine } from '../packages/orchestrator/engine.mjs';
import { Knowledge } from '../packages/knowledge/sources.mjs';
import { Planner } from '../packages/reasoning/planner.mjs';
import { CliProvider } from '../packages/reasoning/cli-provider.mjs';
import { createSmokeArtifacts } from './smoke-artifacts.mjs';

const { values } = parseArgs({ options: { provider: { type: 'string' }, 'ai-cli': { type: 'string' }, model: { type: 'string' } } });
const provider = new CliProvider({ provider: values.provider, cliPath: values['ai-cli'], model: values.model });
const root = createSmokeArtifacts('ai-smoke-'), project = join(root, 'project');
mkdirSync(project, { recursive: true });
const policy = '# 소계 기능 정책\n이 프로젝트는 invoice 도메인의 소계 계산을 담당한다.\n가격과 수량은 0 이상의 수여야 한다. 음수 입력은 오류로 거부해야 한다.\n현재 subtotal 함수는 음수를 허용하는 결함이 있다. simulation은 모의 실행 기능이다.\n';
const code = 'export function subtotal(price, quantity) { return price * quantity; }\n';
writeFileSync(join(project, 'POLICY.md'), policy); writeFileSync(join(project, 'subtotal.mjs'), code);
const store = new Store(join(root, 'state.db'));
try {
  const engine = new Engine(store), knowledge = new Knowledge(store);
  engine.catalog.register({ id: 'invoice', name: '소계 계산 예제', path: project, domains: ['invoice'], capabilities: ['simulation'], constraints: ['실제 파일 수정 금지: 계획 생성만'], currentPlans: [], references: ['fixture-policy@1'] });
  knowledge.collect('invoice', { schemaVersion: 1, sources: [{ path: 'POLICY.md', kind: 'policy' }, { path: 'subtotal.mjs', kind: 'code' }] }, 1);
  const m = engine.create({ goal: '소계 함수가 가격 또는 수량의 음수 입력을 거부하도록 수정하고 검증하는 계획을 세워줘.', requestKey: 'smoke', mode: 'simulation',
    scope: { projectIds: ['invoice'], groupIds: [] }, criteria: [{ id: 'negative-input', description: '가격 또는 수량이 음수이면 오류를 반환한다.' }] });
  console.log(JSON.stringify({ stage: 'analyzing', provider: provider.name, missionId: m.id, database: join(root, 'state.db') }));
  const result = await new Planner(store).analyze(m.id, provider, { expectedRevision: m.revision });
  assert.equal(result.mission.state, 'planned', JSON.stringify({ status: result.analysis.status, error: result.analysis.error, issues: result.analysis.result?.issues }));
  assert.equal(readFileSync(join(project, 'POLICY.md'), 'utf8'), policy);
  assert.equal(readFileSync(join(project, 'subtotal.mjs'), 'utf8'), code);
  const report = { passed: true, provider: provider.name, requestedModel: provider.model, missionId: m.id, analysisId: result.analysis.id,
    status: result.mission.state, passes: result.analysis.passes.length, taskCount: result.mission.tasks.length, projectUnchanged: true,
    database: join(root, 'state.db'), plan: result.analysis.result.plan };
  writeFileSync(join(root, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, plan: undefined }));
} finally { store.close(); }
