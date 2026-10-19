import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { temporary } from './helpers.mjs';
import { dashboardCommand } from '../packages/dashboard/lifecycle.mjs';
import { startDashboard } from '../packages/dashboard/server.mjs';

const cli = fileURLToPath(new URL('../apps/cli/main.mjs', import.meta.url));
const exec = promisify(execFile);
const record = db => JSON.parse(readFileSync(`${db}.dashboard.json`, 'utf8'));
const run = async (db, ...args) => JSON.parse((await exec(process.execPath, [cli, 'dashboard', ...args, '--db', db], { timeout: 15000, windowsHide: true })).stdout);
function start(db, children, ...args) {
  const child = spawn(process.execPath, [cli, 'dashboard', ...args, '--db', db], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  return new Promise((resolve, reject) => {
    let output = '', errors = '';
    const timeout = setTimeout(() => { child.kill(); reject(new Error('dashboard start timeout')); }, 15000);
    child.stderr.on('data', data => { errors += data; });
    child.on('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', () => { clearTimeout(timeout); reject(new Error(errors || 'dashboard exited before ready')); });
    child.stdout.on('data', data => {
      output += data;
      if (output.includes('\n')) {
        clearTimeout(timeout);
        try { resolve({ child, info: JSON.parse(output.split('\n')[0]) }); } catch (error) { reject(error); }
      }
    });
  });
}
async function cleanup(children) {
  for (const child of children) if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
}

test('dashboard CLI restarts a real process with the same catalog, URL and settings; stop/status and stopped restart work', async t => {
  const root = temporary(t), db = join(root, 'master.db'), children = [];
  try {
    const first = await start(db, children, '--saved', '--port', '0', '--refresh-ms', '1200');
    const original = record(db);
    const { token } = await (await fetch(first.info.url + '/api/overview')).json();
    const group = { id: 'persistent', name: '재시작 후 유지', projectIds: [] };
    assert.equal((await fetch(first.info.url + '/api/groups', { method: 'POST',
      headers: { Origin: first.info.url, 'Content-Type': 'application/json', 'X-Master-Token': token },
      body: JSON.stringify({ group }) })).status, 200);
    const unauthorized = await fetch(first.info.url + '/api/dashboard-control', { method: 'POST',
      headers: { Origin: first.info.url, 'Content-Type': 'application/json', 'X-Master-Token': token },
      body: JSON.stringify({ id: original.id, action: 'stop' }) });
    assert.equal(unauthorized.status, 403);
    await assert.rejects(run(db, 'restart', '--port', '-1'));
    await assert.rejects(run(db, 'start'), /dashboard-busy/);
    assert.equal((await run(db, 'status')).state, 'running');
    const firstExited = once(first.child, 'exit');
    const second = await start(db, children, 'restart');
    await firstExited;
    assert.notEqual(second.child.pid, first.child.pid);
    assert.equal(second.info.url, first.info.url);
    assert.equal(second.info.db, db);
    const saved = record(db);
    assert.notEqual(saved.id, original.id); assert.notEqual(saved.token, original.token);
    assert.equal(saved.options.observe, false); assert.equal(saved.options.intervalMs, 1200);
    assert.equal(saved.options.cwd, original.options.cwd);
    const snapshot = await (await fetch(second.info.url + '/api/overview')).json();
    assert.equal(snapshot.live, false); assert.equal(snapshot.intervalMs, 1200);
    assert.equal(snapshot.groups.find(g => g.id === group.id).name, group.name);
    assert.equal((await run(db, 'stop')).state, 'stopped');
    assert.equal((await run(db, 'status')).state, 'stopped');
    assert.equal(existsSync(`${db}.dashboard.lock`), false);
    assert.equal((await run(db, 'stop')).state, 'stopped');
    const third = await start(db, children, 'restart');
    assert.equal(third.info.url, first.info.url);
    await run(db, 'stop');
  } finally { await cleanup(children); }
});

test('stale dashboard locks recover only after owner exit; an unrelated live server is never stopped', async t => {
  const root = temporary(t), db = join(root, 'master.db');
  const exited = spawn(process.execPath, ['-e', ''], { windowsHide: true, stdio: 'ignore' });
  await once(exited, 'exit');
  writeFileSync(`${db}.dashboard.lock`, JSON.stringify({ id: 'stale', pid: exited.pid }));
  const recovered = await dashboardCommand('restart', { dbPath: db, port: 0, observe: false });
  await recovered.close();
  const other = await startDashboard({ dbPath: join(root, 'other.db'), port: 0, observe: false });
  try {
    writeFileSync(`${db}.dashboard.lock`, JSON.stringify({ id: 'wrong', pid: process.pid }));
    writeFileSync(`${db}.dashboard.json`, JSON.stringify({ id: 'wrong', token: 'wrong', url: other.url, options: { port: 0, observe: false } }));
    await assert.rejects(dashboardCommand('restart', { dbPath: db }), error => error.code === 'dashboard-unavailable');
    assert.equal((await fetch(other.url + '/api/overview')).status, 200);
    assert.equal(JSON.parse(readFileSync(`${db}.dashboard.lock`, 'utf8')).id, 'wrong');
    assert.equal((await dashboardCommand('status', { dbPath: db })).info.state, 'unreachable');
  } finally { await other.close(); }
});
