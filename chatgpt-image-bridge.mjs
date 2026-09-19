#!/usr/bin/env node
// chatgpt-image-bridge: 透過本機 ChatGPT.app 的 loopback CDP 注入 prompt、等待生成、取回 PNG。
// 用法: chatgpt-image-bridge.mjs "prompt" [--port 9341] [--timeout 300] [--out FILE] [--no-restart]
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const prompt = args.find(a => !a.startsWith('--'));
const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i+1] && !args[i+1].startsWith('--') ? args[i+1] : (args.includes(`--${n}`) ? true : d); };
const PORT = Number(flag('port', '9341'));
const TIMEOUT = Number(flag('timeout', '300')) * 1000;
const OUT = flag('out', join(homedir(), '.chatgpt-bridge', 'out', `chatgpt-${Date.now()}.png`));
const APP = '/Applications/ChatGPT.app';

if (!prompt) { console.error('用法: chatgpt-image-bridge.mjs "prompt"'); process.exit(2); }

const cdpUp = async () => { try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: AbortSignal.timeout(2000) }); return r.ok; } catch { return false; } };

async function ensureCdp() {
  if (await cdpUp()) return;
  if (flag('no-restart')) { console.error(`CDP port ${PORT} 未開啟`); process.exit(1); }
  console.error('[bridge] 以 CDP 參數重啟 ChatGPT.app ...');
  const cur = spawnSync('pgrep', ['-f', `${APP}/Contents/MacOS/ChatGPT`]).stdout.toString().trim().split('\n').filter(Boolean);
  for (const pid of cur) spawnSync('kill', [pid]);
  const t0 = Date.now();
  while (Date.now() - t0 < 20000) {
    if (spawnSync('pgrep', ['-f', `${APP}/Contents/MacOS/ChatGPT`]).status !== 0) break;
    await new Promise(r => setTimeout(r, 500));
  }
  spawnSync('/usr/bin/open', ['-na', APP, '--args', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=' + PORT]);
  const t1 = Date.now();
  while (Date.now() - t1 < 60000) { if (await cdpUp()) return; await new Promise(r => setTimeout(r, 1000)); }
  console.error('[bridge] CDP 啟動逾時'); process.exit(1);
}

async function attach() {
  const t0 = Date.now();
  while (Date.now() - t0 < 60000) {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json().catch(() => []);
    const t = list.find(x => x.url === 'app://-/index.html' && x.webSocketDebuggerUrl);
    if (t) return t.webSocketDebuggerUrl;
    await new Promise(r => setTimeout(r, 1000));
  }
  console.error('[bridge] 找不到 app://-/index.html renderer'); process.exit(1);
}

await ensureCdp();
const ws = new WebSocket(await attach());
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let seq = 1;
const call = (expression, timeoutMs = 30000) => new Promise((res, rej) => {
  const id = seq++;
  const timer = setTimeout(() => { ws.removeEventListener('message', h); rej(new Error('evaluate timeout')); }, timeoutMs);
  const h = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id === id) { clearTimeout(timer); ws.removeEventListener('message', h);
      m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result?.result?.value); }
  };
  ws.addEventListener('message', h);
  ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }));
});

const wait = (ms) => new Promise(r => setTimeout(r, ms));

const ready = await call(`(() => { const b=[...document.querySelectorAll('button')].find(x=>/^新對話|New chat$/i.test((x.getAttribute('aria-label')||x.innerText||'').trim())); if(!b) return 'no-newchat-btn'; b.click(); return 'clicked'; })()`);
console.error(`[bridge] 新對話: ${ready}`);
await wait(2500);

const inj = await call(`(() => {
  const el = document.querySelector('[contenteditable=true]'); if(!el) return 'no-composer';
  el.scrollIntoView(); el.focus();
  document.execCommand('selectAll', false, null);
  document.execCommand('delete', false, null);
  const sel = window.getSelection(); const range = document.createRange();
  range.selectNodeContents(el); range.collapse(false);
  sel.removeAllRanges(); sel.addRange(range);
  document.execCommand('insertText', false, ${JSON.stringify(prompt)});
  return JSON.stringify({text: el.innerText.slice(0,80)});
})()`);
console.error(`[bridge] 注入: ${inj}`);
await wait(800);

const baseline = await call(`document.querySelectorAll('[data-testid="generated-image-preview"] img, [data-testid="generated-image-gallery"] img').length`);

const sent = await call(`(() => { const b=[...document.querySelectorAll('button')].find(x=>/^(傳送|發送|Send)$/i.test((x.getAttribute('aria-label')||x.innerText||'').trim())); if(!b) return 'no-send-btn'; if(b.disabled) return 'send-disabled'; b.click(); return 'clicked'; })()`);
console.error(`[bridge] 發送: ${sent}`);
if (sent !== 'clicked') { console.error('[bridge] 發送失敗'); process.exit(1); }

const done = await call(`(async () => {
  const t0 = Date.now(), LIMIT = ${TIMEOUT};
  const match = () => [...document.querySelectorAll('[data-testid="generated-image-preview"] img, [data-testid="generated-image-gallery"] img')].filter(i => /^data:image/.test(i.src));
  while (Date.now() - t0 < LIMIT) {
    const generating = [...document.querySelectorAll('button')].some(b=>/^(停止|Stop)$/i.test((b.getAttribute('aria-label')||b.innerText||'').trim()));
    const imgs = match();
    if (!generating && imgs.length > ${baseline}) {
      const b64 = imgs[imgs.length-1].src.split(',')[1];
      return JSON.stringify({ok:true, bytes: Math.floor(b64.length*3/4), data:b64});
    }
    await new Promise(r=>setTimeout(r,3000));
  }
  return JSON.stringify({error:'timeout'});
})()`, TIMEOUT + 30000);

ws.close();
const obj = JSON.parse(done);
if (obj.error) { console.error(`[bridge] 失敗: ${obj.error}`); process.exit(1); }
mkdirSync(join(OUT, '..'), { recursive: true });
writeFileSync(OUT, Buffer.from(obj.data, 'base64'));
console.log(OUT + ' ' + obj.bytes);
