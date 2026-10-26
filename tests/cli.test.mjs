import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../packages/storage/store.mjs';
import { temporary } from './helpers.mjs';
import { setup } from './helpers.mjs';
import { acceptRequest } from '../packages/orchestrator/requests.mjs';

const cli = resolve('apps/cli/main.mjs');
const run = (root, ...args) => JSON.parse(execFileSync(process.execPath, [cli, ...args], { cwd: root, encoding: 'utf8' }));

test('S1: CLI mission cancel은 사유를 저장하고 request show에 취소를 표시한다', t => {
  const { store, root, db, fixture } = setup(t);
  const { request } = acceptRequest(store, { targetType: 'project', targetId: fixture.projects[0].id, goal: '잘못 접수' });
  const m = store.need('mission', request.id);
  const result = run(root, 'mission', 'cancel', m.id, '--revision', String(m.revision), '--reason', '대상 선택 오류', '--db', db);
  assert.equal(result.state, 'cancelled'); assert.equal(result.reason, '대상 선택 오류');
  assert.equal(run(root, 'request', 'show', m.id, '--db', db).state, 'cancelled');
});

test('CLI 데모가 영속 DB를 만들고 다른 프로세스에서 판단·근거를 읽는다', t => {
  const root = temporary(t);
  const result = run(root, 'demo');
  assert.equal(result.state, 'simulation-complete');
  const detail = run(root, 'mission', 'show', result.id);
  assert.equal(detail.decisions.length, 10);
  assert.equal(detail.evidence.length, 4);
  assert.equal(run(root, 'project', 'list').length, 3);
  assert.equal(run(root, 'mission', 'list')[0].id, result.id);
});

test('CLI 잘못된 명령과 명시되지 않은 모의 실행은 DB 생성 전에 거부한다', t => {
  const root = temporary(t);
  for (const args of [['nonsense'], ['mission', 'run', 'id'], ['mission', 'pause', 'id', '--revision', 'bad'], ['mission', 'dispatch', 'id', 'task', '--revision', '1']]) {
    const result = spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stderr).error, 'usage');
  }
  assert.equal(existsSync(join(root, '.master-agent')), false);
});

test('project pair 는 사람의 터미널(TTY) 없이 실행되지 않고 DB도 만들지 않는다', t => {
  const root = temporary(t);
  const result = spawnSync(process.execPath, [cli, 'project', 'pair', 'p1'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stderr).error, 'usage');
  assert.equal(existsSync(join(root, '.master-agent')), false);
});

test('알 수 없는 버전과 손상된 저장소를 조용히 초기화하지 않는다', t => {
  const root = temporary(t);
  const path = join(root, 'future.db');
  const db = new DatabaseSync(path); db.exec('PRAGMA user_version=99'); db.close();
  assert.throws(() => new Store(path), e => e.code === 'unsupported-version');
  const corrupt = join(root, 'corrupt.db'); writeFileSync(corrupt, 'not a sqlite database');
  assert.throws(() => new Store(corrupt));
  const other = join(root, 'other.db');
  const existing = new DatabaseSync(other); existing.exec('CREATE TABLE important_data(id INTEGER)'); existing.close();
  assert.throws(() => new Store(other), e => e.code === 'unknown-database');
});
