#!/usr/bin/env node
// chatgpt-image-bridge: 透過獨立 Chrome profile 的 loopback CDP 操作 ChatGPT Web、等待生成、取回 PNG。
// 用法: chatgpt-image-bridge.mjs "prompt" [--port 9342] [--timeout 300] [--queue-timeout 900] [--out FILE]
// 併發安全：每個 bridge 租用一個獨立 ChatGPT 頁面；第一個頁面常駐，額外併發頁面完成後關閉。
import { mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const prompt = args.find(a => !a.startsWith('--'));
const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i+1] && !args[i+1].startsWith('--') ? args[i+1] : (args.includes(`--${n}`) ? true : d); };
const PORT = Number(flag('port', '9342'));
const TIMEOUT = Number(flag('timeout', '300')) * 1000;
const QUEUE_TIMEOUT = Number(flag('queue-timeout', '900')) * 1000;
const OUT = flag('out', join(homedir(), '.chatgpt-bridge', 'out', `chatgpt-${Date.now()}-${process.pid}.png`));
const CHROME = '/Applications/Google Chrome.app';
const CHROME_PROFILE = join(homedir(), '.chatgpt-bridge', 'chrome-profile');
const STATE_DIR = join(homedir(), '.chatgpt-bridge');
const ALLOC_LOCK_DIR = join(STATE_DIR, 'page-allocator-lock');
const LEASE_DIR = join(STATE_DIR, 'page-leases');
const PRIMARY_TARGET_FILE = join(STATE_DIR, 'primary-target');

if (!prompt) { console.error('用法: chatgpt-image-bridge.mjs "prompt"'); process.exit(2); }

const cdpUp = async () => { try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: AbortSignal.timeout(2000) }); return r.ok; } catch { return false; } };
const chatgptTargets = async () => {
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json`, { signal: AbortSignal.timeout(2000) })).json();
    return list.filter(x => x.type === 'page' && /^https:\/\/chatgpt\.com(?:\/|$)/.test(x.url) && x.webSocketDebuggerUrl);
  } catch {
    return [];
  }
};
const openChatgptTarget = async () => {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/new?https://chatgpt.com/`, {
      method: 'PUT',
      signal: AbortSignal.timeout(5000)
    });
    return r.ok ? await r.json() : undefined;
  } catch {
    return undefined;
  }
};
const closeTarget = async (id) => {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/close/${encodeURIComponent(id)}`, {
      signal: AbortSignal.timeout(5000)
    });
    if (!r.ok) return false;
    const t0 = Date.now();
    while (Date.now() - t0 < 5000) {
      if (!(await chatgptTargets()).some(t => t.id === id)) return true;
      await sleep(100);
    }
    return false;
  } catch {
    return false;
  }
};

async function ensureCdp() {
  if (await cdpUp()) {
    if ((await chatgptTargets()).length) return;
    console.error('[bridge] CDP 已啟動但沒有 ChatGPT 頁面，建立新分頁 ...');
    if (await openChatgptTarget()) return;
    console.error('[bridge] 無法建立 ChatGPT 頁面');
    process.exit(1);
  }
  console.error('[bridge] 啟動獨立 ChatGPT Chrome profile ...');
  mkdirSync(CHROME_PROFILE, { recursive: true });
  spawnSync('/usr/bin/open', [
    '-na',
    CHROME,
    '--args',
    '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + CHROME_PROFILE,
    '--no-first-run',
    '--no-default-browser-check',
    '--new-window',
    'https://chatgpt.com/'
  ]);
  const t1 = Date.now();
  while (Date.now() - t1 < 60000) { if (await cdpUp()) return; await new Promise(r => setTimeout(r, 1000)); }
  console.error('[bridge] CDP 啟動逾時'); process.exit(1);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function acquireAllocatorLock() {
  mkdirSync(STATE_DIR, { recursive: true });
  const t0 = Date.now();
  for (;;) {
    try {
      mkdirSync(ALLOC_LOCK_DIR);
      writeFileSync(join(ALLOC_LOCK_DIR, 'owner'), JSON.stringify({ pid: process.pid, at: Date.now() }));
      return;
    } catch {
      let stale = false;
      try {
        const o = JSON.parse(readFileSync(join(ALLOC_LOCK_DIR, 'owner'), 'utf8'));
        let alive = true; try { process.kill(o.pid, 0); } catch { alive = false; }
        if (!alive || Date.now() - o.at > 90 * 1000) stale = true;
      } catch { stale = true; }
      if (stale) { rmSync(ALLOC_LOCK_DIR, { recursive: true, force: true }); continue; }
      if (Date.now() - t0 > Math.min(QUEUE_TIMEOUT, 120000)) throw new Error('page allocator lock timeout');
      await sleep(100);
    }
  }
}
const releaseAllocatorLock = () => rmSync(ALLOC_LOCK_DIR, { recursive: true, force: true });
const leasePath = (targetId) => join(LEASE_DIR, targetId);
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function reserveTarget() {
  await acquireAllocatorLock();
  try {
    await ensureCdp();
    mkdirSync(LEASE_DIR, { recursive: true });

    const targets = await chatgptTargets();
    const targetIds = new Set(targets.map(t => t.id));
    for (const file of readdirSync(LEASE_DIR)) {
      try {
        const path = join(LEASE_DIR, file);
        const lease = JSON.parse(readFileSync(path, 'utf8'));
        if (!targetIds.has(file) || !pidAlive(lease.pid)) {
          rmSync(path, { force: true });
          if (lease.temporary && targetIds.has(file)) await closeTarget(file);
        }
      } catch {
        rmSync(join(LEASE_DIR, file), { force: true });
      }
    }

    let refreshed = await chatgptTargets();
    let primaryId;
    try {
      primaryId = readFileSync(PRIMARY_TARGET_FILE, 'utf8').trim();
    } catch {}

    if (!primaryId || !refreshed.some(t => t.id === primaryId)) {
      const primary = refreshed[0] ?? await openChatgptTarget();
      if (!primary?.id || !primary.webSocketDebuggerUrl) throw new Error('無法建立主要 ChatGPT 頁面');
      primaryId = primary.id;
      writeFileSync(PRIMARY_TARGET_FILE, primaryId);
      refreshed = await chatgptTargets();
      console.error(`[bridge] 設定主要頁面 ${primaryId}`);
    }

    const leased = new Set(readdirSync(LEASE_DIR));
    const primary = refreshed.find(t => t.id === primaryId);
    let target;
    let temporary;

    if (primary && !leased.has(primary.id)) {
      target = primary;
      temporary = false;
      console.error(`[bridge] 租用主要頁面 ${target.id}`);
    } else {
      for (const orphan of refreshed.filter(t => t.id !== primaryId && !leased.has(t.id))) {
        await closeTarget(orphan.id);
      }

      target = await openChatgptTarget();
      if (!target?.id || !target.webSocketDebuggerUrl) throw new Error('無法建立額外 ChatGPT 頁面');
      temporary = true;
      console.error(`[bridge] 併發中，建立臨時頁面 ${target.id}`);
    }

    writeFileSync(leasePath(target.id), JSON.stringify({
      pid: process.pid,
      at: Date.now(),
      temporary,
      prompt: prompt.slice(0, 60)
    }));
    return { target, temporary };
  } finally {
    releaseAllocatorLock();
  }
}

async function releaseTarget(targetId, temporary) {
  rmSync(leasePath(targetId), { force: true });
  if (temporary) {
    const closed = await closeTarget(targetId);
    console.error(`[bridge] 臨時頁面 ${targetId} ${closed ? '已關閉' : '關閉失敗'}`);
  }
}

const reservation = await reserveTarget();
const ws = new WebSocket(reservation.target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
const failAfterReservation = async (message, code = 1) => {
  if (message) console.error(message);
  try { ws.close(); } catch {}
  await releaseTarget(reservation.target.id, reservation.temporary);
  process.exit(code);
};
let seq = 1;
const cdp = (method, params = {}, timeoutMs = 30000) => new Promise((res, rej) => {
  const id = seq++;
  const timer = setTimeout(() => { ws.removeEventListener('message', h); rej(new Error('evaluate timeout')); }, timeoutMs);
  const h = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id === id) { clearTimeout(timer); ws.removeEventListener('message', h);
      m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); }
  };
  ws.addEventListener('message', h);
  ws.send(JSON.stringify({ id, method, params }));
});
const call = async (expression, timeoutMs = 30000) => {
  const startedAt = Date.now();
  for (;;) {
    try {
      const remaining = Math.max(1000, timeoutMs - (Date.now() - startedAt));
      const r = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, remaining);
      if (r?.exceptionDetails) {
        const detail = r.exceptionDetails.exception?.description || r.exceptionDetails.text || 'Runtime.evaluate failed';
        throw new Error(detail);
      }
      return r?.result?.value;
    } catch (error) {
      if (!String(error?.message || error).includes('Cannot find default execution context')) throw error;
      if (Date.now() - startedAt >= timeoutMs) throw error;
      await sleep(250);
    }
  }
};

const wait = (ms) => new Promise(r => setTimeout(r, ms));

const ready = await call(`(async () => {
  const t0 = Date.now(), LIMIT = 60000;
  let clickedNewChat = false;
  while (Date.now() - t0 < LIMIT) {
    const composer = [...document.querySelectorAll('form[data-chatgpt-composer]')]
      .find(f => !!(f.offsetWidth || f.offsetHeight || f.getClientRects().length));
    if (composer && document.readyState === 'complete') return clickedNewChat ? 'clicked-and-ready' : 'composer-ready';

    if (!clickedNewChat) {
      const b = [...document.querySelectorAll('button')]
        .find(x=>/^新對話|New chat$/i.test((x.getAttribute('aria-label')||x.innerText||'').trim()));
      if (b) {
        b.click();
        clickedNewChat = true;
      }
    }

    await new Promise(r => setTimeout(r, 250));
  }
  return 'timeout';
})()`, 65000);
console.error(`[bridge] 頁面就緒: ${ready}`);
if (ready === 'timeout') {
  await failAfterReservation('[bridge] ChatGPT 頁面 60 秒內仍未就緒。若這是第一次使用，請確認專用 Chrome 視窗已登入 ChatGPT；否則可能只是網頁載入失敗，可重試。');
}
if (ready === 'composer-ready') {
  console.error('[bridge] 已在可用的新對話頁面');
}
await wait(1000);

const focused = await call(`(() => {
  const form = [...document.querySelectorAll('form[data-chatgpt-composer]')]
    .find(f => !!(f.offsetWidth || f.offsetHeight || f.getClientRects().length));
  const el = form?.querySelector('[contenteditable=true]');
  if (!el) return 'no-composer';
  el.scrollIntoView(); el.focus();
  return 'focused';
})()`);
if (focused !== 'focused') await failAfterReservation('[bridge] 找不到可見的 composer');
await cdp('Input.insertText', { text: prompt });
const inj = await call(`(() => {
  const form = [...document.querySelectorAll('form[data-chatgpt-composer]')]
    .find(f => !!(f.offsetWidth || f.offsetHeight || f.getClientRects().length));
  const el = form?.querySelector('[contenteditable=true]');
  return JSON.stringify({text: (el?.innerText || '').slice(0,80)});
})()`);
console.error(`[bridge] 注入: ${inj}`);
await wait(800);

const baseline = await call(`document.querySelectorAll('[data-testid="generated-image-preview"] img, [data-testid="generated-image-gallery"] img').length`);

const sent = await call(`(async () => {
  const t0 = Date.now(), LIMIT = 15000;
  while (Date.now() - t0 < LIMIT) {
    const form = [...document.querySelectorAll('form[data-chatgpt-composer]')]
      .find(f => !!(f.offsetWidth || f.offsetHeight || f.getClientRects().length));
    const b = [...(form?.querySelectorAll('button') || [])]
      .find(x=>/^(傳送|發送|Send)$/i.test((x.getAttribute('aria-label')||x.innerText||'').trim()));
    if (b && !b.disabled) { b.click(); return 'clicked'; }
    await new Promise(r => setTimeout(r, 250));
  }
  const form = [...document.querySelectorAll('form[data-chatgpt-composer]')]
    .find(f => !!(f.offsetWidth || f.offsetHeight || f.getClientRects().length));
  const b = [...(form?.querySelectorAll('button') || [])]
    .find(x=>/^(傳送|發送|Send)$/i.test((x.getAttribute('aria-label')||x.innerText||'').trim()));
  if (!b) return 'no-send-btn';
  return b.disabled ? 'send-disabled' : 'send-timeout';
})()`, 20000);
console.error(`[bridge] 發送: ${sent}`);
if (sent !== 'clicked') await failAfterReservation(`[bridge] 發送失敗: ${sent}`);

const done = await call(`(async () => {
  const t0 = Date.now(), LIMIT = ${TIMEOUT};
  const match = () => [...document.querySelectorAll('[data-testid="generated-image-preview"] img, [data-testid="generated-image-gallery"] img')]
    .filter(i => i.src.startsWith('data:image/') || i.src.startsWith('blob:https://chatgpt.com/'));
  const toDataUrl = async (img) => {
    if (img.src.startsWith('data:image/')) return img.src;
    const blob = await fetch(img.src).then(r => {
      if (!r.ok) throw new Error('image blob fetch failed: ' + r.status);
      return r.blob();
    });
    return await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error || new Error('image blob read failed'));
      reader.readAsDataURL(blob);
    });
  };
  while (Date.now() - t0 < LIMIT) {
    const generating = [...document.querySelectorAll('button')].some(b=>/^(停止|Stop)$/i.test((b.getAttribute('aria-label')||b.innerText||'').trim()));
    const imgs = match();
    if (!generating && imgs.length > ${baseline}) {
      const dataUrl = await toDataUrl(imgs[imgs.length-1]);
      const b64 = dataUrl.split(',')[1];
      return JSON.stringify({ok:true, bytes: Math.floor(b64.length*3/4), data:b64});
    }
    await new Promise(r=>setTimeout(r,3000));
  }
  return JSON.stringify({error:'timeout'});
})()`, TIMEOUT + 30000);

ws.close();
const obj = JSON.parse(done);
if (obj.error) await failAfterReservation(`[bridge] 失敗: ${obj.error}`);
mkdirSync(join(OUT, '..'), { recursive: true });
writeFileSync(OUT, Buffer.from(obj.data, 'base64'));
await releaseTarget(reservation.target.id, reservation.temporary);
console.log(OUT + ' ' + obj.bytes);
