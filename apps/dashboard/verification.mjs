const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const lines = value => value.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
let setup;
const root = () => document.getElementById('interaction-verification');
function checkMarkup(task, check = {}, index = 0) {
  return `<fieldset data-verification-check><legend>검증 ${index + 1}</legend>
    <label>실행 파일 절대 경로<input data-executable required value="${esc(check.executable)}" placeholder="예: C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"></label>
    <label>실행 인자 (한 줄에 하나)<textarea data-args rows="5">${esc((check.args ?? []).join('\n'))}</textarea></label>
    <label>제한 시간 (초)<input data-timeout type="number" min="1" max="3600" required value="${(check.timeoutMs ?? 600000) / 1000}"></label>
    <p>이 명령으로 확인할 완료 조건</p>${task.criteria.map(c => `<label class="interaction-option"><input data-criterion type="checkbox" value="${esc(c.id)}" ${(check.criterionIds ?? task.criteria.map(c => c.id)).includes(c.id) ? 'checked' : ''}>${esc(c.description)}</label>`).join('')}
    <button type="button" data-remove-check>이 검증 삭제</button></fieldset>`;
}
export function renderVerification(value, draft, onChange) {
  setup = value;
  const container = root(); container.hidden = !value;
  container.innerHTML = value ? `<p>각 명령은 해당 프로젝트 폴더에서 실행됩니다. 추천 명령도 실제 완료 조건을 검사하는지 확인하세요. 후행 작업이 만들어야 할 테스트를 선행 작업의 필수 검사로 지정하면 진행할 수 없습니다.</p>` + value.tasks.map((task, index) => {
    const recipe = draft?.find(r => r.taskId === task.id), recommended = task.presets.find(p => p.recommended);
    const checks = recipe?.checks ?? [recommended ?? {}];
    return `<fieldset data-verification-task="${index}"><legend>${esc(task.id)} · ${esc(task.projectName)}</legend>
      ${recommended ? `<div data-verification-recommendation><h3>추천안 · ${esc(recommended.label)}</h3><p>${esc(recommended.reason)}</p><code>${esc(recommended.command)}</code><p class="muted">${recipe ? '저장한 입력을 유지합니다.' : '아래 검증 명령에 추천안을 미리 채웠습니다.'} 확인 후 등록할 수 있으며 자동 실행하지 않습니다.</p></div>` : ''}
      <p>${esc(task.goal)}</p><p class="muted">선행 작업: ${esc(task.dependsOn.join(', ') || '없음')} · 계획의 검증 설명: ${esc(task.verification)}</p>
      <label>변경을 허용할 파일 (한 줄에 하나)<textarea data-paths rows="4">${esc((recipe?.allowedPaths ?? task.allowedPaths).join('\n'))}</textarea></label>
      <label class="interaction-option"><input data-work-records type="checkbox" ${recipe?.codeAgentRecords ? 'checked' : ''}>이 작업의 code-agent 작업 문서·승인 기록 변경도 허용합니다. 다른 작업의 기록이나 제품 파일은 포함하지 않습니다.</label>
      <div data-checks>${checks.map((c, i) => checkMarkup(task, c, i)).join('')}</div>
      <label>검증 추가<select data-preset><option value="">직접 지정</option>${task.presets.map((p, i) => `<option value="${i}">${esc(p.label)}${p.recommended ? ' (추천)' : ''}</option>`).join('')}</select></label><button type="button" data-add-check>선택한 검증 추가</button>
      <p>산출물 확인 방법 — 검증 출력에는 위 검증 번호를 입력하세요.</p>
      ${task.outputs.map(name => { const a = recipe?.artifacts.find(a => a.name === name); return `<label data-artifact="${esc(name)}">${esc(name)}<select data-artifact-kind><option value="checkId" ${a?.path ? '' : 'selected'}>검증 출력</option><option value="path" ${a?.path ? 'selected' : ''}>프로젝트 내 파일</option></select><input data-artifact-value required value="${esc(a?.path ?? a?.checkId?.replace('check-', '') ?? '')}" placeholder="검증 번호 또는 파일 상대 경로"></label>`; }).join('')}
      </fieldset>`;
  }).join('') + '<label class="interaction-option"><input id="verification-reviewed" type="checkbox">검증 명령·변경 파일·완료 조건·산출물을 확인했으며 이 계약의 등록과 기존 요청 재개를 승인합니다.</label>' : '';
  container.oninput = event => { const reviewed = document.getElementById('verification-reviewed'); if (reviewed && event.target !== reviewed) reviewed.checked = false; onChange(); };
  container.onchange = event => { if (event.target.id === 'verification-reviewed') onChange(); };
  container.onclick = event => {
    const section = event.target.closest('[data-verification-task]'); if (!section) return;
    const task = value.tasks[Number(section.dataset.verificationTask)];
    if (event.target.matches('[data-add-check]')) {
      const selected = section.querySelector('[data-preset]').value, preset = selected === '' ? {} : task.presets[Number(selected)];
      const checks = section.querySelector('[data-checks]');
      // Replace the initial empty row when a preset is selected.
      if (selected !== '' && checks.children.length === 1 && !checks.querySelector('[data-executable]').value && !checks.querySelector('[data-args]').value) checks.innerHTML = '';
      checks.insertAdjacentHTML('beforeend', checkMarkup(task, preset, checks.children.length));
    } else if (event.target.matches('[data-remove-check]')) {
      event.target.closest('[data-verification-check]').remove();
      section.querySelectorAll('[data-verification-check] legend').forEach((el, i) => { el.textContent = `검증 ${i + 1}`; });
      // Number references must be reconfirmed after removing a check.
      section.querySelectorAll('[data-artifact]').forEach(el => { if (el.querySelector('select').value === 'checkId') el.querySelector('input').value = ''; });
    } else return;
    document.getElementById('verification-reviewed').checked = false; onChange();
  };
}
export function verificationRecipes() {
  if (!setup) return [];
  return [...root().querySelectorAll('[data-verification-task]')].map(section => {
    const task = setup.tasks[Number(section.dataset.verificationTask)];
    return { schemaVersion: 1, taskId: task.id, allowedPaths: lines(section.querySelector('[data-paths]').value),
      codeAgentRecords: section.querySelector('[data-work-records]').checked,
      checks: [...section.querySelectorAll('[data-verification-check]')].map((row, i) => ({ id: `check-${i + 1}`,
        executable: row.querySelector('[data-executable]').value.trim(), args: row.querySelector('[data-args]').value.split(/\r?\n/).filter(s => s.length),
        timeoutMs: Number(row.querySelector('[data-timeout]').value) * 1000,
        criterionIds: [...row.querySelectorAll('[data-criterion]:checked')].map(el => el.value) })),
      artifacts: [...section.querySelectorAll('[data-artifact]')].map(row => {
        const kind = row.querySelector('select').value, value = row.querySelector('input').value.trim();
        return { name: row.dataset.artifact, [kind]: kind === 'checkId' ? `check-${value}` : value };
      }) };
  });
}
export const verificationReviewed = () => document.getElementById('verification-reviewed')?.checked === true;
