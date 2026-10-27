import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { temporary } from './helpers.mjs';
import { checkMarkdown, headingIds } from '../scripts/markdown-links.mjs';

test('C1: 같은 문서·상대 문서의 한국어 앵커와 중복 제목을 확인한다', t => {
  const root = temporary(t), file = join(root, 'main.md');
  writeFileSync(join(root, 'other.md'), '# 다른 문서\n## 실행과 연결\n');
  writeFileSync(file, '# 제목\n## 같은 이름\n## 같은 이름\n[같은](#같은-이름-1)\n[상대](other.md#실행과-연결)\n' +
    '\x60\x60\x60text\n[예시](없는.md#없는-앵커)\n# 코드 안 제목\n\x60\x60\x60\n');
  assert.doesNotThrow(() => checkMarkdown(file));
  assert.deepEqual([...headingIds('# 제목\n## 같은 이름\n## 같은 이름\n')], ['제목', '같은-이름', '같은-이름-1']);
});

test('C1: 없는 앵커·대상 파일·닫히지 않은 코드 블록은 검사를 실패시킨다', t => {
  const root = temporary(t), file = join(root, 'main.md');
  writeFileSync(join(root, 'other.md'), '# 다른 문서\n');
  for (const body of ['# 제목\n[같은](#없는-앵커)\n', '# 제목\n[상대](other.md#없는-앵커)\n']) {
    writeFileSync(file, body); assert.throws(() => checkMarkdown(file), /문서 앵커 없음/);
  }
  writeFileSync(file, '[대상](없는.md)\n'); assert.throws(() => checkMarkdown(file), { code: 'ENOENT' });
  writeFileSync(file, '\x60\x60\x60js\nconst x = 1;\n'); assert.throws(() => checkMarkdown(file), /코드 블록 오류/);
});
