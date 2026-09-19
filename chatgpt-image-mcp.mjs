#!/usr/bin/env node
// chatgpt-image MCP server (stdio, newline-delimited JSON-RPC 2.0)
// 包裝 ~/bin/chatgpt-image-bridge.mjs：本機 ChatGPT.app 生圖並回傳圖片。
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const BRIDGE = join(dirname(fileURLToPath(import.meta.url)), 'chatgpt-image-bridge.mjs');

const TOOLS = [{
  name: 'image_generate',
  description: '用使用者本人 ChatGPT Desktop App 的訂閱配額生成圖片（不用 API key、不另計費）。工具經本機 CDP 驅動已登入的 ChatGPT.app：開新對話、注入 prompt、發送、等生成完畢後存成 PNG，回傳檔案路徑與圖片本身。prompt 請用一句具體、自足的描述（中英文皆可），使用者指定風格時要寫進去。單張通常需 30-120 秒。App 若未以 CDP 模式運行會自動重啟一次（登入狀態保留）。多個 Agent 同時呼叫會經檔案鎖自動 FIFO 排隊、一次一張，併發時請相應調高 timeout／queue_timeout。',
  inputSchema: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: 'Image description sent to ChatGPT verbatim (Chinese or English). Describe subject, style, composition in one self-contained sentence.' },
      timeout: { type: 'number', description: 'Seconds to wait for generation to finish, default 300' },
      queue_timeout: { type: 'number', description: 'Seconds to wait for earlier queued image jobs, default 900' },
      out: { type: 'string', description: 'PNG save path, default ~/.chatgpt-bridge/out/chatgpt-<timestamp>.png' }
    },
    required: ['prompt']
  }
}];

function runBridge(args) {
  return new Promise((resolve, reject) => {
    const p = spawn('node', [BRIDGE, ...args]);
    let out = '', err = '';
    p.stdout.on('data', d => out += d);
    p.stderr.on('data', d => err += d);
    p.on('error', reject);
    p.on('close', code => code === 0 ? resolve({ out: out.trim(), err }) : reject(new Error(err.trim() || `bridge exit ${code}`)));
  });
}

const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const fail = (id, message) => send({ jsonrpc: '2.0', id, error: { code: -32603, message } });

createInterface({ input: process.stdin }).on('line', async (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const { id, method, params } = msg;
  if (id === undefined || !method) return;

  if (method === 'initialize') {
    return reply(id, {
      protocolVersion: params?.protocolVersion ?? '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'chatgpt-image', version: '1.0.0' }
    });
  }
  if (method === 'tools/list') return reply(id, { tools: TOOLS });
  if (method === 'ping') return reply(id, {});
  if (method === 'tools/call') {
    const a = params?.arguments ?? {};
    if (params?.name !== 'image_generate') return fail(id, `unknown tool: ${params?.name}`);
    if (!a.prompt) return fail(id, 'prompt is required');
    const bridgeArgs = [a.prompt, '--timeout', String(a.timeout ?? 300), '--queue-timeout', String(a.queue_timeout ?? 900)];
    if (a.out) bridgeArgs.push('--out', a.out);
    try {
      const { out } = await runBridge(bridgeArgs);
      const [path, bytes] = out.split(' ');
      const b64 = readFileSync(path).toString('base64');
      return reply(id, {
        content: [
          { type: 'text', text: `圖片已生成並儲存: ${path} (${bytes} bytes)` },
          { type: 'image', data: b64, mimeType: 'image/png' }
        ],
        isError: false
      });
    } catch (e) {
      return reply(id, { content: [{ type: 'text', text: `生成失敗: ${e.message}` }], isError: true });
    }
  }
  if (id !== null) reply(id, {});
});
