import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CliProvider, findCli, providerArgs, runProcess } from '../packages/reasoning/cli-provider.mjs';
import { analysisSchema } from '../packages/reasoning/schema.mjs';
import { planningSetup } from './planning-fixture.mjs';
import { temporary } from './helpers.mjs';

for (const name of ['codex', 'claude']) {
  test(`${name} CLI stdin·구조화 출력과 실제 분석 활성화 경로`, async t => {
    const { planner, root, mission } = planningSetup(t);
    const cli = join(root, `fake-${name}.mjs`);
    const fixtureUrl = new URL('./planning-fixture.mjs', import.meta.url).href;
    writeFileSync(cli, `
      import assert from 'node:assert/strict';
      import { writeFileSync } from 'node:fs';
      import { answerFor } from ${JSON.stringify(fixtureUrl)};
      let prompt=''; for await (const chunk of process.stdin) prompt += chunk;
      assert.ok(!process.argv.some(arg => arg.includes('CONTEXT_JSON=')));
      const context=JSON.parse(prompt.match(/CONTEXT_JSON=(.*)\\nREVIEW_FEEDBACK_JSON=/)[1]);
      const data=answerFor(context);
      if (${JSON.stringify(name)}==='codex') {
        assert.equal(process.argv[process.argv.indexOf('--sandbox')+1], 'read-only');
        writeFileSync(process.argv[process.argv.indexOf('--output-last-message')+1], JSON.stringify(data));
        console.log('host log, not model JSON');
      } else {
        assert.equal(process.argv[process.argv.indexOf('--tools')+1], '');
        console.log(JSON.stringify({subtype:'success',is_error:false,structured_output:data}));
      }
    `);
    const result = await planner.analyze(mission.id, new CliProvider({ provider: name, cliPath: cli }), { expectedRevision: mission.revision });
    assert.equal(result.mission.state, 'planned');
    assert.equal(result.analysis.provider, name);
    assert.ok(result.analysis.contextHash);
  });
}

test('CLI 출력 오류·실패·시간 초과를 구분하고 인증 출력 전문을 노출하지 않는다', async t => {
  const root = temporary(t), script = join(root, 'cli.mjs');
  writeFileSync(script, 'console.error("authentication required: do-not-expose-this-token"); process.exit(1);');
  const provider = new CliProvider({ provider: 'claude', cliPath: script });
  await assert.rejects(provider.generate({ prompt: 'hello', schema: analysisSchema }), e => e.code === 'provider-auth-required' && !e.message.includes('do-not-expose'));
  writeFileSync(script, 'console.log("not JSON");');
  await assert.rejects(provider.generate({ prompt: 'hello', schema: analysisSchema }), e => e.code === 'provider-invalid-json');
  writeFileSync(script, 'setInterval(() => {}, 1000);');
  await assert.rejects(new CliProvider({ provider: 'claude', cliPath: script, timeoutMs: 150 }).generate({ prompt: 'hello', schema: analysisSchema }), e => e.code === 'provider-timeout');
});

test('셸 해석 없이 특수문자를 stdin으로 전달하고 한글 출력 분할을 보존한다', async t => {
  const root = temporary(t), script = join(root, 'unicode.mjs');
  writeFileSync(script, `let text='';for await (const chunk of process.stdin)text+=chunk;const data=Buffer.from(text);for(const byte of data){process.stdout.write(Buffer.from([byte]));await new Promise(r=>setTimeout(r,1));}`);
  const input = '한글 $(echo no) `no` & ;';
  const result = await runProcess(process.execPath, [script], { cwd: root, input, timeoutMs: 5000 });
  assert.equal(result.stdout, input);
});

test('provider 인자에 권한 우회와 워크스페이스 쓰기를 넣지 않는다', () => {
  const opts = { schemaPath: 'schema.json', outputPath: 'result.json', schema: analysisSchema };
  const codex = providerArgs('codex', opts), claude = providerArgs('claude', opts);
  assert.ok(codex.includes('--ignore-user-config')); assert.ok(codex.includes('--ephemeral'));
  assert.ok(claude.includes('--strict-mcp-config')); assert.ok(claude.includes('--no-session-persistence'));
  assert.ok(![...codex, ...claude].some(x => x.includes('dangerously') || x === 'workspace-write'));
});

test('Windows npm claude.cmd 설치를 package.json의 JS 진입점으로 탐색하고 래퍼는 실행하지 않는다', async t => {
  const root = temporary(t), npm = join(root, 'npm'), packageRoot = join(npm, 'node_modules', '@anthropic-ai', 'claude-code');
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(join(npm, 'claude.cmd'), 'exit /b 99');
  writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name: '@anthropic-ai/claude-code', bin: { claude: 'cli.js' } }));
  const entry = join(packageRoot, 'cli.js');
  writeFileSync(entry, 'console.log("npm-entry");');
  const command = findCli('claude', undefined, { env: { PATH: npm }, platform: 'win32', home: root });
  assert.equal(command.executable, process.execPath);
  assert.equal(command.prefix[0], realpathSync(entry));
  assert.match((await runProcess(command.executable, command.prefix, { cwd: root, input: '' })).stdout, /npm-entry/);
  assert.throws(() => findCli('claude', join(npm, 'claude.cmd')), e => e.code === 'invalid-cli');
  writeFileSync(join(packageRoot, 'package.json'), '{broken');
  assert.throws(() => findCli('claude', undefined, { env: { PATH: npm }, platform: 'win32', home: root }), e => e.code === 'provider-unavailable');
});
