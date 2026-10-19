import { lstatSync, readFileSync, realpathSync, readdirSync, existsSync } from 'node:fs';
import { resolve, relative, isAbsolute, sep } from 'node:path';
import { TextDecoder } from 'node:util';
import { hash, now, object, string, requireThat } from '../domain/contracts.mjs';

const kinds = ['overview', 'policy', 'contract', 'code', 'plan', 'experience'];
const blocked = /^(?:\.git|\.master-agent|\.codex|\.claude|\.aws|\.ssh|node_modules|\.env(?:\..*)?|credentials?(?:\..*)?|secrets?(?:\..*)?|auth\.json)$/i;
const deniedExtension = /\.(?:pem|key|p12|pfx|db|sqlite|exe|dll|zip)$/i;
const MAX_FILE_BYTES = 64 * 1024, MAX_TOTAL_BYTES = 256 * 1024;
const standardSources = ['README.md', 'README', 'docs/README.md', 'package.json', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts', 'go.mod', 'Cargo.toml', 'pyproject.toml', 'requirements.txt'];

/** Directory names are observations, not invented policy or an assertion that a project is empty. */
function inventorySource(root, projectId) {
  const actual = realpathSync(root);
  const entries = readdirSync(actual, { withFileTypes: true }).filter(e => !e.name.startsWith('.') && !blocked.test(e.name) && !deniedExtension.test(e.name) && !['build', 'dist', 'target', 'vendor'].includes(e.name))
    .map(e => ({ name: e.name, kind: e.isSymbolicLink() ? 'link-not-followed' : e.isDirectory() ? 'directory' : 'file' })).sort((a, b) => a.name.localeCompare(b.name));
  requireThat(entries.length <= 500, 'source-too-large', '최상위 항목이 너무 많습니다. project collect로 필요한 근거를 지정하세요.');
  const content = JSON.stringify({ basis: 'observed-project-directory', entries,
    limitations: '최상위 이름만 관측했다. 파일 내용·기술 스택·업무 정책·구현 완료를 증명하지 않는다. 숨김·민감·생성 경로는 제외했다. 새 요구는 mission.goal을 따른다.' });
  const digest = hash(Buffer.from(content).toString('base64'));
  return { id: `source:${projectId}:inventory@${digest}`, path: '@project-inventory', origin: 'directory-inventory', actual,
    kind: 'code', content, digest, bytes: Buffer.byteLength(content), lineCount: 1 };
}

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
  prepare(projectId) {
    const project = this.store.need('project', projectId);
    try { return this.current(projectId); }
    catch (error) { if (!['missing-knowledge', 'stale-knowledge'].includes(error.code)) throw error; }
    const old = project.knowledgeSnapshotId ? this.store.need('knowledge-snapshot', project.knowledgeSnapshotId) : null;
    // Preserve explicitly selected sources; never replace a stale policy with a weaker inventory.
    if (old && !old.sources.every(s => s.origin === 'directory-inventory')) return this.collect(projectId,
      { schemaVersion: 1, sources: old.sources.map(({ path, kind }) => ({ path, kind })) }, project.revision).snapshot;
    const sources = standardSources.filter(path => existsSync(resolve(project.path, path))).map(path => ({ path, kind: /README/.test(path) ? 'overview' : 'code' }));
    if (sources.length) return this.collect(projectId, { schemaVersion: 1, sources }, project.revision).snapshot;
    return this.persist(project, [inventorySource(project.path, projectId)], project.revision).snapshot;
  }
  collect(projectId, manifest, expectedRevision, { inTransaction = false } = {}) {
    object(manifest, 'manifest');
    requireThat(manifest.schemaVersion === 1 && Array.isArray(manifest.sources) && manifest.sources.length > 0 && manifest.sources.length <= 32, 'invalid-manifest', '버전 1의 비어 있지 않은 sources 목록(최대 32개)이 필요합니다.');
    const project = this.store.need('project', projectId);
    requireThat(project.revision === expectedRevision, 'stale-state', '프로젝트 버전이 변경되었습니다.');
    const sources = manifest.sources.map(s => readSource(project.path, s, projectId));
    requireThat(new Set(sources.map(s => process.platform === 'win32' ? s.path.toLowerCase() : s.path)).size === sources.length, 'duplicate-source', '같은 근거 파일을 중복 지정했습니다.');
    requireThat(sources.reduce((n, s) => n + s.bytes, 0) <= MAX_TOTAL_BYTES, 'source-too-large', '프로젝트별 수집량은 256KiB 이하로 지정하세요.');
    return this.persist(project, sources, expectedRevision, { inTransaction });
  }
  persist(project, sources, expectedRevision, { inTransaction = false } = {}) {
    const projectId = project.id;
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
      try { actual = source.origin === 'directory-inventory' ? inventorySource(snapshot.root, snapshot.projectId) : readSource(snapshot.root, source, snapshot.projectId); }
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
