import { Knowledge } from '../knowledge/sources.mjs';
import { checkClaudeInstallation } from '../runner/claude-host.mjs';
import { ControlClient } from '../code-agent-adapter/control.mjs';
import { observeProject } from '../code-agent-adapter/observe.mjs';
import { now, requireThat } from '../domain/contracts.mjs';

export const preparationCodes = new Set(['missing-knowledge', 'stale-knowledge', 'control-not-bound', 'control-not-owner', 'host-not-installed',
  'not-installed', 'invalid-cli', 'cli-not-found', 'code-agent-unavailable', 'control-token-missing', 'control-not-enabled', 'control-fenced', 'control-unauthorized']);

export function preparationIssues(request) {
  if (request.preparation?.issues?.length) return request.preparation.issues;
  if (request.state === 'failed' && preparationCodes.has(request.error?.code)) return [{ projectId: request.projectIds[0], code: request.error.code,
    message: request.error.message, guidance: '준비 상태를 다시 확인하면 표준 근거 수집과 설치·연결 점검을 수행합니다. 기존 TASK를 유지합니다.' }];
  return [];
}

/** Read-only project checks plus master DB knowledge collection. No install, grants or execution here. */
export async function prepareRequest(store, request, { cliPath, observe = observeProject, checkHost = checkClaudeInstallation,
  clientFor = project => new ControlClient({ cliPath, projectPath: project.path, ...store.need('control-binding', project.id), timeoutMs: 5000, retries: 0 }) } = {}) {
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
    } catch (error) { issue(error.code ?? 'observation-unavailable', error.message, 'code-agent 설치 및 status --json 결과를 확인하세요.'); }
    try { checkHost(project); checks.push({ projectId, kind: 'host', host: 'claude' }); }
    catch (error) { issue(error.code ?? 'host-not-installed', error.message, '현재 master 개발 실행은 Claude 호스트를 사용합니다. 해당 프로젝트에서 code-agent init으로 호스트 파일을 준비하고 code-agent doctor로 확인하세요. 최신 init은 두 호스트를 준비합니다. 계획 provider 선택과 개발 호스트는 별개입니다.'); }
    const binding = store.get('control-binding', projectId);
    if (!binding) {
      issue('control-not-bound', 'master 제어 연결이 없습니다.',
        `프로젝트 폴더에서 code-agent master enable --controller dashboard --token-out <저장소 밖 토큰 파일>을 직접 실행하세요. 기존 연결이 있으면 enable을 반복하지 마세요.\nmaster-agent project control ${projectId} --controller <기존 제어자 ID> --token-file <토큰 파일 절대경로> --db <현재 대시보드 DB>\n질문·승인을 웹에서 처리하려면 code-agent master human enable --controller <제어자 ID>도 실행하세요. 토큰 내용은 답변에 입력하지 마세요.`);
      continue;
    }
    try {
      const client = clientFor(project), hello = await client.result('hello');
      requireThat(hello.project?.enabled, 'control-not-enabled', 'code-agent master 연동이 비활성 상태입니다.');
      requireThat(binding.owner && hello.ownership?.controller === binding.controller && hello.ownership?.generation === binding.generation && !hello.ownership?.handover,
        'control-not-owner', '현재 제어권·세대가 저장된 연결과 다릅니다.');
      await client.result('heartbeat'); // Authenticated read: a saved token path is not proof of access.
      checks.push({ projectId, kind: 'control', status: 'connected' });
    } catch (error) { issue(error.code ?? 'control-unavailable', error.code === 'control-unavailable' ? 'code-agent 제어 연결 조회에 실패했습니다.' : error.message,
      '현재 제어자·토큰 파일 접근 권한을 확인하고 같은 DB에 project control로 다시 연결하세요. 다른 제어자가 소유 중이면 정식 인계 절차를 따르세요.'); }
  }
  return { checkedAt: now(), state: issues.length ? 'waiting' : 'ready', checks, issues };
}
