import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { extname, join } from 'node:path';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { Catalog, normalizedPath } from '../catalog/catalog.mjs';
import { requireThat, hash, now } from '../domain/contracts.mjs';
import { findCodeAgent } from './discovery.mjs';
import { recordObservation } from '../dashboard/history.mjs';

const runFile = promisify(execFile);
const resumeCodes = new Set(['stale-request', 'unobservable', 'no-work', 'ownership-conflict', 'wait', 'needs-human', 'replan-required', 'reapproval-required', 'limit-reached', 'ready']);

/** Poll timestamps advance independently of the code-agent concurrency contract. */
export function observationIdentity(observation) {
  return hash({ status: observation?.status ?? 'unobserved', stateVersion: observation?.state?.stateVersion ?? null,
    work: observation?.state?.work ?? null, resume: observation?.state?.resume ?? null });
}

export function parseState(stdout, projectPath) {
  let state;
  try { state = JSON.parse(stdout); } catch { return { status: 'invalid-json', error: '기계 판독용 JSON을 읽을 수 없습니다.' }; }
  if (state?.schema !== 'code-agent.state' || state.schemaVersion !== 1) return { status: 'unsupported-version', error: 'code-agent.state 버전 1이 필요합니다.' };
  if (typeof state.stateVersion !== 'string' || !state.stateVersion || !Number.isFinite(Date.parse(state.observedAt)) ||
      !resumeCodes.has(state.resume?.code) || !Array.isArray(state.resume.reasons) ||
      !Array.isArray(state.unknown) || state.ownership?.process !== 'unverified' ||
      typeof state.ownership?.lease?.state !== 'string' || !state.repo?.root ||
      !(state.work === null || (typeof state.work?.id === 'string' && typeof state.work?.phase === 'string'))) {
    return { status: 'invalid-state', error: '상태 조회 필수 필드가 잘못됐습니다.' };
  }
  try {
    if (normalizedPath(state.repo.root) !== normalizedPath(projectPath)) return { status: 'wrong-project', error: '다른 저장소의 상태를 반환했습니다.' };
  } catch { return { status: 'wrong-project', error: '조회 결과의 저장소 경로를 확인할 수 없습니다.' }; }
  return { status: state.resume.code === 'unobservable' ? 'unobservable' : 'observed', state };
}

/** 지원된 읽기 전용 명령만 호출한다. 개발 실행과 승인 전달은 제공하지 않는다. */
export async function observeProject(store, projectId, { cliPath, timeoutMs = 30000 } = {}) {
  cliPath = findCodeAgent(cliPath);
  const extension = extname(cliPath).toLowerCase();
  requireThat(Number.isInteger(timeoutMs) && timeoutMs > 0, 'invalid-input', '조회 시간 제한은 양의 정수여야 합니다.');
  const project = new Catalog(store).active(projectId);
  const observedAt = now();
  const requestId = randomUUID();
  store.transaction(() => {
    const old = store.get('observation-request', projectId);
    store.put('observation-request', { id: projectId, requestId }, old?.revision ?? 0);
  });
  let result;
  if (!existsSync(join(project.path, '.code-agent', 'version'))) {
    result = { status: 'not-installed', error: '.code-agent/version 설치 마커가 없습니다.' };
  } else {
    const js = ['.js', '.mjs', '.cjs'].includes(extension);
    let stdout = '', processError;
    try {
      const output = await runFile(js ? process.execPath : cliPath, [...(js ? [cliPath] : []), 'status', '--json'], {
        cwd: project.path, encoding: 'utf8', windowsHide: true, timeout: timeoutMs,
        maxBuffer: 4 * 1024 * 1024, shell: false, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
      });
      stdout = output.stdout;
    } catch (error) { stdout = error.stdout ?? ''; processError = error; }
    if (processError?.killed) result = { status: 'timeout', error: '상태 조회 시간이 초과됐습니다.' };
    else if (processError && ![1, 2, 3].includes(processError.code)) result = { status: 'process-error', error: String(processError.code ?? 'unknown') };
    else result = { ...parseState(stdout, project.path), exitCode: processError?.code ?? 0 };
  }
  return store.transaction(() => {
    const current = store.need('project', projectId);
    requireThat(current.revision === project.revision, 'stale-state', '조회 중 프로젝트 정보가 바뀌었습니다.');
    const previous = store.get('observation', projectId);
    // 같은 밀리초에 시작한 조회도 요청 식별자로 구별한다.
    if (store.need('observation-request', projectId).requestId !== requestId) return previous ?? { id: projectId, status: 'superseded' };
    const saved = store.put('observation', {
      id: projectId, startedAt: observedAt, recordedAt: now(), ...result,
      lastSuccessfulState: result.state ?? previous?.lastSuccessfulState ?? null,
      capabilities: { status: Boolean(result.state), submit: false, resume: false, answer: false, cancel: false },
    }, previous?.revision ?? 0);
    recordObservation(store, projectId, saved);
    return saved;
  });
}
