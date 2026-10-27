import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** 진단은 로컬 로그에만 남긴다. 저장소 레코드와 모델 입력에는 원문을 전달하지 않는다. */
export function logHostError(store, missionId, error, fallback = 'host-error') {
  const code = String(error?.code ?? fallback), first = String(error?.stack ?? error?.name ?? 'Error').split(/\r?\n/)[0];
  const line = `[${code}] ${first}`;
  console.error(line);
  try {
    if (!/^[0-9a-f-]{36}$/i.test(missionId)) return;
    const file = store.db.prepare('PRAGMA database_list').all().find(row => row.name === 'main')?.file;
    if (!file) return;
    const directory = join(dirname(file), 'request-logs');
    mkdirSync(directory, { recursive: true });
    appendFileSync(join(directory, `${missionId}.log`), line + '\n');
  } catch (diagnosticError) { console.error('request-log-failed', diagnosticError?.code ?? 'internal-error'); }
}
