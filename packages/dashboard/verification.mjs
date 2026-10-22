import { statSync } from 'node:fs';
import { join } from 'node:path';
import { VerificationTemplates } from '../verification/templates.mjs';
import { LiveVerification } from '../verification/live-verification.mjs';
import { requireThat } from '../domain/contracts.mjs';

const file = path => { try { return statSync(path).isFile(); } catch { return false; } };

/** Detect project-owned Gradle launchers without running build scripts or querying tasks. */
export function gradlePresets(projectPath, verification = '') {
  const windows = process.platform === 'win32';
  const build = ['build.gradle.kts', 'build.gradle', 'settings.gradle.kts', 'settings.gradle'].find(name => file(join(projectPath, name)));
  const script = windows ? 'scripts/gradle.ps1' : 'scripts/gradle.sh', wrapper = windows ? 'gradlew.bat' : 'gradlew';
  const launcher = [script, wrapper].find(name => file(join(projectPath, name)));
  if (!build && !launcher) return [];
  const executable = windows ? join(process.env.SystemRoot ?? 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe') : '/bin/sh';
  const runnable = launcher && file(executable);
  const names = ['test', ...['spotbugsMain', 'compileJava'].filter(name => new RegExp(`\\b${name}\\b`).test(verification))];
  return names.map(name => ({ label: `Gradle ${name}`, recommended: name === 'test',
    reason: `${[build, launcher].filter(Boolean).join(' · ')}에서 Gradle 구성을 확인했습니다. ${name === 'test'
      ? '프로젝트의 테스트를 실행하는 test를 기본 검증으로 추천합니다.' : '계획의 검증 설명에 지정된 추가 검사입니다.'}${runnable ? '' : ' 실행 가능한 Gradle Wrapper를 찾지 못했습니다. 실행 파일과 인자를 지정하세요.'}`,
    command: `${launcher ?? 'gradle'} ${name}`, executable: runnable ? executable : '',
    args: !runnable ? [] : !windows ? [launcher, name] : launcher === script
      ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, name]
      : ['-NoProfile', '-Command', `$ErrorActionPreference = 'Stop'; & '.\\gradlew.bat' ${name}; exit $LASTEXITCODE`] }));
}

/** Suggestions are only editable drafts. Registration requires an explicit reviewed submission. */
export function verificationSetup(store, m) {
  if (m.mode !== 'live' || m.planningHold || !m.plans.length) return null;
  const templates = new VerificationTemplates(store);
  const tasks = m.plans.at(-1).proposal.tasks.filter(t => m.tasks.find(s => s.id === t.id)?.state === 'queued' &&
    !m.verificationRecipes?.[t.id] && templates.candidates(m, t).length !== 1).map(task => {
    const project = store.need('project', task.projectId), presets = gradlePresets(project.path, task.verification);
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
