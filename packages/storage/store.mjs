import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { requireThat, now } from '../domain/contracts.mjs';

const migrations = [
  db => db.exec(`
    CREATE TABLE records (kind TEXT NOT NULL, id TEXT NOT NULL, revision INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(kind,id));
    CREATE TABLE events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, mission_id TEXT NOT NULL, type TEXT NOT NULL, at TEXT NOT NULL, body TEXT NOT NULL);
    CREATE TABLE locks (project_id TEXT PRIMARY KEY, mission_id TEXT NOT NULL, attempt_id TEXT NOT NULL);
    CREATE TABLE requests (key TEXT PRIMARY KEY, hash TEXT NOT NULL, mission_id TEXT NOT NULL);
    CREATE TABLE paths (path TEXT PRIMARY KEY, project_id TEXT NOT NULL UNIQUE);
  `),
  db => db.exec(`
    CREATE TABLE IF NOT EXISTS graph_leases (thread_id TEXT PRIMARY KEY, owner TEXT NOT NULL, pid INTEGER NOT NULL, host TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS graph_runs (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, graph TEXT NOT NULL, status TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT, error TEXT);
    ALTER TABLE graph_leases ADD COLUMN started_at TEXT;
    ALTER TABLE graph_leases ADD COLUMN heartbeat_at TEXT;
    UPDATE graph_leases SET started_at=COALESCE((SELECT started_at FROM graph_runs WHERE id=owner),'1970-01-01T00:00:00.000Z');
    UPDATE graph_leases SET heartbeat_at=started_at;
    ALTER TABLE records ADD COLUMN mission_id TEXT GENERATED ALWAYS AS (json_extract(body,'$.missionId')) VIRTUAL;
    CREATE INDEX records_mission ON records(kind,mission_id);
    CREATE INDEX events_mission ON events(mission_id,sequence);
    CREATE INDEX graph_runs_thread ON graph_runs(thread_id);
  `),
];

/** 트랜잭션에는 동기 DB 작업만 넣는다. 모델·프로세스 호출은 커밋 이후에 수행한다. */
export class Store {
  constructor(path) {
    if (path !== ':memory:') mkdirSync(dirname(resolve(path)), { recursive: true });
    this.db = new DatabaseSync(path);
    try {
      // drive 가 실행을 따라가는 동안 다른 CLI(정지·답 전달·조회)가 같은 DB 를 쓴다 — 잠금이 풀릴 때까지 잠시 기다린다
      this.db.exec('PRAGMA busy_timeout = 5000');
      let version = this.db.prepare('PRAGMA user_version').get().user_version;
      requireThat(version >= 0 && version <= migrations.length, 'unsupported-version', `저장소 버전 ${version}은 지원하지 않습니다.`);
      if (version < migrations.length) {
        this.transaction(() => {
          version = this.db.prepare('PRAGMA user_version').get().user_version;
          requireThat(version <= migrations.length, 'unsupported-version', `저장소 버전 ${version}은 지원하지 않습니다.`);
          if (version === 0) {
            const tables = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
            requireThat(!tables.length, 'unknown-database', '기존 데이터베이스를 새 저장소로 초기화하지 않습니다.');
          }
          while (version < migrations.length) {
            migrations[version](this.db);
            this.db.exec(`PRAGMA user_version=${++version}`);
          }
        });
      }
      // 동일 버전이라도 손상/누락된 테이블은 새 상태로 만들지 않는다.
      for (const name of ['records', 'events', 'locks', 'requests', 'paths', 'graph_leases', 'graph_runs']) this.db.prepare(`SELECT * FROM ${name} LIMIT 0`).all();
    } catch (error) { this.db.close(); throw error; }
  }
  close() { this.db.close(); }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      requireThat(!result?.then, 'async-transaction', '트랜잭션 안에서 비동기 실행할 수 없습니다.');
      this.db.exec('COMMIT'); return result;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  get(kind, id) {
    const row = this.db.prepare('SELECT body, revision FROM records WHERE kind=? AND id=?').get(kind, id);
    if (!row) return undefined;
    return { ...JSON.parse(row.body), revision: row.revision };
  }
  need(kind, id) { const item = this.get(kind, id); requireThat(item, 'not-found', `${kind} ${id}를 찾을 수 없습니다.`); return item; }
  list(kind) { return this.db.prepare('SELECT id FROM records WHERE kind=? ORDER BY id').all(kind).map(row => this.get(kind, row.id)); }
  put(kind, value, expected = 0) {
    const body = { ...value }; delete body.revision;
    if (expected === 0) {
      requireThat(!this.get(kind, value.id), 'already-exists', `${kind} ${value.id}가 이미 있습니다.`);
      this.db.prepare('INSERT INTO records(kind,id,revision,body) VALUES (?,?,1,?)').run(kind, value.id, JSON.stringify(body));
    } else {
      const result = this.db.prepare('UPDATE records SET revision=revision+1, body=? WHERE kind=? AND id=? AND revision=?').run(JSON.stringify(body), kind, value.id, expected);
      requireThat(result.changes === 1, 'stale-state', '상태가 변경되었습니다. 다시 조회하세요.');
    }
    return this.need(kind, value.id);
  }
  event(missionId, type, body) {
    this.db.prepare('INSERT INTO events(mission_id,type,at,body) VALUES (?,?,?,?)').run(missionId, type, now(), JSON.stringify(body));
  }
  events(id) { return this.db.prepare('SELECT * FROM events WHERE mission_id=? ORDER BY sequence').all(id).map(e => ({ sequence: e.sequence, type: e.type, at: e.at, ...JSON.parse(e.body) })); }
  lock(projectId) { return this.db.prepare('SELECT * FROM locks WHERE project_id=?').get(projectId); }
  acquire(projectId, missionId, attemptId) {
    requireThat(!this.get('project', projectId)?.deletedAt, 'not-found', `프로젝트 ${projectId}는 등록 해제되었습니다.`);
    requireThat(!this.get('project-maintenance', projectId)?.active, 'project-busy', `프로젝트 ${projectId}의 code-agent 업데이트가 진행 중이거나 중단 점검이 필요합니다.`);
    requireThat(!this.lock(projectId), 'project-busy', `프로젝트 ${projectId}에 실행 중이거나 확인되지 않은 작업이 있습니다.`);
    this.db.prepare('INSERT INTO locks VALUES (?,?,?)').run(projectId, missionId, attemptId);
  }
  release(projectId, attemptId) { this.db.prepare('DELETE FROM locks WHERE project_id=? AND attempt_id=?').run(projectId, attemptId); }
}
