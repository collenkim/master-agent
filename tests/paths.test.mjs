import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { temporary } from './helpers.mjs';
import { normalizedPath } from '../packages/catalog/catalog.mjs';
import { snapshotTree } from '../packages/verification/tree.mjs';

test('Windows short and long paths identify the same repository without accepting subdirectories', { skip: process.platform !== 'win32' }, t => {
  const root = temporary(t), repository = join(root, 'repository with long name');
  mkdirSync(repository); mkdirSync(join(repository, 'nested'));
  const short = execFileSync('cmd.exe', ['/d', '/c', 'for %I in ("repository with long name") do @echo %~sI'],
    { cwd: root, encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: true }).trim();
  if (short === repository) { t.skip('8.3 short names are disabled on this volume'); return; }
  const git = (...args) => execFileSync('git', ['-C', repository, ...args], { stdio: 'pipe', windowsHide: true });
  git('init', '-q'); writeFileSync(join(repository, 'source.txt'), 'fixture'); git('add', 'source.txt');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture');
  assert.equal(normalizedPath(short), normalizedPath(repository));
  assert.deepEqual(snapshotTree(short), snapshotTree(repository));
  assert.equal(snapshotTree(short).root, realpathSync.native(repository));
  assert.throws(() => snapshotTree(join(short, 'nested')), { code: 'invalid-repository' });
});
