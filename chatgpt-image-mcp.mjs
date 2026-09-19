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
  name: 'generate',
  description: '依文字描述生成一張圖片，回傳 PNG 與存檔路徑。prompt 寫成具體、自足的一句話（中英文皆可），使用者指定的風格要寫進去。',
  inputSchema: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: '圖片描述' },
      timeout: { type: 'number', description: '等待生成逾時秒數，預設 300' },
      queue_timeout: { type: 'number', description: '排隊等待逾時秒數，預設 900' },
      out: { type: 'string', description: 'PNG 存檔路徑，預設 ~/.chatgpt-bridge/out/chatgpt-<timestamp>.png' }
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
      serverInfo: { name: 'image', version: '1.0.0' }
    });
  }
  if (method === 'tools/list') return reply(id, { tools: TOOLS });
  if (method === 'ping') return reply(id, {});
  if (method === 'tools/call') {
    const a = params?.arguments ?? {};
    if (params?.name !== 'generate') return fail(id, `unknown tool: ${params?.name}`);
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
