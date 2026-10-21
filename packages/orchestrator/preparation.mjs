import { Knowledge } from '../knowledge/sources.mjs';
import { checkManagedInstallation, checkManagedSupport } from '../runner/control-host.mjs';
import { ControlClient, OpenControlClient } from '../code-agent-adapter/control.mjs';
import { DASHBOARD_CONTROLLER, connectionState, controlProbe, findTrustKey, hostReadinessIssue } from '../code-agent-adapter/pairing.mjs';
import { observeProject } from '../code-agent-adapter/observe.mjs';
import { now, requireThat } from '../domain/contracts.mjs';

export const preparationCodes = new Set(['missing-knowledge', 'stale-knowledge', 'control-not-bound', 'control-not-owner', 'host-not-installed',
  'not-installed', 'invalid-cli', 'cli-not-found', 'code-agent-unavailable', 'control-token-missing', 'control-not-enabled', 'control-fenced', 'control-unauthorized',
  'control-pairing-available', 'control-trust-missing', 'control-owned-by-other', 'control-enabled-unbound', 'host-not-ready', 'host-selection-unsupported', 'repository-no-commit']);

export function preparationIssues(request) {
  if (request.preparation?.issues?.length) return request.preparation.issues;
  if (request.state === 'failed' && preparationCodes.has(request.error?.code)) return [{ projectId: request.projectIds[0], code: request.error.code,
    message: request.error.message, guidance: '준비 상태를 다시 확인하면 표준 근거 수집과 설치·연결 점검을 수행합니다. 기존 TASK를 유지합니다.' }];
  return [];
}

/**
 * Read-only project checks plus master DB knowledge collection. No install, grants, pairing or execution here.
 * Without a binding the unauthenticated hello only classifies why (trust, pairing, other owner, legacy) — pairing waits for an explicit human confirmation.
 */
export async function prepareRequest(store, request, { cliPath, observe = observeProject, checkHost = checkManagedInstallation,
  clientFor = project => new ControlClient({ cliPath, projectPath: project.path, ...store.need('control-binding', project.id), timeoutMs: 5000, retries: 0 }),
  probe = project => new OpenControlClient({ cliPath, projectPath: project.path, timeoutMs: 5000, retries: 0 }).result('hello'), trustKey = findTrustKey } = {}) {
  const issues = [], checks = [], mission = store.need('mission', request.id);
  for (const projectId of request.projectIds) {
    const project = store.need('project', projectId);
    const issue = (code, message, guidance) => issues.push({ projectId, projectName: project.name, code, message, guidance });
    if (project.deletedAt) { issue('not-found', '프로젝트 등록이 해제되었습니다.', '프로젝트와 요청 범위를 확인하세요.'); continue; }
    if (store.get('project-maintenance', projectId)?.active) { issue('project-busy', 'code-agent 업데이트 중입니다.', '업데이트 완료 후 다시 확인하세요.'); continue; }
    if (!mission.plans.length) {
      try { const snapshot = new Knowledge(store).prepare(projectId); checks.push({ projectId, kind: 'knowledge', sourceCount: snapshot.sources.length, basis: snapshot.sources[0]?.origin ?? 'files' }); }
      catch (error) { issue(error.code ?? 'knowledge-unavailable', error.message, 'project collect로 필요한 UTF-8 문서·코드의 상대 경로를 지정하세요. 기존 정책 근거를 자동 제외하지 않습니다.'); }
    }
    try {
      const observation = await observe(store, projectId, { cliPath, timeoutMs: 5000 });
      requireThat(observation.status === 'observed', observation.status, observation.error ?? '현재 상태를 확인할 수 없습니다.');
      checks.push({ projectId, kind: 'observation', status: observation.status });
      if (observation.state?.repo && observation.state.repo.head === null) issue('repository-no-commit', 'Git 저장소에 커밋이 없어 작업 기준을 만들 수 없습니다.',
        '프로젝트 설정·공통 문서를 준비(ca-adopt)한 뒤 프로젝트 폴더에서 code-agent setup baseline으로 최초 커밋을 만들거나 직접 첫 커밋을 만드세요. 자동으로 커밋하지 않습니다.');
    } catch (error) { issue(error.code ?? 'observation-unavailable', error.message, 'code-agent 설치 및 status --json 결과를 확인하세요.'); }
    let installed = true;
    try { checkHost(project); checks.push({ projectId, kind: 'host', host: 'code-agent', selection: 'project-execution-and-registered-profile' }); }
    catch (error) { installed = false; issue(error.code ?? 'host-not-installed', error.message, '프로젝트에서 code-agent init과 doctor로 설치를 확인하세요. init은 Claude·Codex 두 host를 준비합니다. 개발 host는 요청에서 고른 host(고르지 않으면 code-agent execution 설정)를 따르고 host별 권한은 master enable --host <설정 파일>을 따릅니다. Codex는 프로젝트·hook 신뢰 확인도 필요합니다.'); }
    const binding = store.get('control-binding', projectId);
    if (!binding) {
      // 설치 전에는 페어링을 권하지 않는다 — 설치 안내와 기존 연결 안내만 낸다
      let probed = null;
      if (installed) try { probed = controlProbe(await probe(project)); } catch { /* 연결 전 조회 실패 — 기존 터미널 안내로 대신한다 */ }
      const ready = probed ? hostReadinessIssue(probed, request.execution) : null;
      if (ready) issue(ready.code, ready.message, ready.guidance);
      const connection = connectionState({ projectId, probe: probed, binding: null, controller: DASHBOARD_CONTROLLER, keyAvailable: Boolean(trustKey(DASHBOARD_CONTROLLER)) });
      issues.push({ projectId, projectName: project.name, code: connection.code, message: connection.message, guidance: connection.guidance,
        canPair: connection.canPair, connection: connection.state, ...(connection.command ? { command: connection.command } : {}) });
      continue;
    }
    try {
      const client = clientFor(project), hello = await client.result('hello');
      requireThat(hello.project?.enabled, 'control-not-enabled', 'code-agent master 연동이 비활성 상태입니다.');
      requireThat(binding.owner && hello.ownership?.controller === binding.controller && hello.ownership?.generation === binding.generation && !hello.ownership?.handover,
        'control-not-owner', '현재 제어권·세대가 저장된 연결과 다릅니다.');
      checkManagedSupport(hello);
      await client.result('heartbeat'); // Authenticated read: a saved token path is not proof of access.
      const ready = hostReadinessIssue(controlProbe(hello), request.execution);
      if (ready) issue(ready.code, ready.message, ready.guidance);
      else checks.push({ projectId, kind: 'control', status: 'connected', ...(request.execution ? { execution: request.execution } : {}) });
    } catch (error) { issue(error.code ?? 'control-unavailable', error.code === 'control-unavailable' ? 'code-agent 제어 연결 조회에 실패했습니다.' : error.message,
      '현재 제어자·토큰 파일 접근 권한을 확인하고 같은 DB에 project control로 다시 연결하세요. 다른 제어자가 소유 중이면 정식 인계 절차를 따르세요.'); }
  }
  return { checkedAt: now(), state: issues.length ? 'waiting' : 'ready', checks, issues };
}
