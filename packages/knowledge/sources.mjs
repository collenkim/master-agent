import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { resolve, relative, isAbsolute, sep } from 'node:path';
import { TextDecoder } from 'node:util';
import { hash, now, object, string, requireThat } from '../domain/contracts.mjs';

const kinds = ['overview', 'policy', 'contract', 'code', 'plan', 'experience'];
const blocked = /^(?:\.git|\.master-agent|\.codex|\.claude|\.aws|\.ssh|node_modules|\.env(?:\..*)?|credentials?(?:\..*)?|secrets?(?:\..*)?|auth\.json)$/i;
const deniedExtension = /\.(?:pem|key|p12|pfx|db|sqlite|exe|dll|zip)$/i;
const MAX_FILE_BYTES = 64 * 1024, MAX_TOTAL_BYTES = 256 * 1024;

export function sourcePath(root, input) {
  string(input, 'source.path');
  const path = input.replaceAll('\\', '/');
  const parts = path.split('/');
  requireThat(!isAbsolute(input) && !/[:\x00-\x1f]/.test(path) && parts.every(p => p && p !== '.' && p !== '..' && !/[. ]$/.test(p) && !blocked.test(p)) && !deniedExtension.test(path), 'source-path-denied', `수집할 수 없는 상대 경로입니다: ${input}`);
  const base = realpathSync(root);
  let current = base;
  for (let i = 0; i < parts.length; i++) {
    current = resolve(current, parts[i]);
    const stat = lstatSync(current);
    requireThat(!stat.isSymbolicLink(), 'source-path-denied', `링크 경로는 수집하지 않습니다: ${input}`);
    requireThat(i === parts.length - 1 ? stat.isFile() : stat.isDirectory(), 'source-path-denied', `일반 파일 경로가 아닙니다: ${input}`);
  }
  const actual = realpathSync(current), rel = relative(base, actual);
  requireThat(rel && !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`), 'source-path-denied', '프로젝트 밖의 근거는 읽지 않습니다.');
  return { path: parts.join('/'), actual };
}

function readSource(root, entry, projectId) {
  object(entry, 'source');
  requireThat(kinds.includes(entry.kind), 'invalid-source', '근거 종류는 overview/policy/contract/code/plan/experience 중 하나입니다.');
  const location = sourcePath(root, entry.path);
  requireThat(lstatSync(location.actual).size <= MAX_FILE_BYTES, 'source-too-large', `${entry.path}: 파일이 너무 큽니다. 작은 문서로 나눠 지정하세요.`);
  const bytes = readFileSync(location.actual);
  requireThat(bytes.length <= MAX_FILE_BYTES && !bytes.includes(0), 'invalid-source', `${entry.path}: 크기 제한 초과 또는 바이너리 파일입니다.`);
  let content;
  try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { requireThat(false, 'invalid-source', `${entry.path}: UTF-8 텍스트가 아닙니다.`); }
  const digest = hash(bytes.toString('base64'));
  return { ...location, kind: entry.kind, content, bytes: bytes.length, digest,
    id: `source:${projectId}:${encodeURIComponent(location.path)}@${digest}`, lineCount: content.split(/\r?\n/).length };
}

export class Knowledge {
  constructor(store) { this.store = store; }
  collect(projectId, manifest, expectedRevision, { inTransaction = false } = {}) {
    object(manifest, 'manifest');
    requireThat(manifest.schemaVersion === 1 && Array.isArray(manifest.sources) && manifest.sources.length > 0 && manifest.sources.length <= 32, 'invalid-manifest', '버전 1의 비어 있지 않은 sources 목록(최대 32개)이 필요합니다.');
    const project = this.store.need('project', projectId);
    requireThat(project.revision === expectedRevision, 'stale-state', '프로젝트 버전이 변경되었습니다.');
    const sources = manifest.sources.map(s => readSource(project.path, s, projectId));
    requireThat(new Set(sources.map(s => process.platform === 'win32' ? s.path.toLowerCase() : s.path)).size === sources.length, 'duplicate-source', '같은 근거 파일을 중복 지정했습니다.');
    requireThat(sources.reduce((n, s) => n + s.bytes, 0) <= MAX_TOTAL_BYTES, 'source-too-large', '프로젝트별 수집량은 256KiB 이하로 지정하세요.');
    const digest = hash(sources.map(s => ({ path: s.path, kind: s.kind, digest: s.digest })));
    const id = `knowledge:${projectId}:${digest}`;
    const persist = () => {
      const current = this.store.need('project', projectId);
      requireThat(current.revision === expectedRevision, 'stale-state', '근거 수집 중 프로젝트가 변경되었습니다.');
      if (current.knowledgeSnapshotId === id) return { project: current, snapshot: this.store.need('knowledge-snapshot', id), changed: false };
      const old = current.knowledgeSnapshotId ? this.store.need('knowledge-snapshot', current.knowledgeSnapshotId) : undefined;
      if (!this.store.get('knowledge-snapshot', id)) this.store.put('knowledge-snapshot', { id, projectId, root: current.path, digest, sources, collectedAt: now() });
      const oldRefs = new Set(old?.sources.map(s => s.id) ?? []);
      const next = { ...current, knowledgeSnapshotId: id, references: [...new Set([...current.references.filter(r => !oldRefs.has(r)), ...sources.map(s => s.id)])] };
      const saved = this.store.put('project', next, expectedRevision);
      return { project: saved, snapshot: this.store.need('knowledge-snapshot', id), changed: true };
    };
    return inTransaction ? persist() : this.store.transaction(persist);
  }
  current(projectId) {
    const p = this.store.need('project', projectId);
    requireThat(p.knowledgeSnapshotId, 'missing-knowledge', `${projectId}: 먼저 문서·코드 근거를 수집하세요.`);
    const s = this.store.need('knowledge-snapshot', p.knowledgeSnapshotId);
    this.assertFresh(s); return s;
  }
  assertFresh(snapshot) {
    const current = this.store.need('project', snapshot.projectId);
    requireThat(current.knowledgeSnapshotId === snapshot.id && current.path === snapshot.root, 'stale-knowledge', '근거 스냅샷이 변경되었습니다.');
    for (const source of snapshot.sources) {
      let actual;
      try { actual = readSource(snapshot.root, source, snapshot.projectId); }
      catch { requireThat(false, 'stale-knowledge', `${source.path}: 근거 파일을 다시 읽을 수 없습니다.`); }
      requireThat(actual.digest === source.digest && actual.actual === source.actual, 'stale-knowledge', `${source.path}: 파일이 변경되었습니다. 다시 수집하고 분석하세요.`);
    }
  }
  search(projectId, query) {
    string(query, 'query');
    const snapshot = this.current(projectId);
    const terms = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
    return snapshot.sources.flatMap(s => s.content.split(/\r?\n/).flatMap((line, index) =>
      terms.some(term => line.toLocaleLowerCase().includes(term)) ? [{ sourceId: s.id, kind: s.kind, path: s.path, line: index + 1, text: line }] : [])).slice(0, 100);
  }
}
