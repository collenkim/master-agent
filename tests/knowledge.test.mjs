import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { setup } from './helpers.mjs';
import { Knowledge } from '../packages/knowledge/sources.mjs';

test('문서·코드를 버전 근거로 수집하고 검색 결과의 종류와 줄 번호를 보존한다', t => {
  const { store, fixture } = setup(t, { plan: false });
  const p = fixture.projects[0], k = new Knowledge(store);
  writeFileSync(join(p.path, 'POLICY.md'), '# 정책\n주문 취소는 출고 전에 가능하다.\n');
  writeFileSync(join(p.path, 'experience.md'), '가설: 취소 재시도가 필요할 수 있다.');
  const manifest = { schemaVersion: 1, sources: [{ path: 'POLICY.md', kind: 'policy' }, { path: 'experience.md', kind: 'experience' }] };
  const collected = k.collect(p.id, manifest, 1);
  assert.equal(collected.project.revision, 2);
  const again = k.collect(p.id, manifest, 2);
  assert.equal(again.changed, false); assert.equal(again.project.revision, 2);
  const hits = k.search(p.id, '취소');
  assert.equal(hits[0].line, 2); assert.equal(hits[0].kind, 'policy'); assert.equal(hits[1].kind, 'experience');
  writeFileSync(join(p.path, 'POLICY.md'), '# 정책\n주문 취소 정책 변경');
  assert.throws(() => k.current(p.id), e => e.code === 'stale-knowledge');
  const updated = k.collect(p.id, manifest, 2);
  assert.notEqual(updated.snapshot.id, collected.snapshot.id);
  assert.ok(!updated.project.references.includes(collected.snapshot.sources[0].id));
  assert.ok(store.get('knowledge-snapshot', collected.snapshot.id));
});

test('프로젝트 밖 경로·민감 파일·바이너리·큰 파일은 수집하지 않는다', t => {
  const { store, fixture } = setup(t, { plan: false });
  const p = fixture.projects[0], k = new Knowledge(store);
  for (const path of ['../outside.md', '.env', '.git/config', 'id_rsa.key', 'C:/outside.md']) {
    assert.throws(() => k.collect(p.id, { schemaVersion: 1, sources: [{ path, kind: 'code' }] }, 1), e => e.code === 'source-path-denied');
  }
  writeFileSync(join(p.path, 'binary.txt'), Buffer.from([0, 2, 3]));
  assert.throws(() => k.collect(p.id, { schemaVersion: 1, sources: [{ path: 'binary.txt', kind: 'code' }] }, 1), e => e.code === 'invalid-source');
  writeFileSync(join(p.path, 'large.md'), 'a'.repeat(65537));
  assert.throws(() => k.collect(p.id, { schemaVersion: 1, sources: [{ path: 'large.md', kind: 'code' }] }, 1), e => e.code === 'source-too-large');
  assert.equal(store.need('project', p.id).revision, 1);
});

test('디렉터리 링크를 통한 외부 근거 수집을 거부한다', t => {
  const { store, fixture, root } = setup(t, { plan: false });
  const p = fixture.projects[0], outside = join(root, 'outside'); mkdirSync(outside);
  writeFileSync(join(outside, 'document.md'), '외부 자료');
  symlinkSync(outside, join(p.path, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => new Knowledge(store).collect(p.id, { schemaVersion: 1, sources: [{ path: 'linked/document.md', kind: 'code' }] }, 1), e => e.code === 'source-path-denied');
});

test('planning adds bounded relevant implementation evidence without losing policy or expanding on each retry', t => {
  const { store, fixture, root } = setup(t, { plan: false }), p = fixture.projects[0], k = new Knowledge(store);
  writeFileSync(join(p.path, 'POLICY.md'), 'An explicitly selected policy');
  k.collect(p.id, { schemaVersion: 1, sources: [{ path: 'POLICY.md', kind: 'policy' }] }, 1);
  mkdirSync(join(p.path, 'src/generated'), { recursive: true });
  mkdirSync(join(p.path, 'tests'));
  writeFileSync(join(p.path, 'test'), 'a test launcher, not a source directory');
  for (let i = 0; i < 20; i++) writeFileSync(join(p.path, `src/Other${i}.java`), `class Other${i} {}`);
  writeFileSync(join(p.path, 'src/TenantFilter.java'), 'class TenantFilter {}');
  writeFileSync(join(p.path, 'tests/TenantFilterTest.java'), 'class TenantFilterTest {}');
  writeFileSync(join(p.path, 'src/Secret.java'), 'excluded secret fixture');
  writeFileSync(join(p.path, 'src/generated/TenantGenerated.java'), 'excluded generated fixture');
  writeFileSync(join(p.path, 'src/tenant.json'), '{"private":"excluded config fixture"}');
  mkdirSync(join(root, 'outside'));
  writeFileSync(join(root, 'outside/TenantOutside.java'), 'excluded external fixture');
  symlinkSync(join(root, 'outside'), join(p.path, 'src/linked'), process.platform === 'win32' ? 'junction' : 'dir');
  const options = { includeImplementation: true, goal: 'Tenant filter' }, snapshot = k.prepare(p.id, options);
  const paths = snapshot.sources.map(s => s.path);
  assert.equal(paths.length, 13); assert.equal(snapshot.sources[0].kind, 'policy');
  assert.ok(paths.includes('src/TenantFilter.java')); assert.ok(paths.includes('tests/TenantFilterTest.java'));
  assert.ok(!snapshot.sources.some(s => s.content.includes('excluded')));
  assert.equal(k.prepare(p.id, options).id, snapshot.id);
  writeFileSync(join(p.path, 'src/TenantFilter.java'), 'class TenantFilter { int changed; }');
  assert.notEqual(k.prepare(p.id, options).id, snapshot.id);
});
