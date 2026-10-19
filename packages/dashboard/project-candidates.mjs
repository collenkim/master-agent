import { opendir, realpath, stat, readFile } from 'node:fs/promises';
import { basename, dirname, join, parse } from 'node:path';
import { homedir } from 'node:os';

const key = path => process.platform === 'win32' ? path.toLowerCase() : path;
const skipped = new Set(['node_modules', 'vendor', 'dist', 'build', 'target', 'coverage']);

/** Read installation markers in known workspaces, never execute projects or scan an entire disk. */
export async function projectCandidates(projects, { cwd = process.cwd(), home = homedir(), cliPath,
  maxDirectories = 1500, maxEntries = 15000, timeoutMs = 2500 } = {}) {
  const roots = new Set(), registered = new Map(), visited = new Set(), candidates = [];
  const addRoot = path => { if (path && path !== parse(path).root && key(path) !== key(home)) roots.add(path); };
  addRoot(cwd); addRoot(dirname(cwd));
  for (const project of projects) {
    let path = project.path;
    try { path = await realpath(path); } catch { /* Missing projects remain in the main catalog. */ }
    registered.set(key(path), project);
    addRoot(path); addRoot(dirname(path));
  }
  if (cliPath) {
    let dir = dirname(cliPath);
    for (let i = 0; i < 5 && dir !== parse(dir).root; i++, dir = dirname(dir)) {
      try {
        const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
        if (pkg.name === 'code-agent') {
          // A source/link installation points at a workspace; a plain npm install does not.
          if (basename(dirname(dir)) !== 'node_modules') addRoot(dirname(dir));
          break;
        }
      } catch { /* Not the package root. */ }
    }
  }
  for (const name of ['IdeaProjects', 'projects', 'workspace', 'repos']) addRoot(join(home, name));
  const queue = [...roots].map(path => ({ path, depth: 0 }));
  const scannedRoots = [], deadline = Date.now() + timeoutMs;
  let entries = 0, truncated = false;
  for (let cursor = 0; cursor < queue.length; cursor++) {
    if (visited.size >= maxDirectories || entries >= maxEntries || Date.now() > deadline) { truncated = true; break; }
    const item = queue[cursor];
    let path;
    try { path = await realpath(item.path); } catch { continue; }
    if (visited.has(key(path))) continue;
    visited.add(key(path));
    let directory;
    try { directory = await opendir(path); } catch { continue; }
    if (item.depth === 0) scannedRoots.push(path);
    try {
      if ((await stat(join(path, '.code-agent', 'version'))).isFile()) {
        const existing = registered.get(key(path));
        candidates.push({ name: existing?.name ?? basename(path), path,
          registeredId: existing?.id ?? null });
      }
    } catch { /* Not an installed code-agent project. */ }
    // Inspect only this directory's children, at most two levels below each known root.
    if (item.depth >= 2) { await directory.close(); continue; }
    for await (const entry of directory) {
      entries++;
      if (entries >= maxEntries || Date.now() > deadline) { truncated = true; break; }
      if (item.depth < 2 && entry.isDirectory() && !entry.name.startsWith('.') && !skipped.has(entry.name)) {
        queue.push({ path: join(path, entry.name), depth: item.depth + 1 });
      }
    }
    if (truncated) break;
  }
  candidates.sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
  return { projects: candidates, roots: scannedRoots, truncated };
}
