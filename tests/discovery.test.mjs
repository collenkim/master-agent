import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { join, delimiter } from 'node:path';
import { findCodeAgent } from '../packages/code-agent-adapter/discovery.mjs';
import { temporary } from './helpers.mjs';

function installed(root) {
  const pkg = join(root, 'node_modules', 'code-agent'); mkdirSync(pkg, { recursive: true });
  writeFileSync(join(root, 'code-agent.cmd'), '@echo never execute this wrapper');
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'code-agent', bin: { 'code-agent': 'cli.mjs' } }));
  writeFileSync(join(pkg, 'cli.mjs'), '');
  return realpathSync(join(pkg, 'cli.mjs'));
}

test('discovers npm Windows shims using package bin and PATH order without invoking a shell', t => {
  const root = temporary(t), first = join(root, 'first'), second = join(root, 'second');
  const entry = installed(first); installed(second);
  assert.equal(findCodeAgent(undefined, { platform: 'win32', env: { PATH: [first, second].join(delimiter) } }), entry);
  assert.equal(findCodeAgent(undefined, { platform: 'win32', env: { PATH: second, CODE_AGENT_CLI: entry } }), entry);
  assert.throws(() => findCodeAgent(join(root, 'missing.js'), { env: { PATH: first } }), { code: 'invalid-cli' });
});

test('discovers standalone exe and npm appdata installation; absence does not invent a path', t => {
  const root = temporary(t), npm = join(root, 'npm');
  const entry = installed(npm);
  assert.equal(findCodeAgent(undefined, { platform: 'win32', env: { APPDATA: root } }), entry);
  const exe = join(root, 'code-agent.exe'); writeFileSync(exe, 'fixture');
  assert.equal(findCodeAgent(undefined, { platform: 'win32', env: { PATH: root } }), realpathSync(exe));
  assert.equal(findCodeAgent(undefined, { platform: 'win32', env: {}, required: false }), null);
  assert.throws(() => findCodeAgent(undefined, { platform: 'win32', env: {} }), { code: 'code-agent-unavailable' });
  assert.throws(() => findCodeAgent(join(npm, 'code-agent.cmd')), { code: 'invalid-cli' });
});
