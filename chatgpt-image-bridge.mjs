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
const SELFTEST = flag('selftest') === true;
const TIMEOUT = Number(flag('timeout', '300')) * 1000;
const QUEUE_TIMEOUT = Number(flag('queue-timeout', '900')) * 1000;
const OUT = flag('out', join(homedir(), '.chatgpt-bridge', 'out', `chatgpt-${Date.now()}-${process.pid}.png`));
const CHROME = '/Applications/Google Chrome.app';
const CHROME_PROFILE = join(homedir(), '.chatgpt-bridge', 'chrome-profile');
const STATE_DIR = join(homedir(), '.chatgpt-bridge');
const ALLOC_LOCK_DIR = join(STATE_DIR, 'page-allocator-lock');
const LEASE_DIR = join(STATE_DIR, 'page-leases');
const PRIMARY_TARGET_FILE = join(STATE_DIR, 'primary-target');
const PORT_HINT_FILE = join(STATE_DIR, 'cdp-port');
const EXPLICIT_PORT = args.includes('--port') ? Number(flag('port', '0')) : 0;
const readPortHint = () => { try { const n = Number(readFileSync(PORT_HINT_FILE, 'utf8').trim()); return n >= 1024 && n <= 65535 ? n : 0; } catch { return 0; } };
const writePortHint = (p) => { try { mkdirSync(STATE_DIR, { recursive: true }); writeFileSync(PORT_HINT_FILE, String(p)); } catch {} };
let PORT = EXPLICIT_PORT || readPortHint() || 9342;

if (!prompt && !SELFTEST) { console.error('用法: chatgpt-image-bridge.mjs "prompt" [--selftest]'); process.exit(2); }

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
    const r = await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, {
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
    if (!EXPLICIT_PORT) writePortHint(PORT);
    if ((await chatgptTargets()).length) return;
    console.error('[bridge] CDP 已啟動但沒有 ChatGPT 頁面，建立新分頁 ...');
    if (await openChatgptTarget()) return;
    console.error('[bridge] 無法建立 ChatGPT 頁面');
    process.exit(1);
  }
  if (!EXPLICIT_PORT) PORT = 20000 + Math.floor(Math.random() * 40000);
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
    '--disable-blink-features=AutomationControlled',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
    '--new-window',
    'https://chatgpt.com/'
  ]);
  const t1 = Date.now();
  while (Date.now() - t1 < 60000) {
    if (await cdpUp()) { if (!EXPLICIT_PORT) writePortHint(PORT); return; }
    await new Promise(r => setTimeout(r, 1000));
  }
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
      prompt: (prompt ?? 'selftest').slice(0, 60)
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

const rnd = (a, b) => a + Math.random() * (b - a);
const rint = (a, b) => Math.floor(rnd(a, b + 1));
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

let viewport = { w: 1280, h: 800 };
let cursor = null;
async function refreshViewport() {
  try { viewport = JSON.parse(await call('JSON.stringify({w:innerWidth,h:innerHeight})')); } catch {}
  if (!cursor) cursor = { x: rnd(viewport.w * 0.3, viewport.w * 0.7), y: rnd(viewport.h * 0.3, viewport.h * 0.7) };
}

async function moveMouseTo(tx, ty) {
  const p2 = { x: clamp(tx, 5, viewport.w - 5), y: clamp(ty, 5, viewport.h - 5) };
  const p0 = { ...cursor };
  const dx = p2.x - p0.x, dy = p2.y - p0.y, len = Math.hypot(dx, dy) || 1;
  const steps = clamp(Math.round(len / 40) + rint(6, 10), 8, 18);
  const bend = rnd(-1, 1) * Math.min(90, len * 0.3);
  const p1 = { x: (p0.x + p2.x) / 2 - (dy / len) * bend, y: (p0.y + p2.y) / 2 + (dx / len) * bend };
  const hesitateAt = rint(2, Math.max(2, steps - 2));
  for (let i = 1; i <= steps; i++) {
    const e = 1 - Math.pow(1 - i / steps, 3);
    const x = (1 - e) * (1 - e) * p0.x + 2 * (1 - e) * e * p1.x + e * e * p2.x;
    const y = (1 - e) * (1 - e) * p0.y + 2 * (1 - e) * e * p1.y + e * e * p2.y;
    const jx = i === steps ? 0 : rnd(-1.2, 1.2);
    const jy = i === steps ? 0 : rnd(-1.2, 1.2);
    await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: +(x + jx).toFixed(1), y: +(y + jy).toFixed(1) });
    if (i === hesitateAt) await wait(rnd(40, 120));
    await wait(rnd(6, 26));
  }
  cursor = p2;
}

async function humanClick(el) {
  const tx = el.x + el.w / 2 + clamp(rnd(-1, 1) * Math.min(8, el.w * 0.25), -el.w / 2 + 3, el.w / 2 - 3);
  const ty = el.y + el.h / 2 + rnd(-2, 2);
  await moveMouseTo(tx, ty);
  await wait(rnd(60, 180));
  await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: +tx.toFixed(1), y: +ty.toFixed(1), button: 'left', clickCount: 1, modifiers: 0 });
  await wait(rnd(45, 110));
  await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: +(tx + rnd(-1, 1)).toFixed(1), y: +(ty + rnd(-1, 1)).toFixed(1), button: 'left', clickCount: 1, modifiers: 0 });
  cursor = { x: tx, y: ty };
}

let driftStop = false;
async function driftWhileGenerating() {
  while (!driftStop) {
    await wait(rnd(6000, 16000));
    if (driftStop) break;
    try {
      for (let i = 0; i < rint(2, 4); i++) {
        if (driftStop) break;
        cursor = { x: clamp(cursor.x + rnd(-60, 60), 20, viewport.w - 20), y: clamp(cursor.y + rnd(-45, 45), 20, viewport.h - 20) };
        cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: +cursor.x.toFixed(1), y: +cursor.y.toFixed(1) }).catch(() => {});
        await wait(rnd(20, 60));
      }
    } catch {}
  }
}

async function humanDwell(minMs, maxMs) {
  await wait(rnd(minMs, maxMs));
  if (Math.random() < 0.5) {
    const x = rnd(viewport.w * 0.2, viewport.w * 0.8);
    const y = rnd(viewport.h * 0.25, viewport.h * 0.75);
    for (let i = 0; i < rint(2, 5); i++) {
      await cdp('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: rint(60, 260) * (Math.random() < 0.25 ? -1 : 1) }).catch(() => {});
      await wait(rnd(120, 380));
    }
  }
}

const PASTE_MODS = process.platform === 'darwin' ? 4 : 2;
async function hotkey(letter, vk, commands) {
  const base = { key: letter, code: 'Key' + letter.toUpperCase(), windowsVirtualKeyCode: vk, modifiers: PASTE_MODS };
  await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base, ...(commands ? { commands } : {}) });
  await wait(rnd(35, 90));
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}

let savedClipboard = null;
// macOS 的 pbcopy/pbpaste 在非 UTF-8 locale 下會丟棄或弄亂非 ASCII 內容
const LOCALE_UTF8 = /utf-?8/i.test(process.env.LC_ALL || process.env.LC_CTYPE || process.env.LANG || '');
const CLIP_ENV = LOCALE_UTF8 ? process.env : { ...process.env, LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' };
function restoreClipboard() {
  if (savedClipboard == null || process.platform !== 'darwin') return;
  spawnSync('pbcopy', { input: savedClipboard, env: CLIP_ENV });
  savedClipboard = null;
}

async function putOnClipboard(text) {
  if (process.platform === 'darwin') {
    const old = spawnSync('pbpaste', { encoding: 'utf8', env: CLIP_ENV });
    if (!old.error && old.status === 0 && old.stdout) savedClipboard = old.stdout;
    const r = spawnSync('pbcopy', { input: text, env: CLIP_ENV });
    if (!r.error && r.status === 0) {
      const back = spawnSync('pbpaste', { encoding: 'utf8', env: CLIP_ENV });
      if (!back.error && back.stdout === text) return true;
    }
  }
  try { await cdp('Browser.grantPermission', { origin: 'https://chatgpt.com', permission: { name: 'clipboardReadWrite' } }, 3000); } catch {}
  const wrote = await call(`(async () => { try { await navigator.clipboard.writeText(${JSON.stringify(text)}); return 'ok'; } catch (e) { return 'err'; } })()`, 5000).catch(() => 'err');
  return wrote === 'ok';
}

// 假貼上：在頁面內直接合成 keydown(Meta/Ctrl) -> keydown(v) -> ClipboardEvent(paste)
// -> keyup 序列派發給 composer，文字以 DataTransfer 傳入事件，全程不碰系統剪貼簿。
// 所有合成事件經 stealth 層標記；站方經 addEventListener 註冊的 listener 收到的是
// 包裝後的參數，對被標記事件讀 isTrusted 會得到 true（實例 isTrusted 是
// non-configurable getter，無法覆寫物件本身，只能在讀取側偽裝）。
// ChatGPT 的 Lexical 對真貼上本來就 preventDefault 後以應用層事务插入，DOM 結果一致。
function fakePasteEval(text) {
  const isMac = process.platform === 'darwin';
  const modKey = isMac ? 'Meta' : 'Control';
  const modCode = isMac ? 'MetaLeft' : 'ControlLeft';
  const modVk = isMac ? 93 : 17;
  const modProp = isMac ? 'metaKey' : 'ctrlKey';
  return `(async () => {
    const vis = el => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
    const form = [...document.querySelectorAll('form[data-chatgpt-composer]')].find(vis);
    const el = form && form.querySelector('[contenteditable=true]');
    if (!el) return 'no-composer';
    const b = window[Symbol.for('')];
    if (!b) return 'no-stealth';
    if (document.activeElement !== el) el.focus();
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const rnd = (a, c) => a + Math.random() * (c - a);
    const mk = (Ctor, type, o) => {
      const e = new Ctor(type, Object.assign({ bubbles: true, cancelable: true, composed: true, view: window }, o));
      try { b.m(e); } catch (err) {}
      return e;
    };
    el.dispatchEvent(mk(KeyboardEvent, 'keydown', { key: ${JSON.stringify(modKey)}, code: ${JSON.stringify(modCode)}, keyCode: ${modVk}, ${modProp}: true }));
    await sleep(rnd(28, 85));
    el.dispatchEvent(mk(KeyboardEvent, 'keydown', { key: 'v', code: 'KeyV', keyCode: 86, ${modProp}: true }));
    await sleep(rnd(15, 55));
    const dt = new DataTransfer();
    dt.setData('text/plain', ${JSON.stringify(text)});
    const pe = mk(ClipboardEvent, 'paste', { clipboardData: dt });
    el.dispatchEvent(pe);
    await sleep(rnd(25, 70));
    el.dispatchEvent(mk(KeyboardEvent, 'keyup', { key: 'v', code: 'KeyV', keyCode: 86, ${modProp}: true }));
    await sleep(rnd(18, 60));
    el.dispatchEvent(mk(KeyboardEvent, 'keyup', { key: ${JSON.stringify(modKey)}, code: ${JSON.stringify(modCode)}, keyCode: ${modVk}, ${modProp}: true }));
    return pe.defaultPrevented ? 'handled' : 'unhandled';
  })()`;
}

// 在頁面任何腳本之前執行：包裝 console 方法，Error 引數轉為乾淨複製品，
// 使站方「Error.stack getter」型 CDP 探針永不觸發；並以 WeakMap 讓包裝函數的
// toString() 維持 [native code] 外觀。
const STEALTH_INJECT = `(() => {
  try {
    var nativeToString = Function.prototype.toString;
    var overrides = new WeakMap();
    var fakeToString = function () {
      if (overrides.has(this)) return overrides.get(this);
      return nativeToString.call(this);
    };
    overrides.set(fakeToString, 'function toString() { [native code] }');
    Function.prototype.toString = fakeToString;
    var safeCopy = function (src) {
      var out = new Error();
      try {
        var d = Object.getOwnPropertyDescriptor(src, 'message');
        if (d && Object.prototype.hasOwnProperty.call(d, 'value') && typeof d.value === 'string') out.message = d.value;
      } catch (e) {}
      try {
        var n = Object.getOwnPropertyDescriptor(src, 'name');
        if (n && Object.prototype.hasOwnProperty.call(n, 'value') && typeof n.value === 'string') out.name = n.value;
      } catch (e) {}
      return out;
    };
    var sanitizeArg = function (a) {
      try { if (a instanceof Error) return safeCopy(a); } catch (e) {}
      return a;
    };
    var names = ['log', 'debug', 'info', 'warn', 'error', 'trace'];
    for (var i = 0; i < names.length; i++) {
      (function (name) {
        try {
          var orig = console[name];
          if (typeof orig !== 'function') return;
          var wrapper = function () {
            var args = new Array(arguments.length);
            for (var j = 0; j < arguments.length; j++) args[j] = sanitizeArg(arguments[j]);
            return orig.apply(console, args);
          };
          overrides.set(wrapper, 'function ' + name + '() { [native code] }');
          console[name] = wrapper;
        } catch (e) {}
      })(names[i]);
    }
    try {
      var nativeAddEl = EventTarget.prototype.addEventListener;
      if (typeof nativeAddEl === 'function') {
        var TRUSTKEY = Symbol.for('');
        var box = {};
        box.s = new WeakSet();
        box.v = 3;
        box.m = function (e) { try { box.s.add(e); } catch (x) {} };
        box.w = function (e) { try { var b = window[TRUSTKEY]; return b && b.s.has(e); } catch (x) { return false; } };
        Object.defineProperty(window, TRUSTKEY, { value: box, enumerable: false, configurable: true, writable: false });
        var aelProxy = new Proxy(nativeAddEl, {
          get: function (t, p) {
            if (p === 'toString') return function () { return 'function addEventListener() { [native code] }'; };
            return Reflect.get(t, p, t);
          },
          apply: function (t, thisArg, args) {
            if (args.length > 1) {
              var h = args[1];
              if (typeof h === 'function' || (h && typeof h.handleEvent === 'function')) {
                var g = function (ev) {
                  try {
                    if (ev && box.w(ev)) {
                      ev = new Proxy(ev, { get: function (tt, p2) { if (p2 === 'isTrusted') return true; return Reflect.get(tt, p2, tt); } });
                    }
                  } catch (x) {}
                  return typeof h === 'function' ? h.call(this, ev) : h.handleEvent(ev);
                };
                try { overrides.set(g, Function.prototype.toString.call(typeof h === 'function' ? h : h.handleEvent)); } catch (x) {}
                args[1] = g;
              }
            }
            return Reflect.apply(t, thisArg, args);
          }
        });
        try { overrides.set(aelProxy, 'function addEventListener() { [native code] }'); } catch (x) {}
        EventTarget.prototype.addEventListener = aelProxy;
      }
    } catch (e) {}
  } catch (e) {}
})();`;

const CONSOLE_LEAK_PROBE = `(async () => {
  let hit = false;
  const e = new Error('p');
  try { Object.defineProperty(e, 'stack', { configurable: true, get() { hit = true; } }); } catch {}
  console.log(e);
  await new Promise(r => setTimeout(r, 250));
  return hit;
})()`;

const STEALTH_PROBE = `(async () => {
  const out = {};
  out['navigator.webdriver'] = ('webdriver' in navigator) ? String(navigator.webdriver) : '(absent)';
  const wd = Object.getOwnPropertyDescriptor(Navigator.prototype, 'webdriver');
  out['webdriver descriptor'] = wd ? { get: typeof wd.get === 'function', value: wd.value } : null;
  out['window.chrome'] = !!window.chrome;
  out['userAgentData'] = !!navigator.userAgentData;
  out['languages'] = navigator.languages.join(',');
  out['plugins.length'] = navigator.plugins.length;
  try { out['Notification.permission'] = Notification.permission; } catch { out['Notification.permission'] = 'n/a'; }
  out['document.visibilityState'] = document.visibilityState;
  out['outerWidth>=innerWidth'] = window.outerWidth >= window.innerWidth;
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl');
    const ext = gl && gl.getExtension('WEBGL_debug_renderer_info');
    out['webgl.renderer'] = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : (gl ? gl.getParameter(gl.RENDERER) : 'n/a');
  } catch { out['webgl.renderer'] = 'error'; }
  const times = [];
  for (let i = 0; i < 300; i++) { const t = performance.now(); const e = new Error(); void e.stack; times.push(performance.now() - t); }
  times.sort((a, b) => a - b);
  out['error.stack median ms'] = +times[150].toFixed(4);
  out['console.log Error probe'] = await new Promise(res => {
    let hit = false;
    const e = new Error('probe');
    try { Object.defineProperty(e, 'stack', { configurable: true, get() { hit = true; } }); } catch {}
    console.log(e);
    setTimeout(() => res(hit ? 'CDP-DETECTED' : 'clean'), 300);
  });
  out['console.log.toString()'] = Function.prototype.toString.call(console.log);
  out['Function.prototype.toString.toString()'] = Function.prototype.toString.toString();
  out['isTrusted spoof'] = await new Promise(res => {
    try {
      const b = window[Symbol.for('')];
      const ev = new Event('stealth-trusted-probe');
      document.addEventListener('stealth-trusted-probe', e => res(JSON.stringify({
        boxed: !!b,
        seenTrusted: e.isTrusted,
        unmarkedTrusted: new Event('x').isTrusted,
        aelDisguise: Function.prototype.toString.call(EventTarget.prototype.addEventListener)
      })));
      if (b) b.m(ev);
      document.dispatchEvent(ev);
      setTimeout(() => res('timeout'), 500);
    } catch (e) { res('err ' + e.message); }
  });
  return JSON.stringify(out, null, 2);
})()`;

try { await cdp('Page.enable', {}, 5000); } catch {}
try { await cdp('Page.setWebLifecycleState', { state: 'active' }, 5000); } catch {}
try { await cdp('Page.addScriptToEvaluateOnNewDocument', { source: STEALTH_INJECT }, 5000); } catch {}

const waitDocumentComplete = async (limitMs = 45000) => {
  const t0 = Date.now();
  for (;;) {
    const rs = await call('document.readyState', 5000).catch(() => null);
    if (rs === 'complete') return;
    if (Date.now() - t0 > limitMs) return;
    await wait(rnd(300, 700));
  }
};

// 站方監控套件（如 Datadog）會在載入後再包裝 console.*，蓋在消毒層之上並率先讀取
// Error.stack。等站方腳本沉降後，把消毒層疊到最外側，讓站方探針先命中我們的複製品。
const installConsoleTopLayer = async () => { await call(STEALTH_INJECT, 8000).catch(() => {}); };

const verifyConsoleClean = async (reloadOnFail) => {
  let leak = await call(CONSOLE_LEAK_PROBE, 10000).catch(() => false);
  if (!leak) return true;
  await wait(rnd(2500, 4200));
  await installConsoleTopLayer();
  await wait(rnd(400, 900));
  leak = await call(CONSOLE_LEAK_PROBE, 10000).catch(() => false);
  if (!leak) return true;
  if (!reloadOnFail) return false;
  console.error('[bridge] 偵測到 console 洩漏，重載以重建消毒層 ...');
  try { await cdp('Page.navigate', { url: 'https://chatgpt.com/' }, 15000); } catch {}
  await waitDocumentComplete();
  await wait(rnd(2500, 4200));
  await installConsoleTopLayer();
  await wait(rnd(400, 900));
  leak = await call(CONSOLE_LEAK_PROBE, 10000).catch(() => false);
  if (leak) console.error('[bridge] 警告: console 消毒層未生效');
  return !leak;
};

const currentUrl = await call('location.href', 5000).catch(() => '');
let freshNavigation = false;
if (!currentUrl.startsWith('https://chatgpt.com')) {
  try { await cdp('Page.navigate', { url: 'https://chatgpt.com/' }, 15000); } catch {}
  await waitDocumentComplete();
  freshNavigation = true;
}
if (freshNavigation) {
  await wait(rnd(2500, 4200));
  await installConsoleTopLayer();
}
await verifyConsoleClean(true);
const hasTrustBox = await call(`(() => { const b = window[Symbol.for('')]; return !!(b && b.w && b.m && b.v >= 3); })()`, 5000).catch(() => false);
if (!hasTrustBox) {
  console.error('[bridge] stealth 層為舊版，重載以啟用 isTrusted 偽裝 ...');
  try { await cdp('Page.navigate', { url: 'https://chatgpt.com/' }, 15000); } catch {}
  await waitDocumentComplete();
  await wait(rnd(2500, 4200));
  await verifyConsoleClean(true);
}
await refreshViewport();

if (SELFTEST) {
  const report = await call(STEALTH_PROBE, 30000);
  console.log(report);
  ws.close();
  await releaseTarget(reservation.target.id, reservation.temporary);
  process.exit(0);
}

if (!SELFTEST) await humanDwell(1800, 4500);

const nc = JSON.parse(await call(`(async () => {
  const t0 = Date.now(), LIMIT = 60000;
  const vis = el => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  while (Date.now() - t0 < LIMIT) {
    const b = [...document.querySelectorAll('button')]
      .find(x => vis(x) && /^新對話|New chat$/i.test((x.getAttribute('aria-label') || x.innerText || '').trim()));
    if (b) {
      b.scrollIntoView({ block: 'center' });
      const r = b.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) return JSON.stringify({ state: 'found', x: r.x, y: r.y, w: r.width, h: r.height });
    }
    await new Promise(r => setTimeout(r, 200 + Math.random() * 250));
  }
  return JSON.stringify({ state: 'new-chat-button-timeout' });
})()`, 65000));
if (nc.state !== 'found') {
  await failAfterReservation(`[bridge] 無法建立可用的新對話: ${nc.state}`);
}
await wait(rnd(300, 900));
await humanClick(nc);
console.error('[bridge] 新對話: clicked');

const ready = await call(`(async () => {
  const t0 = Date.now(), LIMIT = 20000;
  while (Date.now() - t0 < LIMIT) {
    const composer = [...document.querySelectorAll('form[data-chatgpt-composer]')]
      .find(f => !!(f.offsetWidth || f.offsetHeight || f.getClientRects().length));
    if (composer && document.readyState === 'complete') return 'new-chat-ready';
    await new Promise(r => setTimeout(r, 200 + Math.random() * 250));
  }
  return 'composer-timeout';
})()`, 25000);
console.error(`[bridge] 頁面就緒: ${ready}`);
if (ready !== 'new-chat-ready') {
  await failAfterReservation(`[bridge] 無法建立可用的新對話: ${ready}`);
}
await humanDwell(1200, 3200);

const composer = JSON.parse(await call(`(() => {
  const form = [...document.querySelectorAll('form[data-chatgpt-composer]')]
    .find(f => !!(f.offsetWidth || f.offsetHeight || f.getClientRects().length));
  const el = form?.querySelector('[contenteditable=true]');
  if (!el) return JSON.stringify({ state: 'no-composer' });
  el.scrollIntoView();
  const r = el.getBoundingClientRect();
  if (r.width < 1 || r.height < 1) return JSON.stringify({ state: 'no-composer' });
  return JSON.stringify({ state: 'found', x: r.x, y: r.y, w: r.width, h: r.height });
})()`));
if (composer.state !== 'found') await failAfterReservation('[bridge] 找不到可見的 composer');
await humanClick(composer);
await wait(rnd(400, 1100));

const readComposer = () => call(`(() => {
  const form = [...document.querySelectorAll('form[data-chatgpt-composer]')]
    .find(f => !!(f.offsetWidth || f.offsetHeight || f.getClientRects().length));
  const el = form?.querySelector('[contenteditable=true]');
  return (el?.innerText || '').slice(0, 200);
})()`);
const normText = (s) => (s || '').replace(/\s+/g, '');
const want = normText(prompt).slice(0, 40);
const composedOk = async () => !!(want && normText(await readComposer().catch(() => '')).startsWith(want));
let mode = 'none';
const fpRes = await call(fakePasteEval(prompt), 15000).catch(() => 'err');
console.error(`[bridge] 假貼上: ${fpRes}`);
if (fpRes === 'handled' || fpRes === 'unhandled') {
  await wait(rnd(300, 700));
  if (await composedOk()) mode = 'fake';
}
if (mode === 'none') {
  if (normText(await readComposer().catch(() => ''))) {
    await hotkey('a', 65);
    await wait(rnd(80, 200));
  }
  if (await putOnClipboard(prompt).catch(() => false)) {
    await hotkey('v', 86, ['Paste']);
    await wait(rnd(250, 650));
    if (await composedOk()) mode = 'real';
  }
}
if (mode === 'none') {
  await hotkey('a', 65);
  await wait(rnd(80, 220));
  await cdp('Input.insertText', { text: prompt });
  mode = 'insert';
}
restoreClipboard();
const inj = await readComposer().catch(() => '');
console.error(`[bridge] 注入: ${JSON.stringify({ text: (inj || '').slice(0, 80), pasted: mode !== 'insert', mode })}`);
await humanDwell(1400, 3600);
if (Math.random() < 0.35) await wait(rnd(900, 2400));

const baseline = await call(`document.querySelectorAll('[data-testid="generated-image-preview"] img, [data-testid="generated-image-gallery"] img').length`);

const sendBtn = JSON.parse(await call(`(async () => {
  const t0 = Date.now(), LIMIT = 15000;
  const vis = el => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  const find = () => {
    const form = [...document.querySelectorAll('form[data-chatgpt-composer]')].find(vis);
    return [...(form?.querySelectorAll('button') || [])]
      .find(x => /^(傳送|發送|Send)$/i.test((x.getAttribute('aria-label') || x.innerText || '').trim()));
  };
  while (Date.now() - t0 < LIMIT) {
    const b = find();
    if (b && !b.disabled && vis(b)) {
      b.scrollIntoView({ block: 'center' });
      const r = b.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) return JSON.stringify({ state: 'found', x: r.x, y: r.y, w: r.width, h: r.height });
    }
    await new Promise(r => setTimeout(r, 200 + Math.random() * 250));
  }
  const b = find();
  if (!b) return JSON.stringify({ state: 'no-send-btn' });
  return JSON.stringify({ state: b.disabled ? 'send-disabled' : 'send-timeout' });
})()`, 20000));
if (sendBtn.state === 'found') {
  await humanClick(sendBtn);
  console.error('[bridge] 發送: clicked');
} else {
  await failAfterReservation(`[bridge] 發送失敗: ${sendBtn.state}`);
}

const driftPromise = driftWhileGenerating();
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
    await new Promise(r=>setTimeout(r,2500+Math.random()*2000));
  }
  return JSON.stringify({error:'timeout'});
})()`, TIMEOUT + 30000);

driftStop = true;
await driftPromise.catch(() => {});
ws.close();
const obj = JSON.parse(done);
if (obj.error) await failAfterReservation(`[bridge] 失敗: ${obj.error}`);
mkdirSync(join(OUT, '..'), { recursive: true });
writeFileSync(OUT, Buffer.from(obj.data, 'base64'));
await releaseTarget(reservation.target.id, reservation.temporary);
console.log(OUT + ' ' + obj.bytes);
