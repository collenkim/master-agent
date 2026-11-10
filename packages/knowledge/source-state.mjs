import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TextDecoder } from 'node:util';
import { childEnv } from '../runner/process.mjs';
import { commitExists } from '../verification/project-history.mjs';
import { sha256 } from './agent-knowledge.mjs';

/**
 * agent-knowledge 항목의 원본이 색인 뒤 바뀌었는지 로컬 Git·작업 트리로 확인한다(생산자 호출 없음, 읽기 전용).
 * 결과: unchanged · unchanged-lines(문서는 바뀌었지만 항목 줄은 같음) · changed · missing · unverifiable(같은 원본인지 확인 불가).
 * 줄 슬라이스 해시는 생산자와 같은 규칙(UTF-8 엄격 디코드·BOM 제거·CRLF/CR/LF 분할·'\n' 결합)이다.
 */
const MAX_SOURCE_BYTES = 16 * 1024 * 1024;
const RANK = { unchanged: 0, 'unchanged-lines': 1, changed: 3, missing: 4 };
const git = (path, args, encoding = 'utf8') => execFileSync('git', ['-C', path, ...args], { encoding, shell: false, windowsHide: true,
  timeout: 10000, maxBuffer: MAX_SOURCE_BYTES, stdio: ['ignore', 'pipe', 'pipe'], env: childEnv({ GIT_OPTIONAL_LOCKS: '0' }) });
const revParse = (path, rev) => { try { return git(path, ['rev-parse', '--verify', '--quiet', rev]).trim(); } catch { return null; } };

/** 색인 blob과 다른 내용 — 읽기·디코드 실패는 확인 불가가 아니라 변경이다 */
function contentState(bytes, item) {
  try {
    const lines = new TextDecoder('utf-8', { fatal: true }).decode(bytes).split(/\r\n|\n|\r/);
    return sha256(lines.slice(item.startLine - 1, item.endLine).join('\n')) === item.itemSha256 ? 'unchanged-lines' : 'changed';
  } catch { return 'changed'; }
}
function committedState(projectPath, item, base) {
  const current = revParse(projectPath, `${base}:${item.path}`);
  if (!current) return 'missing';
  if (current === item.blobSha) return 'unchanged';
  try { return contentState(git(projectPath, ['cat-file', 'blob', current], 'buffer'), item); } catch { return 'changed'; }
}
/** 커밋하지 않은 작업 트리 변경(선행 작업의 local-files 인계 등)도 실제 작업이 보는 원본이다 */
function worktreeState(projectPath, item) {
  const file = join(projectPath, ...item.path.split('/'));
  let stat;
  try { stat = lstatSync(file); } catch (error) { return ['ENOENT', 'ENOTDIR'].includes(error.code) ? 'missing' : 'changed'; }
  if (!stat.isFile() || stat.size > MAX_SOURCE_BYTES) return 'changed';
  let bytes;
  try { bytes = readFileSync(file); } catch { return 'changed'; }
  return sha256(bytes) === item.documentSha256 ? 'unchanged' : contentState(bytes, item);
}

/**
 * projectPath 저장소에 색인 커밋과 같은 blob이 있어야 같은 원본으로 본다(아니면 unverifiable).
 * HEAD 커밋 내용과 작업 트리 중 더 나쁜 상태를 돌려준다.
 */
export function sourceState(projectPath, item) {
  try {
    if (!projectPath || !commitExists(projectPath, item.commit) || revParse(projectPath, `${item.commit}:${item.path}`) !== item.blobSha) return 'unverifiable';
    const base = revParse(projectPath, 'HEAD^{commit}');
    if (!base) return 'unverifiable';
    const committed = committedState(projectPath, item, base), tree = worktreeState(projectPath, item);
    return RANK[tree] > RANK[committed] ? tree : committed;
  } catch { return 'unverifiable'; }
}
/** 확정 근거로 쓸 수 없는 원본 상태 */
export const staleSource = state => state === 'changed' || state === 'missing';
