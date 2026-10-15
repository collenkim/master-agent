import { snapshotTree } from '../verification/tree.mjs';
import { requireThat } from '../domain/contracts.mjs';

export function assertReplanTrees(store, mission) {
  if (!mission.replanPending) return;
  for (const [id, tree] of Object.entries(mission.replanContext.trees)) {
    const current = snapshotTree(store.need('project', id).path);
    requireThat(current.digest === tree.digest && current.head === tree.head, 'stale-replan', '재계획 인계 이후 파일 또는 HEAD가 변경됐습니다.');
    requireThat(!store.lock(id), 'project-busy', '재계획 대상에 다른 실행 소유권이 있습니다.');
  }
}

