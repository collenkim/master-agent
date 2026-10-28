import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { temporary } from './helpers.mjs';
import { createSmokeArtifacts, finishSmokeArtifacts, pruneSmokeArtifacts, protectSmokeArtifacts, trackSmokeArtifacts } from '../scripts/smoke-artifacts.mjs';

test('C3: smoke별 최근 산출물 3개만 보존한다', t => {
  const root = join(temporary(t), 'artifacts'), paths = [];
  for (let i = 0; i < 5; i++) {
    const path = createSmokeArtifacts('sample-', { root }); paths.push(path);
    writeFileSync(join(path, 'result.txt'), String(i)); finishSmokeArtifacts(path);
  }
  assert.deepEqual(paths.map(existsSync), [false, false, true, true, true]);
  assert.equal(readdirSync(root).length, 3);
});

test('C3: 동시에 실행 중인 폴더는 한도를 넘어도 삭제하지 않는다', t => {
  const root = join(temporary(t), 'artifacts'), paths = [];
  for (let i = 0; i < 4; i++) paths.push(createSmokeArtifacts('active-', { root }));
  pruneSmokeArtifacts(root, 'active-');
  assert.ok(paths.every(existsSync));
  finishSmokeArtifacts(paths[0]);
  assert.equal(existsSync(paths[0]), false);
  assert.ok(paths.slice(1).every(existsSync));
  paths.slice(1).forEach(finishSmokeArtifacts);
});

test('C3: 표지가 없는 과거 폴더와 손상된 표지는 자동 삭제하지 않는다', t => {
  const root = join(temporary(t), 'artifacts');
  const legacy = join(root, 'sample-legacy'), malformed = join(root, 'sample-malformed');
  mkdirSync(legacy, { recursive: true }); mkdirSync(malformed);
  writeFileSync(join(legacy, 'keep.txt'), 'legacy');
  writeFileSync(join(malformed, '.master-agent-smoke.json'), '{broken');
  for (let i = 0; i < 4; i++) finishSmokeArtifacts(createSmokeArtifacts('sample-', { root }));
  assert.equal(readFileSync(join(legacy, 'keep.txt'), 'utf8'), 'legacy');
  assert.ok(existsSync(malformed));
  assert.equal(trackSmokeArtifacts(legacy), legacy);
});

test('C3: 루트 링크와 잘못된 접두어를 거부하고 외부 디렉터리는 보존한다', t => {
  const parent = temporary(t), root = join(parent, 'artifacts'), external = join(parent, 'external');
  mkdirSync(root); mkdirSync(external); writeFileSync(join(external, 'keep.txt'), 'outside');
  const rootLink = join(parent, 'root-link'), childLink = join(root, 'sample-link');
  symlinkSync(external, rootLink, 'junction'); symlinkSync(external, childLink, 'junction');
  assert.throws(() => createSmokeArtifacts('../escape-', { root }));
  assert.throws(() => createSmokeArtifacts('sample-', { root: rootLink }));
  for (let i = 0; i < 4; i++) finishSmokeArtifacts(createSmokeArtifacts('sample-', { root }));
  assert.equal(readFileSync(join(external, 'keep.txt'), 'utf8'), 'outside');
  assert.ok(existsSync(childLink));
});

test('C3: 오래된 산출물 안의 링크를 지워도 연결 대상은 삭제하지 않는다', t => {
  const parent = temporary(t), root = join(parent, 'artifacts'), external = join(parent, 'external');
  mkdirSync(external); writeFileSync(join(external, 'keep.txt'), 'outside');
  const old = createSmokeArtifacts('sample-', { root });
  symlinkSync(external, join(old, 'dependency'), 'junction');
  finishSmokeArtifacts(old);
  for (let i = 0; i < 3; i++) finishSmokeArtifacts(createSmokeArtifacts('sample-', { root }));
  assert.equal(existsSync(old), false);
  assert.equal(readFileSync(join(external, 'keep.txt'), 'utf8'), 'outside');
});

test('C3: 외부 실행 보존 표지는 실행기 종료 후에도 유지하고 안전한 재개 뒤 해제한다', t => {
  const root = join(temporary(t), 'artifacts'), old = createSmokeArtifacts('full-flow-', { root });
  protectSmokeArtifacts(old, true); finishSmokeArtifacts(old);
  const marker = join(old, '.master-agent-smoke.json'), saved = JSON.parse(readFileSync(marker, 'utf8'));
  writeFileSync(marker, JSON.stringify({ ...saved, pid: 2147483646 }));
  for (let i = 0; i < 4; i++) finishSmokeArtifacts(createSmokeArtifacts('full-flow-', { root }));
  assert.ok(existsSync(old));
  assert.equal(trackSmokeArtifacts(old, { exclusive: true }), old);
  assert.equal(protectSmokeArtifacts(old, false), true);
  finishSmokeArtifacts(old);
  assert.ok(existsSync(old));
  assert.equal(readdirSync(root).length, 3);
});
