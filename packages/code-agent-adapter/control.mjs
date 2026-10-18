import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { extname, isAbsolute } from 'node:path';
import { DomainError, requireThat, string } from '../domain/contracts.mjs';
import { findCodeAgent } from './discovery.mjs';

/** code-agent 의 master 통신 계약(code-agent/doc/master-control.md). 같은 PC 의 CLI 호출 한 번이 요청 한 건이다. */
export const PROTOCOL = 'code-agent.master';
export const PROTOCOL_VERSION = 1;
const MUTATING = new Set(['submit', 'pause', 'cancel', 'resume', 'decide', 'answer', 'handover', 'reconcile', 'policy', 'revoke']);
// 실행을 지금 시작하지 않았다고 확정할 수 있는 거부 — 통신 실패와 구분한다
export const TERMINAL_RUN_STATES = new Set(['completed', 'blocked', 'failed', 'cancelled', 'paused', 'abandoned', 'unknown']);

/** 부른 쪽(Claude Code 세션 등)의 표지를 넘기지 않는다 — 프로젝트는 cwd 로만 정한다 */
function childEnv() {
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0' };
  for (const key of ['CLAUDE_PROJECT_DIR', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CODE_AGENT_MASTER_RUN', 'CODE_AGENT_CROSS']) delete env[key];
  return env;
}

export function validCli(cliPath) {
  return findCodeAgent(cliPath);
}

/** 요청 한 건 → 응답 한 건. 프로세스가 응답 JSON 을 내지 못하면 통신 실패(control-unavailable)다 — 명령의 실패가 아니다 */
export function callOnce(cliPath, projectPath, request, { timeoutMs = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const js = ['.js', '.mjs', '.cjs'].includes(extname(cliPath).toLowerCase());
    const child = spawn(js ? process.execPath : cliPath, [...(js ? [cliPath] : []), 'master', 'call'],
      { cwd: projectPath, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: childEnv() });
    let stdout = '', stderr = '', done = false;
    const fail = (message) => { if (!done) { done = true; reject(new DomainError('control-unavailable', message)); } };
    const timer = setTimeout(() => { try { child.kill(); } catch { /* 끝났다 */ } fail('code-agent master call 응답 시간이 지났습니다.'); }, timeoutMs);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', data => { stdout += data; if (stdout.length > 8 * 1024 * 1024) { try { child.kill(); } catch { /* */ } fail('응답이 너무 큽니다.'); } });
    child.stderr.on('data', data => { stderr += data.slice(0, 4000); });
    child.on('error', error => { clearTimeout(timer); fail(`code-agent 를 시작하지 못했습니다(${error.code ?? 'unknown'}).`); });
    child.on('close', () => {
      clearTimeout(timer);
      if (done) return;
      let response;
      try { response = JSON.parse(stdout.trim().split(/\r?\n/).at(-1)); } catch { return fail(`응답 JSON 이 없습니다${stderr ? `: ${stderr.split(/\r?\n/)[0].slice(0, 200)}` : ''}`); }
      if (response?.protocol !== PROTOCOL || response.version !== PROTOCOL_VERSION || typeof response.ok !== 'boolean') return fail('지원하지 않는 응답 형식입니다.');
      done = true; resolve(response);
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(request), 'utf8');
  });
}

export class ControlError extends DomainError {
  constructor(error, response) {
    super(`control-${error.code}`, error.message);
    this.controlCode = error.code; this.detail = error.detail; this.response = response;
  }
}

/**
 * 제어자 한 명의 연결. 토큰은 파일에서 그때마다 읽고(저장소 DB 에 넣지 않는다) 세대는 바인딩 기록의 값을 쓴다.
 * 상태를 바꾸는 요청은 commandId 가 필수이고, 통신 실패면 같은 commandId 로 다시 보낸다 — code-agent 가 한 번만 실행한다.
 */
export class ControlClient {
  constructor({ cliPath, projectPath, controller, tokenFile, generation, timeoutMs = 60000, retries = 2 }) {
    this.cliPath = validCli(cliPath); this.projectPath = string(projectPath, 'projectPath');
    this.controller = string(controller, 'controller'); this.tokenFile = string(tokenFile, 'tokenFile');
    requireThat(isAbsolute(tokenFile), 'invalid-input', '토큰 파일은 절대 경로입니다.');
    this.generation = generation; this.timeoutMs = timeoutMs; this.retries = retries;
    this.lastResponse = undefined;
  }
  token() {
    try { return readFileSync(this.tokenFile, 'utf8').trim(); } catch { throw new DomainError('control-token-missing', '제어자 토큰 파일을 읽지 못했습니다.'); }
  }
  async request(type, { commandId, expect, payload, generation } = {}) {
    if (MUTATING.has(type)) string(commandId, 'commandId');
    const request = { protocol: PROTOCOL, version: PROTOCOL_VERSION, type, ...(type === 'hello' ? {} : { controller: this.controller, token: this.token() }),
      ...((generation ?? this.generation) !== undefined && type !== 'hello' ? { generation: generation ?? this.generation } : {}),
      ...(commandId ? { commandId } : {}), ...(expect ? { expect } : {}), ...(payload ? { payload } : {}) };
    let lastError;
    for (let attempt = 0; attempt <= (MUTATING.has(type) ? this.retries : 0); attempt++) {
      try {
        const response = await callOnce(this.cliPath, this.projectPath, request, { timeoutMs: this.timeoutMs });
        this.lastResponse = response;
        if (!response.ok) throw new ControlError(response.error ?? { code: 'internal', message: '오류 내용이 없습니다.' }, response);
        return response;
      } catch (error) {
        if (error.code !== 'control-unavailable') throw error;
        lastError = error; // 응답을 잃었다 — 같은 commandId 로 다시 보내면 기록된 응답이 돌아온다
      }
    }
    throw lastError;
  }
  async result(type, options) { return (await this.request(type, options)).result; }
}
