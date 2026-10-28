import { esc, $ } from './common.mjs';
const lines = value => value.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
let setup;
const root = () => $('interaction-verification');
const presetIndex = (task, check) => task.presets.findIndex(p => p.executable === check.executable && JSON.stringify(p.args) === JSON.stringify(check.args));
const checkLabel = (task, check, index) => task.presets[presetIndex(task, check)]?.label ?? `직접 지정한 검사 ${index + 1}`;
function readCheck(row) {
  return { id: row.dataset.checkId, executable: row.querySelector('[data-executable]').value.trim(),
    args: row.querySelector('[data-args]').value.split(/\r?\n/).filter(s => s.length),
    timeoutMs: Number(row.querySelector('[data-timeout]').value) * 1000,
    criterionIds: [...row.querySelectorAll('[data-criterion]:checked')].map(el => el.value) };
}
const readChecks = section => [...section.querySelectorAll('[data-verification-check]')].map(readCheck);
function nextCheckId(section) {
  const next = Number(section.dataset.nextCheck ?? 1); section.dataset.nextCheck = next + 1; return `check-${next}`;
}
function checkMarkup(task, check = {}, index = 0) {
  const selected = presetIndex(task, check);
  return `<fieldset data-verification-check data-check-id="${esc(check.id ?? `check-${index + 1}`)}"><legend>검증 방법</legend>
    <label>실행할 검사<select data-check-preset>${task.presets.map((p, i) => `<option value="${i}" ${i === selected ? 'selected' : ''}>${esc(p.label)}${p.recommended ? ' (추천)' : ''}</option>`).join('')}<option value="custom" ${selected < 0 ? 'selected' : ''}>직접 지정</option></select></label>
    <details data-check-details ${selected < 0 || !check.executable ? 'open' : ''}><summary>명령·시간 제한·완료 조건 직접 수정</summary><div class="verification-fields">
    <label>실행 파일 절대 경로<input data-executable required value="${esc(check.executable)}" placeholder="예: C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"></label>
    <label>실행 인자 (한 줄에 하나)<textarea data-args rows="5">${esc((check.args ?? []).join('\n'))}</textarea></label>
    <label>제한 시간 (초)<input data-timeout type="number" min="1" max="3600" required value="${(check.timeoutMs ?? 600000) / 1000}"></label>
    <p>이 명령으로 확인할 완료 조건</p>${task.criteria.map(c => `<label class="interaction-option"><input data-criterion type="checkbox" value="${esc(c.id)}" ${(check.criterionIds ?? task.criteria.map(c => c.id)).includes(c.id) ? 'checked' : ''}>${esc(c.description)}</label>`).join('')}
    </div></details><button type="button" data-remove-check>이 검증 삭제</button></fieldset>`;
}
function artifactOptions(task, checks, current) {
  const files = [...new Set([...task.allowedPaths, ...(task.artifactSuggestions ?? []).map(a => a.path).filter(Boolean),
    ...(current.startsWith('file:') ? [current.slice(5)] : [])])].filter(p => !/[*?]/.test(p));
  const options = [['', '확인 방법을 선택하세요'], ...checks.map((c, i) => [`check:${c.id}`, `${checkLabel(task, c, i)} 실행 결과`]),
    ...task.presets.flatMap((p, i) => checks.some(c => presetIndex(task, c) === i) ? [] : [[`add:${i}`, `${p.label} 추가 후 실행 결과`]]),
    ...files.map(p => [`file:${p}`, `파일 확인 · ${p}`]), ['custom', '다른 파일 직접 지정']];
  return options.map(([value, label]) => `<option value="${esc(value)}" ${value === current ? 'selected' : ''}>${esc(label)}</option>`).join('');
}
function toggleArtifactInput(row) {
  const custom = row.querySelector('[data-artifact-selection]').value === 'custom';
  row.querySelector('[data-artifact-custom-label]').hidden = !custom; row.querySelector('[data-artifact-custom]').required = custom;
}
function syncArtifacts(section, task) {
  const checks = readChecks(section);
  section.querySelectorAll('[data-artifact]').forEach(row => {
    const select = row.querySelector('[data-artifact-selection]'), current = select.value;
    select.innerHTML = artifactOptions(task, checks, current);
    // A removed check must be selected again; never silently rebind its output to another command.
    select.value = [...select.options].some(o => o.value === current) ? current : '';
    toggleArtifactInput(row);
  });
}
function artifactMarkup(task, checks, name, saved) {
  const hint = (task.artifactSuggestions ?? []).find(a => a.name === name);
  const matching = hint?.presetLabel && checks.find(c => task.presets[presetIndex(task, c)]?.label === hint.presetLabel);
  const selected = saved?.path ? `file:${saved.path}` : saved?.checkId ? `check:${saved.checkId}` : hint?.path ? `file:${hint.path}` :
    (matching ?? checks[0]) ? `check:${(matching ?? checks[0]).id}` : '';
  return `<div data-artifact="${esc(name)}"><label>${esc(name)}<select data-artifact-selection required>${artifactOptions(task, checks, selected)}</select></label>
    <label data-artifact-custom-label hidden>다른 파일 경로<input data-artifact-custom placeholder="프로젝트 안의 파일 상대 경로"></label></div>`;
}
export function renderVerification(value, draft, onChange) {
  setup = value;
  const container = root(); container.hidden = !value;
  container.innerHTML = value ? `<p>실행할 검사와 산출물 확인 방법을 선택하세요. 계획에서 확인한 파일과 추천 검증을 미리 연결했습니다.</p>` + value.tasks.map((task, index) => {
    const recipe = draft?.find(r => r.taskId === task.id), recommended = task.presets.find(p => p.recommended);
    const proposed = task.presets.filter(p => p.recommended || (task.artifactSuggestions ?? []).some(a => a.presetLabel === p.label));
    const checks = (recipe?.checks ?? (proposed.length ? proposed : [{}])).map((c, i) => ({ ...c, id: c.id ?? `check-${i + 1}` }));
    const nextId = Math.max(0, ...checks.map(c => Number(c.id.replace(/^check-/, '')) || 0)) + 1;
    return `<fieldset data-verification-task="${index}" data-next-check="${nextId}"><legend>${esc(task.id)} · ${esc(task.projectName)}</legend>
      ${recommended ? `<div data-verification-recommendation><h3>추천안 · ${esc(recommended.label)}</h3><p>${esc(recommended.reason)}</p><p class="muted">${recipe ? '저장한 선택을 유지합니다.' : '추천 검증을 선택했습니다.'} 최종 확인 후 등록합니다.</p></div>` : ''}
      <details><summary>작업 내용·검증 계획 보기</summary><div class="verification-fields"><p>${esc(task.goal)}</p><p class="muted">선행 작업: ${esc(task.dependsOn.join(', ') || '없음')} · 계획의 검증 설명: ${esc(task.verification)}</p></div></details>
      <div data-checks>${checks.map((c, i) => checkMarkup(task, c, i)).join('')}</div>
      <details><summary>검증 추가</summary><div class="verification-fields"><label>추가할 검사<select data-preset>${task.presets.map((p, i) => `<option value="${i}">${esc(p.label)}</option>`).join('')}<option value="">직접 지정</option></select></label><button type="button" data-add-check>선택한 검증 추가</button></div></details>
      <h3>산출물 확인 방법</h3>
      ${task.outputs.map(name => artifactMarkup(task, checks, name, recipe?.artifacts?.find(a => a.name === name))).join('')}
      <details><summary>변경 파일 ${task.allowedPaths.length}개 확인·수정</summary><div class="verification-fields"><label>계획에서 가져온 변경 파일<textarea data-paths rows="4">${esc((recipe?.allowedPaths ?? task.allowedPaths).join('\n'))}</textarea></label></div></details>
      <label class="interaction-option"><input data-work-records type="checkbox" ${recipe?.codeAgentRecords ? 'checked' : ''}>이 작업의 code-agent 작업 문서·승인 기록 변경도 허용합니다.</label>
      </fieldset>`;
  }).join('') + '<label class="interaction-option"><input id="verification-reviewed" type="checkbox">검증 명령·변경 파일·완료 조건·산출물을 확인했으며 이 계약의 등록과 기존 요청 재개를 승인합니다.</label>' : '';
  const changed = () => { document.getElementById('verification-reviewed').checked = false; onChange(); };
  container.oninput = event => {
    // Selects are handled once in change, before a draft is saved.
    if (event.target.tagName === 'SELECT' || event.target.id === 'verification-reviewed') return;
    const section = event.target.closest('[data-verification-task]');
    if (section) {
      const task = value.tasks[Number(section.dataset.verificationTask)], check = event.target.closest('[data-verification-check]');
      if (check && event.target.matches('[data-executable], [data-args]')) {
        const index = presetIndex(task, readCheck(check)); check.querySelector('[data-check-preset]').value = index < 0 ? 'custom' : String(index);
      }
      if (event.target.matches('[data-executable], [data-args], [data-paths]')) syncArtifacts(section, task);
    }
    changed();
  };
  container.onchange = event => {
    if (event.target.id === 'verification-reviewed') { onChange(); return; }
    const section = event.target.closest('[data-verification-task]'); if (!section || event.target.tagName !== 'SELECT') return;
    const task = value.tasks[Number(section.dataset.verificationTask)];
    if (event.target.matches('[data-check-preset]')) {
      const row = event.target.closest('[data-verification-check]');
      if (event.target.value === 'custom') row.querySelector('[data-check-details]').open = true;
      else row.outerHTML = checkMarkup(task, { ...readCheck(row), ...task.presets[Number(event.target.value)] });
      syncArtifacts(section, task);
    } else if (event.target.matches('[data-artifact-selection]')) {
      if (event.target.value.startsWith('add:')) {
        const check = { ...task.presets[Number(event.target.value.slice(4))], id: nextCheckId(section) };
        section.querySelector('[data-checks]').insertAdjacentHTML('beforeend', checkMarkup(task, check));
        syncArtifacts(section, task); event.target.value = `check:${check.id}`;
      }
      toggleArtifactInput(event.target.closest('[data-artifact]'));
    }
    changed();
  };
  container.onclick = event => {
    const section = event.target.closest('[data-verification-task]'); if (!section) return;
    const task = value.tasks[Number(section.dataset.verificationTask)];
    if (event.target.matches('[data-add-check]')) {
      const selected = section.querySelector('[data-preset]').value, preset = selected === '' ? {} : task.presets[Number(selected)];
      const checks = section.querySelector('[data-checks]');
      // Replace the initial empty row when a preset is selected.
      if (selected !== '' && checks.children.length === 1 && !checks.querySelector('[data-executable]').value && !checks.querySelector('[data-args]').value) checks.innerHTML = '';
      checks.insertAdjacentHTML('beforeend', checkMarkup(task, { ...preset, id: nextCheckId(section) }, checks.children.length));
    } else if (event.target.matches('[data-remove-check]')) {
      event.target.closest('[data-verification-check]').remove();
    } else return;
    syncArtifacts(section, task); changed();
  };
}
export function verificationRecipes() {
  if (!setup) return [];
  return [...root().querySelectorAll('[data-verification-task]')].map(section => {
    const task = setup.tasks[Number(section.dataset.verificationTask)];
    return { schemaVersion: 1, taskId: task.id, allowedPaths: lines(section.querySelector('[data-paths]').value),
      codeAgentRecords: section.querySelector('[data-work-records]').checked,
      checks: readChecks(section),
      artifacts: [...section.querySelectorAll('[data-artifact]')].map(row => {
        const value = row.querySelector('[data-artifact-selection]').value;
        return { name: row.dataset.artifact, ...(value === 'custom' ? { path: row.querySelector('[data-artifact-custom]').value.trim() }
          : value.startsWith('file:') ? { path: value.slice(5) } : { checkId: value.startsWith('check:') ? value.slice(6) : '' }) };
      }) };
  });
}
export const verificationReviewed = () => document.getElementById('verification-reviewed')?.checked === true &&
  [...root().querySelectorAll('input, textarea, select')].every(el => el.validity.valid) &&
  verificationRecipes().every(recipe => recipe.checks.length > 0 && recipe.artifacts.every(a => a.path || recipe.checks.some(c => c.id === a.checkId)));
