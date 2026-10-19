import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openBrowser } from './browser.mjs';
import assert from 'node:assert/strict';

/** Actual dashboard clicks and HTTP/signature transport; caller supplies isolated test requests. */
export async function interactionBrowserCheck({ url, artifacts, questionId, approvalId }) {
  const browser = await openBrowser(url, artifacts);
  const { send, evaluate, waitFor, errors } = browser;
  try {
    await waitFor(`Boolean(document.querySelector('[data-interaction="${questionId}"]'))`);
    await evaluate(`document.querySelector('[data-interaction="${questionId}"]').click()`);
    assert.equal(await evaluate('document.querySelectorAll("#interaction-remote-questions [data-option]:checked").length'), 2);
    assert.equal(await evaluate('document.querySelector("[data-option-input]").required'), true);
    await evaluate(`document.querySelector('[data-option-input]').value='doc/architecture.md'; document.querySelector('[data-option-input]').dispatchEvent(new Event('input', {bubbles:true})); document.querySelector('[data-question-text]').value='브라우저에서 명시적으로 입력'; document.querySelector('[data-question-text]').dispatchEvent(new Event('input', {bubbles:true}));`);
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    assert.equal(await evaluate(`document.getElementById('interaction-dialog').scrollWidth <= document.getElementById('interaction-dialog').clientWidth`), true);
    writeFileSync(join(artifacts, 'live-mobile-multiple.png'), Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
    await evaluate(`document.getElementById('interaction-form').requestSubmit()`);
    await waitFor(`!document.getElementById('interaction-close').disabled && /접수|적용/.test(document.getElementById('interaction-error').textContent)`);
    await evaluate(`document.getElementById('interaction-close').click()`);
    await evaluate(`document.querySelector('[data-interaction="${approvalId}"]').click()`);
    assert.equal(await evaluate('document.getElementById("approval-reviewed").checked'), false);
    assert.equal(await evaluate('document.getElementById("approval-verdict").value'), '');
    assert.equal(await evaluate('document.getElementById("approval-submit").disabled'), true);
    assert.ok((await evaluate('document.getElementById("approval-body").textContent')).length > 0);
    await evaluate(`document.querySelectorAll('[data-approval-choice]').forEach(e => { e.value='유지'; e.dispatchEvent(new Event('change', {bubbles:true})); }); document.getElementById('approval-reviewed').checked=true; document.getElementById('approval-reviewed').dispatchEvent(new Event('change')); document.getElementById('approval-verdict').value='approve'; document.getElementById('approval-verdict').dispatchEvent(new Event('change'));`);
    assert.equal(await evaluate('document.getElementById("approval-submit").disabled'), false);
    writeFileSync(join(artifacts, 'live-mobile-approval.png'), Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
    await evaluate(`document.getElementById('approval-submit').click()`);
    await waitFor(`!document.getElementById('approval-close').disabled && /접수|적용|변경/.test(document.getElementById('approval-limit').textContent)`);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
}
