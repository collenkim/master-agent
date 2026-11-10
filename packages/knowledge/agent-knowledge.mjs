import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { DomainError, requireThat } from '../domain/contracts.mjs';
import { execFileTree, spawnArgs } from '../runner/process.mjs';

/**
 * agent-knowledge 로컬 CLI 호출 경계. 생산자 계약은 agent-knowledge docs/retrieval.md 의 search·get v1 이다.
 * stdout JSON 문서 하나와 종료 코드를 함께 읽는다(오류 문서도 stdout). 오류 원문·로컬 경로는 저장하지 않고 코드만 남긴다.
 * 연결은 MASTER_AGENT_KNOWLEDGE_* 환경 변수 한 곳에서만 읽는다 — 프로젝트별 사용 여부는 binding 레코드(retrieval.mjs)가 정한다.
 */
export const SEARCH_SCHEMA = 'agent-knowledge.search';
export const GET_SCHEMA = 'agent-knowledge.get';
const ERROR_SCHEMA = 'agent-knowledge.error';
const KEBAB = /^[a-z][a-z0-9-]{0,63}$/;
export const KNOWLEDGE_ENV = Object.freeze({ cli: 'MASTER_AGENT_KNOWLEDGE_CLI', config: 'MASTER_AGENT_KNOWLEDGE_CONFIG', db: 'MASTER_AGENT_KNOWLEDGE_DB',
  retrievalConfig: 'MASTER_AGENT_KNOWLEDGE_RETRIEVAL_CONFIG', timeoutMs: 'MASTER_AGENT_KNOWLEDGE_TIMEOUT_MS' });

export const sha256 = value => createHash('sha256').update(value).digest('hex');

export class KnowledgeCallError extends DomainError {
  constructor(code, message, { producerCode = null, reason = null } = {}) { super(code, message); this.producerCode = producerCode; this.reason = reason; }
  /** 저장·화면용 — 메시지 원문 대신 코드만 */
  get diagnostic() { return { code: this.code, ...(this.producerCode ? { producerCode: this.producerCode } : {}), ...(this.reason ? { reason: this.reason } : {}) }; }
}
const fail = (code, message, detail) => { throw new KnowledgeCallError(code, message, detail); };
/** 임의 오류를 저장 가능한 진단 코드로 줄인다(메시지·경로 없음) */
export function diagnosticOf(error) {
  if (error instanceof KnowledgeCallError) return error.diagnostic;
  return { code: typeof error?.code === 'string' && KEBAB.test(error.code) ? error.code : 'knowledge-error' };
}

function absoluteFile(value, label, required) {
  if (value === undefined || value === null || value === '') {
    if (required) fail('knowledge-not-configured', `${label}: agent-knowledge 연결 경로가 없습니다.`);
    return null;
  }
  if (typeof value !== 'string' || !isAbsolute(value)) fail('knowledge-not-configured', `${label}: 절대 경로가 필요합니다.`);
  return value;
}

/** 환경 변수의 연결 설정. CLI 경로가 없으면 연결이 없는 것(null)이고, 있으면 실행 가능한 연결로 해석하거나 설정 오류를 던진다 */
export function knowledgeConnection(env = process.env) {
  if (!env?.[KNOWLEDGE_ENV.cli]) return null;
  const cli = absoluteFile(env[KNOWLEDGE_ENV.cli], 'cli', true);
  if (!existsSync(cli) || !statSync(cli).isFile()) fail('knowledge-unavailable', 'agent-knowledge CLI 파일이 없습니다.');
  try { spawnArgs(cli); } catch { fail('knowledge-not-configured', 'agent-knowledge CLI는 node로 실행할 .js·.mjs 파일이어야 합니다.'); }
  const config = absoluteFile(env[KNOWLEDGE_ENV.config], 'config', false), db = absoluteFile(env[KNOWLEDGE_ENV.db], 'db', false);
  if (!config && !db) fail('knowledge-not-configured', 'agent-knowledge 원본 설정(config) 또는 색인 DB(db) 경로가 필요합니다.');
  // 검색 설정은 항상 명시 경로로 고정한다 — 생산자 기본값·환경에 맡기면 같은 세대에서도 결과가 바뀔 수 있다
  const retrievalConfig = absoluteFile(env[KNOWLEDGE_ENV.retrievalConfig], 'retrievalConfig', false) ?? resolve(dirname(cli), '..', '..', '..', 'config', 'retrieval.yaml');
  if (!existsSync(retrievalConfig) || !statSync(retrievalConfig).isFile()) fail('knowledge-not-configured', '검색 설정 파일(retrieval.yaml)을 찾을 수 없습니다.');
  const raw = env[KNOWLEDGE_ENV.timeoutMs];
  const timeoutMs = raw === undefined || raw === '' ? 20000 : Number(raw);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000) fail('knowledge-not-configured', 'MASTER_AGENT_KNOWLEDGE_TIMEOUT_MS는 1000~120000 정수입니다.');
  return { cli, config, db, retrievalConfig, timeoutMs };
}

/** 같은 세대에서도 결과를 바꾸는 검색 설정 바이트의 해시 — 생산자가 설정 해시를 내지 않으므로 master가 직접 고정한다 */
export function retrievalConfigSha256(connection) { return sha256(readFileSync(connection.retrievalConfig)); }

function document(stdout) {
  const text = typeof stdout === 'string' ? stdout.trim() : '';
  if (!text || text.includes('\n')) fail('knowledge-invalid-output', 'agent-knowledge 출력이 JSON 문서 하나가 아닙니다.');
  try { return JSON.parse(text); } catch { return fail('knowledge-invalid-output', 'agent-knowledge 출력 JSON을 읽을 수 없습니다.'); }
}

/** search·get 요청 한 건. 요청은 임시 파일(--request)로 넘긴다 — 자식 stdin은 닫혀 있고 질의를 명령줄에 싣지 않는다 */
export async function callKnowledge(connection, command, request, { timeoutMs = connection.timeoutMs, maxBytes = 2 * 1024 * 1024 } = {}) {
  requireThat(['search', 'get'].includes(command), 'invalid-input', '지원하지 않는 agent-knowledge 명령입니다.');
  const parent = realpathSync(tmpdir()), root = realpathSync(mkdtempSync(join(parent, 'master-agent-knowledge-')));
  try {
    const file = join(root, 'request.json');
    writeFileSync(file, JSON.stringify(request));
    const { executable, prefix } = spawnArgs(connection.cli);
    const args = [...prefix, command, ...(connection.config ? ['--config', connection.config] : []), ...(connection.db ? ['--db', connection.db] : []),
      '--retrieval-config', connection.retrievalConfig, '--quiet', '--request', file];
    let stdout, exitCode = 0;
    try {
      // 생산자가 읽는 주변 환경 변수는 빈 값으로 덮는다(빈 값은 무시된다) — 명시한 경로만 쓴다
      ({ stdout } = await execFileTree(executable, args, { cwd: root, timeout: timeoutMs, maxBuffer: maxBytes, encoding: 'utf8',
        env: { AGENT_KNOWLEDGE_CONFIG: '', AGENT_KNOWLEDGE_DB: '', AGENT_KNOWLEDGE_RETRIEVAL_CONFIG: '' } }));
    } catch (error) {
      if (error.code === 'ETIMEDOUT') fail('knowledge-timeout', 'agent-knowledge 응답 시간이 지났습니다.');
      if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') fail('knowledge-output-limit', 'agent-knowledge 출력이 크기 상한을 넘었습니다.');
      if (!Number.isInteger(error.code) || typeof error.stdout !== 'string') fail('knowledge-unavailable', 'agent-knowledge를 실행하지 못했습니다.');
      exitCode = error.code; stdout = error.stdout;
    }
    const doc = document(stdout);
    if (doc?.schema === ERROR_SCHEMA) {
      if (doc.schemaVersion !== 1) fail('knowledge-unsupported-version', '지원하지 않는 agent-knowledge 오류 형식입니다.');
      const producerCode = typeof doc.error?.code === 'string' && KEBAB.test(doc.error.code) ? doc.error.code : 'unknown';
      const reason = typeof doc.error?.detail?.reason === 'string' && KEBAB.test(doc.error.detail.reason) ? doc.error.detail.reason : null;
      fail('knowledge-producer-error', 'agent-knowledge가 요청을 처리하지 못했습니다.', { producerCode, reason });
    }
    const schema = command === 'search' ? SEARCH_SCHEMA : GET_SCHEMA;
    if (doc?.schema !== schema || doc.schemaVersion !== 1) fail('knowledge-unsupported-version', `지원하지 않는 agent-knowledge 응답 형식입니다(${schema} v1 필요).`);
    const statuses = command === 'search' ? { ok: 0, 'no-results': 3 } : { ok: 0 };
    if (doc.ok !== true || !Object.hasOwn(statuses, doc.status) || statuses[doc.status] !== exitCode) fail('knowledge-invalid-output', 'agent-knowledge 응답 상태와 종료 코드가 맞지 않습니다.');
    return doc;
  } finally {
    requireThat(dirname(root) === parent && basename(root).startsWith('master-agent-knowledge-'), 'invalid-temp-path', '임시 경로 경계 오류');
    rmSync(root, { recursive: true, force: true });
  }
}
