import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

/** A disposable Chrome session shared by dashboard smoke checks. */
export async function openBrowser(url, artifacts) {
  const browser = spawn(process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe', [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0',
    `--user-data-dir=${join(artifacts, 'browser-profile')}`, 'about:blank',
  ], { windowsHide: true, stdio: 'ignore' });
  let socket, sequence = 0, startupError;
  const pending = new Map(), errors = [];
  browser.on('error', error => { startupError = error; });
  function rejectPending(error) {
    for (const callback of pending.values()) callback.reject(error);
    pending.clear();
  }
  function send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Chrome command timed out: ${method}`)); }, 10000);
      const callback = { resolve(value) { clearTimeout(timer); resolve(value); }, reject(error) { clearTimeout(timer); reject(error); } };
      pending.set(id, callback);
      try { socket.send(JSON.stringify({ id, method, params })); }
      catch (error) { pending.delete(id); callback.reject(error); }
    });
  }
  async function close() {
    if (socket?.readyState === WebSocket.OPEN) await send('Browser.close').catch(() => {});
    socket?.close();
    rejectPending(new Error('Chrome session closed'));
    if (browser.exitCode === null) browser.kill();
  }
  try {
    const activePort = join(artifacts, 'browser-profile', 'DevToolsActivePort');
    for (let n = 0; n < 100 && !existsSync(activePort); n++) {
      if (startupError) throw startupError;
      if (browser.exitCode !== null) throw new Error(`Chrome exited: ${browser.exitCode}`);
      await delay(100);
    }
    if (!existsSync(activePort)) throw new Error('Chrome startup timed out');
    const port = readFileSync(activePort, 'utf8').split('\n')[0];
    const page = await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, {
      method: 'PUT', signal: AbortSignal.timeout(10000),
    })).json();
    socket = new WebSocket(page.webSocketDebuggerUrl);
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const callback = pending.get(message.id);
        pending.delete(message.id);
        if (callback) message.error ? callback.reject(new Error(message.error.message)) : callback.resolve(message.result);
      }
      if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails);
    });
    socket.addEventListener('close', () => rejectPending(new Error('Chrome connection closed')));
    socket.addEventListener('error', () => rejectPending(new Error('Chrome connection failed')));
    await once(socket, 'open', { signal: AbortSignal.timeout(10000) });
    await send('Runtime.enable'); await send('Page.enable');
    const evaluate = async expression => {
      const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
    const waitFor = async expression => {
      for (let n = 0; n < 300; n++) { if (await evaluate(expression)) return; await delay(100); }
      throw new Error(`Chrome condition timed out: ${expression}; ${JSON.stringify(errors)}`);
    };
    return { send, evaluate, waitFor, errors, close };
  } catch (error) { await close(); throw error; }
}
