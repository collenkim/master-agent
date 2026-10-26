export const EVENT_RETENTION_DAYS = 30;
export const terminalMission = mission => ['succeeded', 'cancelled', 'simulation-complete'].includes(mission?.state);

export function closedMissionThread(store, thread) {
  const match = /^master:v1:(?:mission|simulation):(.+)$/.exec(thread ?? '');
  return Boolean(match && terminalMission(store.get('mission', match[1])));
}

export function clearMissionCheckpoints(store, mission) {
  if (!store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='checkpoints'").get()) return;
  const threads = [`master:v1:mission:${mission.id}`, `master:v1:simulation:${mission.id}`];
  // SqliteSaver의 기본 JsonPlusSerializer가 저장한 최상위 시각만 읽는다.
  const last = store.db.prepare(`SELECT checkpoint_id AS id,
    CASE WHEN type='json' THEN json_extract(CAST(checkpoint AS TEXT),'$.ts') END AS at
    FROM checkpoints WHERE thread_id IN (?,?) ORDER BY checkpoint_id DESC LIMIT 1`).get(...threads);
  if (last) mission.lastCheckpoint = { id: last.id, at: last.at };
  store.db.prepare('DELETE FROM checkpoints WHERE thread_id IN (?,?)').run(...threads);
  store.db.prepare('DELETE FROM writes WHERE thread_id IN (?,?)').run(...threads);
}
