import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { checkMarkdown } from './markdown-links.mjs';

function files(path) { return readdirSync(path, { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(join(path, e.name)) : [join(path, e.name)]); }
const sources = ['apps', 'packages', 'scripts', 'tests'].flatMap(files).filter(f => f.endsWith('.mjs'));
for (const file of sources) execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
const docs = ['README.md', ...files('docs').filter(f => f.endsWith('.md'))];
for (const file of docs) checkMarkdown(file);
console.log(`구문 검사 ${sources.length}개, 문서 링크·앵커 ${docs.length}개 통과`);
