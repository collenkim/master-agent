import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, lstatSync, mkdtempSync, rmdirSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join, resolve, extname } from 'node:path';
import { Catalog, normalizedPath } from '../catalog/catalog.mjs';
import { pendingHumanResponse } from '../code-agent-adapter/interactions.mjs';
import { hash, now, requireThat } from '../domain/contracts.mjs';
import { findCodeAgent } from '../code-agent-adapter/discovery.mjs';
import { createSourceBuilder, sourceSummary } from './source-update.mjs';

const alive = pid => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
};
const abandoned = record => record.host === hostname() && !alive(record.pid);
const clip = value => String(value ?? '').slice(-8000);

/** Public commands only. Never inherit runtime delegation overrides from the parent. */
export function runUpdateCli(cliPath, args, cwd, onSpawn = () => {}) {
  const js = ['.js', '.mjs', '.cjs'].includes(extname(cliPath).toLowerCase());
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0' };
  for (const key of Object.keys(env)) if (/^CODE_AGENT_(RUNTIME|ENTRY)/.test(key)) delete env[key];
  return new Promise(resolveResult => {
    const child = execFile(js ? process.execPath : cliPath, [...(js ? [cliPath] : []), ...args], {
      cwd, env, shell: false, windowsHide: true, encoding: 'utf8', timeout: args[0] === 'version' ? 15000 : 120000,
      maxBuffer: 4 * 1024 * 1024,
    }, (error, stdout, stderr) => resolveResult({ code: error?.code ?? 0, uncertain: Boolean(error?.killed || error?.signal), stdout, stderr }));
    if (child.pid) {
      try { onSpawn(child.pid); }
      catch (error) { child.kill(); resolveResult({ code: 'spawn-record-failed', uncertain: true, stderr: error.message }); }
    }
  });
}

/** Same package version can contain a new build. Bind approval to code and templates. */
export function installationFingerprint(cliPath) {
  const digest = createHash('sha256'); let count = 0, bytes = 0;
  const walk = path => {
    const stat = lstatSync(path);
    requireThat(!stat.isSymbolicLink(), 'invalid-cli', '설치 파일의 심볼릭 링크는 일괄 업데이트에서 지원하지 않습니다.');
    if (stat.isDirectory()) { for (const name of readdirSync(path).sort()) walk(join(path, name)); return; }
    requireThat(stat.isFile() && ++count <= 20000 && (bytes += stat.size) <= 256 * 1024 * 1024, 'invalid-cli', '설치 파일 조회 한도를 초과했습니다.');
    digest.update(path); digest.update('\0'); digest.update(readFileSync(path)); digest.update('\0');
  };
  if (['.js', '.mjs', '.cjs'].includes(extname(cliPath).toLowerCase())) {
    const root = resolve(cliPath, '../../..');
    requireThat(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).name === 'code-agent', 'invalid-cli', 'code-agent 패키지 진입점이 필요합니다.');
    for (const name of ['package.json', 'dist', 'template']) walk(join(root, name));
  } else walk(cliPath);
  return digest.digest('hex');
}

export function createUpdates(store, { cliPath, run = runUpdateCli, cacheRoot, sourceBuilder = createSourceBuilder({ cacheRoot }) } = {}) {
  const plans = new Map(); let pending, stopped = false;
  const catalog = new Catalog(store);
  const scope = () => hash(catalog.projects().map(p => [p.id, p.path, p.revision]));
  const save = batch => store.put('agent-update', { ...batch, updatedAt: now() }, store.need('agent-update', batch.id).revision);
  async function version(cli, path) {
    const result = await run(cli, ['version', '--json'], path);
    requireThat(result.code === 0 && !result.uncertain, 'version-error', `버전 조회 실패: ${clip(result.stderr || result.stdout)}`);
    let view;
    try { view = JSON.parse(result.stdout); } catch { requireThat(false, 'version-error', '버전 응답이 JSON이 아닙니다.'); }
    requireThat(view?.schema === 'code-agent.version v1' && ['bundle', 'release'].includes(view.running?.kind) &&
      typeof view.running.version === 'string' && Array.isArray(view.project?.busy) && view.project.busy.every(r => typeof r === 'string') &&
      typeof view.project.root === 'string' && normalizedPath(view.project.root) === normalizedPath(path),
    'version-error', '지원하지 않는 버전 응답이거나 프로젝트 루트가 일치하지 않습니다.');
    requireThat(!view.project.problem && !view.running.entryPackage?.problem, 'version-error', view.project.problem || view.running.entryPackage?.problem);
    return view;
  }
  async function target(override = cliPath) {
    const cli = findCodeAgent(override), fingerprint = installationFingerprint(cli);
    const neutral = mkdtempSync(join(tmpdir(), 'master-agent-version-'));
    let view;
    try { view = await version(cli, neutral); } finally { rmdirSync(neutral); }
    const packageId = view.running.entryPackage?.id;
    requireThat(packageId || view.running.kind === 'bundle', 'unsupported-version', '릴리스 전용 진입점은 터미널에서 전환하세요. 현재 설치 패키지 또는 번들 진입점이 필요합니다.');
    requireThat(installationFingerprint(cli) === fingerprint, 'stale-state', '조회 중 설치본이 변경되었습니다. 다시 조회하세요.');
    return { cli, fingerprint, version: view.running.version, packageId: packageId ?? null,
      args: ['update', packageId ? '--templates-only' : '--bundled'], resetsPin: !packageId };
  }
  async function inspect(project, installed) {
    const row = { id: project.id, name: project.name, path: project.path, revision: project.revision };
    try {
      requireThat(existsSync(join(project.path, '.code-agent/version')), 'not-installed', 'code-agent 설치 표시가 없습니다.');
      const view = await version(installed.cli, project.path);
      row.current = view.project.applied ?? `번들 ${view.running.version}`;
      const maintenance = store.get('project-maintenance', project.id);
      const reasons = [...view.project.busy, ...(store.lock(project.id) ? ['master-agent 작업 실행 중'] : []),
        ...(pendingHumanResponse(store, project.id) ? ['사람 응답 전송·적용 결과 확인 필요'] : []),
        ...(maintenance?.active ? ['업데이트 진행 중 또는 중단 점검 필요'] : [])];
      return { ...row, state: reasons.length ? 'skipped' : 'ready', detail: reasons.join(' · ') || '상태를 다시 확인한 뒤 선택한 버전을 적용합니다.' };
    } catch (error) { return { ...row, state: 'skipped', detail: error.message }; }
  }
  async function preview({ mode = 'remote' } = {}) {
    requireThat(!stopped, 'update-stopped', '서버가 종료 중입니다.');
    requireThat(['remote', 'installed'].includes(mode), 'invalid-input', '업데이트 방식은 remote 또는 installed입니다.');
    const scopeHash = scope(), projects = catalog.projects(), installed = await target();
    const source = mode === 'remote' ? await sourceBuilder.audit(installed.cli) : null;
    const rows = [], queue = [...projects];
    await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => {
      while (queue.length) rows.push(await inspect(queue.shift(), installed));
    }));
    requireThat(scope() === scopeHash, 'stale-state', '조회 중 프로젝트 목록이 바뀌었습니다. 다시 조회하세요.');
    const plan = { id: randomUUID(), createdAt: now(), mode, scopeHash, target: installed,
      ...(source ? { source: sourceSummary(source) } : {}), projects: rows.sort((a, b) => a.id.localeCompare(b.id)) };
    plans.set(plan.id, { plan, source });
    while (plans.size > 10) plans.delete(plans.keys().next().value);
    return plan;
  }
  function claim(project, batch) {
    store.transaction(() => {
      const current = store.need('project', project.id);
      requireThat(current.revision === project.revision && current.path === project.path, 'stale-state', '프로젝트 정보가 변경되었습니다.');
      requireThat(!store.lock(project.id), 'project-busy', 'master-agent 작업 실행 중');
      requireThat(!pendingHumanResponse(store, project.id), 'project-busy', '사람 응답 전송·적용 결과 확인 필요');
      const old = store.get('project-maintenance', project.id);
      requireThat(!old?.active, 'project-busy', '업데이트 진행 중 또는 중단 점검 필요');
      store.put('project-maintenance', { id: project.id, active: true, batchId: batch.id, pid: process.pid, host: hostname(), childPid: null }, old?.revision ?? 0);
    });
  }
  function release(id) {
    const record = store.need('project-maintenance', id);
    store.put('project-maintenance', { ...record, active: false }, record.revision);
  }
  async function execute(batch, source) {
    let changed = false;
    try {
      if (source) {
        batch.preparation = { phase: 'clone', state: 'running', steps: [] }; save(batch);
        const built = await sourceBuilder.prepare(source, { stopped: () => stopped, progress: progress => {
          if (progress.commit) batch.source.commit = progress.commit;
          if (progress.buildRoot) batch.source.buildRoot = progress.buildRoot;
          batch.preparation = { ...batch.preparation, ...progress, steps: batch.preparation.steps.filter(s => s.phase !== progress.phase).concat(progress) };
          save(batch);
        } });
        const installed = await target(built.cli);
        requireThat(installed.packageId, 'invalid-package', '검증된 빌드가 패키지 릴리스로 인식되지 않습니다. 프로젝트에 적용하지 않았습니다.');
        batch.target = installed;
        batch.source = { ...batch.source, commit: built.commit, buildRoot: built.buildRoot };
        batch.preparation = { ...batch.preparation, phase: 'validate', state: 'completed', steps: batch.preparation.steps.filter(s => s.phase !== 'validate').concat({ phase: 'validate', state: 'completed' }) };
        save(batch);
      }
      for (const row of batch.projects) {
        if (row.state !== 'ready') continue;
        if (stopped || changed) { row.state = 'cancelled'; row.detail = stopped ? '서버 종료로 미실행' : '적용 중 설치본이 변경되어 중단'; save(batch); continue; }
        let claimed = false, uncertain = false;
        try {
          changed = installationFingerprint(batch.target.cli) !== batch.target.fingerprint;
          requireThat(!changed, 'stale-state', '설치본이 변경되었습니다. 다시 조회하세요.');
          const project = store.need('project', row.id);
          requireThat(project.revision === row.revision && project.path === row.path, 'stale-state', '프로젝트 정보가 바뀌었습니다. 다시 조회하세요.');
          const checked = await inspect(project, batch.target);
          if (checked.state !== 'ready') { Object.assign(row, checked); save(batch); continue; }
          claim(project, batch); claimed = true;
          row.state = 'running'; row.detail = '적용 중'; save(batch);
          const result = await run(batch.target.cli, batch.target.args, row.path, childPid => {
            const record = store.need('project-maintenance', row.id);
            store.put('project-maintenance', { ...record, childPid }, record.revision);
          });
          uncertain = Boolean(result.uncertain);
          row.output = clip(`${result.stdout ?? ''}\n${result.stderr ?? ''}`);
          requireThat(!uncertain, 'update-uncertain', '적용 프로세스 종료를 확인하지 못했습니다. 중단 점검이 필요합니다.');
          if (result.code === 3) { row.state = 'skipped'; row.detail = 'code-agent가 적용을 보류했습니다. 작업·승인·적용 대기를 확인하세요.'; continue; }
          requireThat(result.code === 0, 'update-failed', `적용 실패 (종료 코드 ${result.code}). 출력과 프로젝트 상태를 확인하세요.`);
          const after = await version(batch.target.cli, row.path);
          changed = installationFingerprint(batch.target.cli) !== batch.target.fingerprint;
          requireThat(!changed && !after.project.pending && (batch.target.packageId ? after.project.applied === batch.target.packageId :
            after.project.applied === null && after.running.kind === 'bundle' && after.running.version === batch.target.version),
          'update-failed', '적용 후 목표 버전 일치를 확인하지 못했습니다. 프로젝트 상태를 확인하세요.');
          row.current = after.project.applied ?? `번들 ${after.running.version}`;
          row.state = /!!/.test(row.output) ? 'needs-attention' : 'completed';
          row.detail = row.state === 'completed' ? '적용 및 버전 확인 완료' : '적용 완료 · 출력의 템플릿 충돌·호스트 재시작 안내를 확인하세요.';
        } catch (error) { row.state = uncertain ? 'interrupted' : error.code === 'project-busy' ? 'skipped' : 'failed'; row.detail = error.message; }
        finally { if (claimed && !uncertain) release(row.id); save(batch); }
      }
    } catch (error) {
      batch.error = clip(error.message);
      if (batch.preparation && batch.preparation.state !== 'completed') batch.preparation = { ...batch.preparation, state: 'failed' };
      for (const row of batch.projects) {
        if (row.state === 'ready') { row.state = 'cancelled'; row.detail = '새 버전 준비 또는 일괄 실행 실패로 미적용'; }
        else if (row.state === 'running') { row.state = 'interrupted'; row.detail = '적용 중 실행이 중단되었습니다. 프로젝트 상태를 점검하세요.'; }
      }
    } finally {
      batch.state = batch.error ? 'failed' : batch.projects.every(row => row.state === 'completed') ? 'completed' : 'needs-attention';
      save(batch);
    }
  }
  function apply(id) {
    requireThat(typeof id === 'string' && id.length > 0, 'invalid-input', '미리보기 ID가 필요합니다.');
    const existing = store.get('agent-update', id);
    if (existing) return existing;
    requireThat(!stopped && !pending && !store.list('agent-update').some(b => b.state === 'running' && !abandoned(b)), 'request-busy', '다른 일괄 업데이트가 진행 중입니다.');
    const { plan, source } = plans.get(id) ?? {};
    requireThat(plan && Date.now() - Date.parse(plan.createdAt) < 15 * 60000 && plan.scopeHash === scope(), 'stale-state', '미리보기가 만료되거나 프로젝트 목록이 바뀌었습니다. 다시 조회하세요.');
    requireThat(installationFingerprint(plan.target.cli) === plan.target.fingerprint, 'stale-state', '설치본이 변경되었습니다. 다시 조회하세요.');
    const batch = structuredClone(plan);
    Object.assign(batch, { state: 'running', updatedAt: now(), pid: process.pid, host: hostname() });
    store.transaction(() => {
      requireThat(!store.list('agent-update').some(b => b.state === 'running' && !abandoned(b)), 'request-busy', '다른 일괄 업데이트가 진행 중입니다.');
      store.put('agent-update', batch);
    });
    pending = execute(batch, source).finally(() => { pending = null; });
    return store.need('agent-update', id);
  }
  async function recover(id) {
    requireThat(typeof id === 'string' && id.length > 0, 'invalid-input', '프로젝트 ID가 필요합니다.');
    const record = store.need('project-maintenance', id);
    requireThat(record.active && record.host === hostname() && (!alive(record.pid) || record.pid === process.pid && !pending) && !alive(record.childPid),
      'request-busy', '업데이트 프로세스가 아직 실행 중이거나 다른 PC의 기록입니다.');
    const project = store.need('project', id), view = await version(findCodeAgent(cliPath), project.path);
    requireThat(!view.project.busy.length && !existsSync(join(project.path, '.code-agent/runtime.lock')), 'project-busy', 'code-agent 작업 또는 실행 잠금이 남아 있습니다. 터미널에서 먼저 점검하세요.');
    store.transaction(() => {
      requireThat(store.need('project-maintenance', id).revision === record.revision, 'stale-state', '점검 중 상태가 변경되었습니다.');
      release(id);
    });
    return { id, state: 'released', detail: '실행 종료와 유휴 상태를 확인했습니다. 적용 결과는 자동으로 성공 처리하지 않습니다. 다시 조회 후 적용하세요.' };
  }
  function snapshot() {
    return { batches: store.list('agent-update').sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 5).map(b => {
      const interrupted = b.state === 'running' && abandoned(b);
      return { ...b, state: interrupted ? 'interrupted' : b.state, projects: b.projects.map(p => interrupted && ['running', 'ready'].includes(p.state) ? { ...p, state: 'interrupted', detail: '서버 중단 · 자동 재실행하지 않음' } : p) };
    }), maintenance: store.list('project-maintenance').filter(r => r.active).map(r => ({ id: r.id, batchId: r.batchId,
      recoverable: r.host === hostname() && (!alive(r.pid) || r.pid === process.pid && !pending) && !alive(r.childPid) })) };
  }
  return { preview, apply, recover, snapshot, async idle() { await pending; }, async stop() { stopped = true; await pending; } };
}
