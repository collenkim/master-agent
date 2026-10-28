import { readdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { findCodeAgent } from '../packages/code-agent-adapter/discovery.mjs';
import { childEnv, killTree } from '../packages/runner/process.mjs';

const workspace = fileURLToPath(new URL('../', import.meta.url));
const [group, option] = process.argv.slice(2);
const groups = {
  browser: readdirSync(new URL('.', import.meta.url)).filter(name => /^smoke-dashboard-.*\.mjs$/.test(name)).sort(),
  'code-agent': ['smoke-code-agent.mjs', 'smoke-interactions-live.mjs', 'smoke-interactions-live.mjs --support-only'],
  model: ['smoke-full-flow.mjs', 'smoke-answer-context.mjs', 'smoke-planner.mjs'],
};
if (!Object.hasOwn(groups, group) || option && option !== '--list') throw new Error('browser | code-agent | model [--list]');
if (option === '--list') {
  console.log(JSON.stringify(groups[group]));
} else {
  let active;
  const cancel = () => { if (active) killTree(active); process.exitCode = 130; };
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  const run = (name, args = [], capture = false) => new Promise((done, reject) => {
    if (process.exitCode) return reject(new Error('smoke 실행을 중단했다.'));
    console.log(`실행: ${name} ${args.join(' ')}`);
    const child = spawn(process.execPath, [resolve(workspace, 'scripts', name), ...args], {
      cwd: workspace, shell: false, windowsHide: true, detached: process.platform !== 'win32',
      env: childEnv(), stdio: ['inherit', capture ? 'pipe' : 'inherit', 'inherit'],
    });
    active = child;
    let output = '';
    child.stdout?.on('data', data => {
      process.stdout.write(data);
      output += data;
      if (output.length > 1024 * 1024) { killTree(child); reject(new Error('smoke 결과가 1 MiB를 넘었다.')); }
    });
    child.once('error', reject);
    child.once('close', code => {
      if (active === child) active = null;
      if (code !== 0) reject(new Error(`${name} 종료 코드: ${code}`));
      else done(output);
    });
  });
  const resultLine = (output, predicate) => {
    const values = output.split(/\r?\n/).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
    const result = values.find(predicate);
    if (!result) throw new Error('smoke 결과 JSON을 찾지 못했다.');
    return result;
  };
  try {
    if (group === 'model') {
      if (!process.env.CLAUDE_CLI) throw new Error('smoke:model 실행에는 CLAUDE_CLI가 필요하다. 실제 모델 사용료가 발생한다.');
      const prepared = resultLine(await run('smoke-full-flow.mjs', ['setup'], true), value => value.stage === 'prepared');
      await run('smoke-full-flow.mjs', ['drive', prepared.root]);
      const report = resultLine(await run('smoke-full-flow.mjs', ['report', prepared.root], true), value => typeof value.passed === 'boolean');
      if (!report.passed) throw new Error('전체 흐름 검증이 통과하지 못했다. report를 확인한다.');
      await run('smoke-answer-context.mjs', ['--ai-cli', process.env.CLAUDE_CLI]);
      await run('smoke-planner.mjs', ['--provider', 'claude', '--ai-cli', process.env.CLAUDE_CLI]);
    } else {
      const args = group === 'code-agent' ? [findCodeAgent()] : [];
      for (const entry of groups[group]) {
        const [name, ...flags] = entry.split(' ');
        await run(name, [...args, ...flags]);
      }
    }
  } finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); }
}
