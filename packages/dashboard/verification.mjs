import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { VerificationTemplates } from '../verification/templates.mjs';
import { LiveVerification } from '../verification/live-verification.mjs';
import { requireThat } from '../domain/contracts.mjs';

/** Suggestions are only editable drafts. Registration requires an explicit reviewed submission. */
export function verificationSetup(store, m) {
  if (m.mode !== 'live' || m.planningHold || !m.plans.length) return null;
  const templates = new VerificationTemplates(store);
  const tasks = m.plans.at(-1).proposal.tasks.filter(t => m.tasks.find(s => s.id === t.id)?.state === 'queued' &&
    !m.verificationRecipes?.[t.id] && templates.candidates(m, t).length !== 1).map(task => {
    const project = store.need('project', task.projectId), presets = [];
    const powershell = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe') : null;
    if (powershell && existsSync(powershell) && existsSync(join(project.path, 'scripts/gradle.ps1'))) {
      for (const name of ['test', 'spotbugsMain', 'compileJava']) presets.push({ label: `Gradle ${name}`, executable: powershell,
        args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'scripts/gradle.ps1', name] });
    }
    return { id: task.id, projectId: task.projectId, projectName: project.name, goal: task.goal, verification: task.verification,
      dependsOn: task.dependsOn, allowedPaths: task.allowedChanges, outputs: task.outputs,
      criteria: task.criteria.map(id => m.criteria.find(c => c.id === id)), presets };
  });
  return tasks.length ? { planVersion: m.plans.at(-1).version, tasks } : null;
}

export function configureVerification(store, item, input) {
  requireThat(input.reviewed === true && input.resume === true, 'invalid-input', '검증 명령·파일 범위·산출물을 확인한 뒤 등록·재개하세요.');
  const m = store.need('mission', item.missionId), setup = verificationSetup(store, m);
  requireThat(m.revision === item.context.missionRevision && setup && setup.planVersion === item.verificationSetup.planVersion, 'stale-question', '검증할 계획이 변경됐습니다. 다시 열어 확인하세요.');
  const ids = setup.tasks.map(t => t.id);
  requireThat(Array.isArray(input.recipes) && input.recipes.length === ids.length && new Set(input.recipes.map(r => r?.taskId)).size === ids.length &&
    input.recipes.every(r => ids.includes(r?.taskId)), 'invalid-input', '표시된 모든 작업의 검증 계약을 지정하세요.');
  const verification = new LiveVerification(store);
  for (const recipe of input.recipes) {
    const task = setup.tasks.find(t => t.id === recipe.taskId);
    requireThat(Array.isArray(recipe.allowedPaths) && task.allowedPaths.every(p => recipe.allowedPaths.includes(p)), 'invalid-recipe', `${task.id}: 계획의 변경 파일을 모두 포함하세요.`);
    verification.configure(m.id, recipe, store.need('mission', m.id).revision, undefined, { inTransaction: true });
  }
}
