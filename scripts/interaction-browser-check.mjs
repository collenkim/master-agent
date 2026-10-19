import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';

/** Actual dashboard clicks and HTTP/signature transport; caller supplies isolated test requests. */
export async function interactionBrowserCheck({ url, artifacts, questionId, approvalId }) {
  const browser = spawn(process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe', [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0',
    `--user-data-dir=${join(artifacts, 'browser-profile')}`, 'about:blank',
  ], { windowsHide: true, stdio: 'ignore' });
  let socket, send;
  try {
    const activePort = join(artifacts, 'browser-profile', 'DevToolsActivePort');
    for (let n = 0; n < 100 && !existsSync(activePort); n++) { if (browser.exitCode !== null) throw new Error('Chrome exited'); await delay(100); }
    const port = readFileSync(activePort, 'utf8').split('\n')[0];
    const page = await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: 'PUT', signal: AbortSignal.timeout(10000) })).json();
    socket = new WebSocket(page.webSocketDebuggerUrl); await once(socket, 'open');
    let sequence = 0; const pending = new Map(), errors = [];
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.id) { const callback = pending.get(message.id); pending.delete(message.id); message.error ? callback.reject(message.error) : callback.resolve(message.result); }
      if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails);
    });
    send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
    await send('Runtime.enable'); await send('Page.enable');
    const evaluate = async expression => {
      const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
    const waitFor = async expression => {
      for (let n = 0; n < 300; n++) { if (await evaluate(expression)) return; await delay(100); }
      throw new Error(`Timeout: ${expression}; ${await evaluate('document.getElementById("interaction-error")?.textContent + document.getElementById("approval-limit")?.textContent')}`);
    };
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
    if (send && socket.readyState === WebSocket.OPEN) { await send('Browser.close').catch(() => {}); socket.close(); }
    else browser.kill();
  }
}
