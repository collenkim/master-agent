import { childEnv } from '../runner/process.mjs';
import { execFileSync } from 'node:child_process';
import { readFileSync, lstatSync, realpathSync } from 'node:fs';
import { resolve, relative, isAbsolute, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { hash, requireThat, string } from '../domain/contracts.mjs';

export function safeRelative(path) {
  string(path, 'path');
  requireThat(!isAbsolute(path) && !/[\\:*?\x00-\x1f]/.test(path) && path.split('/').every(p => p && p !== '.' && p !== '..' && !/[. ]$/.test(p) && p.toLowerCase() !== '.git'), 'invalid-path', '파일은 Git 루트 기준의 정확한 상대 경로로 지정하세요.');
  return path;
}
const git = (root, args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', shell: false, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 30000, maxBuffer: 16 * 1024 * 1024, env: childEnv({ GIT_OPTIONAL_LOCKS: '0' }) });
const normalize = path => process.platform === 'win32' ? path.toLowerCase() : path;

/** Git이 추적하거나 무시하지 않는 파일 전체를 결합한다. 파일 본문은 저장하지 않는다. */
export function snapshotTree(path) {
  const root = realpathSync(path);
  requireThat(normalize(realpathSync(git(root, ['rev-parse', '--show-toplevel']).trim())) === normalize(root), 'invalid-repository', '등록 경로가 Git 저장소 루트여야 합니다.');
  let head;
  try { head = git(root, ['rev-parse', '--verify', 'HEAD']).trim(); }
  catch { requireThat(false, 'repository-no-commit', 'Git 저장소에 커밋이 없습니다. code-agent setup baseline 또는 직접 첫 커밋을 만든 뒤 다시 확인하세요.'); }
  const paths = [...new Set(git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']).split('\0').filter(Boolean))].sort();
  requireThat(paths.length <= 20000, 'snapshot-limit', 'Git 파일 개수 제한을 넘었습니다.');
  const files = []; let bytes = 0;
  for (const path of paths) {
    safeRelative(path);
    let current = root, missing = false;
    for (const part of path.split('/')) {
      current = resolve(current, part);
      let stat;
      try { stat = lstatSync(current); } catch (error) { if (error.code === 'ENOENT') { missing = true; break; } throw error; }
      requireThat(!stat.isSymbolicLink(), 'unsupported-tree', '링크·junction이 포함된 작업 트리는 지원하지 않습니다.');
    }
    if (missing) continue; // 추적 파일 삭제는 이전 스냅샷과의 차이로 남는다.
    const stat = lstatSync(current), rel = relative(root, realpathSync(current));
    requireThat(stat.isFile() && rel && rel !== '..' && !isAbsolute(rel) && !rel.startsWith(`..${sep}`), 'unsupported-tree', '일반 파일만 검증할 수 있습니다. submodule은 별도 계약이 필요합니다.');
    bytes += stat.size;
    requireThat(stat.size <= 32 * 1024 * 1024 && bytes <= 256 * 1024 * 1024, 'snapshot-limit', '파일 스냅샷 크기 제한을 넘었습니다.');
    const data = readFileSync(current);
    files.push({ path, size: data.length, executable: process.platform !== 'win32' && Boolean(stat.mode & 0o111), digest: createHash('sha256').update(data).digest('hex') });
  }
  return { root, head, files, digest: hash(files) };
}

export function changesBetween(before, after) {
  const a = new Map(before.files.map(f => [f.path, f])), b = new Map(after.files.map(f => [f.path, f]));
  return [...new Set([...a.keys(), ...b.keys()])].sort().filter(path => hash(a.get(path) ?? null) !== hash(b.get(path) ?? null));
}

/**
 * code-agent 가 그 작업에 쓰는 기록(작업 문서·승인 원장·영수증) — 검증 계약이 codeAgentRecords 로 명시할 때만 변경으로 허용한다.
 * 제품 파일·산출물·다른 작업의 기록은 여기에 들지 않는다.
 */
export function codeAgentRecord(path, workId) {
  return typeof workId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(workId) && (path.startsWith(`doc/work/${workId}/`) ||
    path.startsWith(`.code-agent/work/${workId}/`) || path.startsWith(`.code-agent/approvals/${workId}/`) || path === `.code-agent/approvals/${workId}.jsonl`);
}
export function allowedChange(recipe, workId, path) {
  return recipe.allowedPaths.includes(path) || (recipe.codeAgentRecords === true && codeAgentRecord(path, workId));
}

const cleanTrees = new Map();
const TREE_CACHE_LIMIT = 512;
export function checkpointsCurrent(mission, exceptProjectId) {
  return Object.entries(mission.liveCheckpoints ?? {}).filter(([id]) => id !== exceptProjectId).every(([projectId, checkpoint]) => {
    const key = typeof mission.id === 'string' && Number.isInteger(mission.revision) ? JSON.stringify([mission.id, projectId]) : null;
    const cached = key && cleanTrees.get(key);
    const head = () => git(checkpoint.root, ['rev-parse', '--verify', 'HEAD']).trim();
    const clean = () => !git(checkpoint.root, ['status', '--porcelain', '--untracked-files=all']).trim();
    if (cached && cached.revision === mission.revision && cached.root === checkpoint.root && head() === cached.head && clean()) {
      return cached.digest === checkpoint.digest;
    }
    const current = snapshotTree(checkpoint.root);
    if (key && head() === current.head && clean()) {
      cleanTrees.delete(key);
      cleanTrees.set(key, { root: checkpoint.root, revision: mission.revision, head: current.head, digest: current.digest });
      if (cleanTrees.size > TREE_CACHE_LIMIT) cleanTrees.delete(cleanTrees.keys().next().value);
    }
    return current.digest === checkpoint.digest;
  });
}
