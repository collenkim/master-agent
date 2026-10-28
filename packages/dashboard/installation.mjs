import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { watch } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { hash, requireThat } from '../domain/contracts.mjs';
import { spawnArgs } from '../runner/process.mjs';

const cache = new Map();
const byteLimit = 256 * 1024 * 1024;
const roots = cli => spawnArgs(cli).prefix.length > 0 ? ['package.json', 'dist', 'template'].map(name => join(resolve(cli, '../../..'), name)) : [resolve(cli)];
const signature = stat => [String(stat.size), String(stat.mtimeNs), String(stat.ctimeNs), String(stat.ino)];

async function inventory(cli) {
  const files = []; let bytes = 0;
  async function walk(path) {
    const stat = await fs.lstat(path, { bigint: true });
    requireThat(!stat.isSymbolicLink(), 'invalid-cli', '설치 파일의 심볼릭 링크는 일괄 업데이트에서 지원하지 않습니다.');
    if (stat.isDirectory()) { for (const name of (await fs.readdir(path)).sort()) await walk(join(path, name)); return; }
    requireThat(stat.isFile() && files.length < 20000 && (bytes += Number(stat.size)) <= byteLimit, 'invalid-cli', '설치 파일 조회 한도를 초과했습니다.');
    files.push({ path, signature: signature(stat) });
  }
  for (const path of roots(cli)) await walk(path);
  return { files, key: hash(files) };
}

/** 메타데이터가 같은 설치본의 본문은 다시 읽지 않는다. */
export async function installationFingerprint(cliPath) {
  const cli = resolve(cliPath), before = await inventory(cli);
  if (cache.get(cli)?.key === before.key) return cache.get(cli).digest;
  if (spawnArgs(cli).prefix.length > 0) {
    let pkg;
    try { pkg = JSON.parse(await fs.readFile(roots(cli)[0], 'utf8')); } catch { requireThat(false, 'invalid-cli', 'code-agent 패키지 정보를 읽을 수 없습니다.'); }
    requireThat(pkg.name === 'code-agent', 'invalid-cli', 'code-agent 패키지 진입점이 필요합니다.');
  }
  const digest = createHash('sha256'); let bytes = 0;
  for (const file of before.files) {
    const handle = await fs.open(file.path, 'r');
    try {
      requireThat(hash(signature(await handle.stat({ bigint: true }))) === hash(file.signature), 'stale-state', '해시 계산 중 설치본이 변경되었습니다.');
      digest.update(file.path); digest.update('\0');
      for await (const chunk of handle.createReadStream({ autoClose: false })) {
        requireThat((bytes += chunk.length) <= byteLimit, 'invalid-cli', '설치 파일 조회 한도를 초과했습니다.');
        digest.update(chunk);
      }
      digest.update('\0');
    } finally { await handle.close(); }
  }
  requireThat((await inventory(cli)).key === before.key, 'stale-state', '해시 계산 중 설치본이 변경되었습니다.');
  const result = digest.digest('hex');
  cache.set(cli, { key: before.key, digest: result });
  while (cache.size > 16) cache.delete(cache.keys().next().value);
  return result;
}

/** 적용 중 변경 신호는 후속 프로젝트 실행을 멈춘다. 최종 해시 대조도 수행한다. */
export function watchInstallation(cliPath) {
  const cli = resolve(cliPath), watchers = []; let changed = false;
  function add(path, recursive, accepted = () => true) {
    const watcher = watch(path, { recursive, persistent: false }, (_, name) => { if (!name || accepted(String(name))) changed = true; });
    watcher.on('error', () => { changed = true; });
    watchers.push(watcher);
  }
  const close = () => { for (const watcher of watchers) watcher.close(); };
  try {
    if (spawnArgs(cli).prefix.length > 0) {
      const root = resolve(cli, '../../..');
      add(dirname(root), false, name => name === basename(root));
      add(root, false, name => ['package.json', 'dist', 'template'].includes(name));
      for (const name of ['dist', 'template']) add(join(root, name), true);
    } else add(dirname(cli), false, name => name === basename(cli));
  } catch { close(); requireThat(false, 'invalid-cli', '설치본 변경 감시를 시작할 수 없습니다. 설치 경로를 확인하세요.'); }
  return { get changed() { return changed; }, close };
}
