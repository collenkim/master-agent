import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

function files(path) { return readdirSync(path, { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(join(path, e.name)) : [join(path, e.name)]); }
const sources = ['apps', 'packages', 'scripts', 'tests'].flatMap(files).filter(f => f.endsWith('.mjs'));
for (const file of sources) execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
const docs = ['README.md', ...files('docs').filter(f => f.endsWith('.md'))];
for (const file of docs) {
  const content = readFileSync(file, 'utf8');
  if ((content.match(/```/g) ?? []).length % 2) throw new Error(`코드 블록 오류: ${file}`);
  for (const [, link] of content.matchAll(/\]\(([^)]+)\)/g)) {
    if (/^https?:/.test(link) || link.startsWith('#')) continue;
    readFileSync(resolve(dirname(file), link.split('#')[0]));
  }
}
console.log(`구문 검사 ${sources.length}개, 문서 링크 ${docs.length}개 통과`);
