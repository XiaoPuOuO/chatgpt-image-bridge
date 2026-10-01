#!/usr/bin/env node
// chatgpt-image MCP server (stdio, newline-delimited JSON-RPC 2.0)
// 包裝 chatgpt-image-bridge.mjs：本機 ChatGPT Web 生圖並回傳圖片。
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const BRIDGE = join(dirname(fileURLToPath(import.meta.url)), 'chatgpt-image-bridge.mjs');

const TOOLS = [{
  name: 'generate',
  description: 'prompts 中每個元素各生成 1 張圖片；1 個元素生成 1 張，多個元素會並行生成。工具會等待所有圖片都完成後，依 prompts 原始順序一次回傳完整 images 陣列，不會逐張提前回傳。每個 prompt 應是可獨立理解的完整圖片描述，包含需要的主體、場景、構圖、文字與風格要求，不要依賴其他 prompt 的上下文。',
  inputSchema: {
    type: 'object',
    properties: {
      prompts: {
        type: 'array',
        minItems: 1,
        items: { type: 'string', minLength: 1 },
        description: '要生成的圖片描述陣列。每個 prompt 對應且只生成 1 張圖片；可只傳 1 個。多張圖有共同要求時，請把共同要求完整寫入每個 prompt。'
      },
      timeout: { type: 'number', description: '每張圖片的最長生成等待時間（秒），預設 300；通常不需設定。' },
      queue_timeout: { type: 'number', description: '頁面分配鎖的最長等待時間（秒），預設 900；僅供相容性，通常不需設定，不會讓生圖工作排隊。' },
      outs: {
        type: 'array',
        items: { type: 'string', minLength: 1 },
        description: '可選的 PNG 輸出路徑陣列，順序對應 prompts；若提供，長度必須與 prompts 完全相同。通常可省略。'
      }
    },
    required: ['prompts']
  }
}];

function startBridge(args) {
  let markSent;
  let markSentFailed;
  const sent = new Promise((resolve, reject) => {
    markSent = resolve;
    markSentFailed = reject;
  });

  const completion = new Promise((resolve, reject) => {
    const p = spawn('node', [BRIDGE, ...args]);
    let out = '', err = '', sentMarked = false;

    p.stdout.on('data', d => out += d);
    p.stderr.on('data', d => {
      err += d;
      if (!sentMarked && err.includes('[bridge] 發送: clicked')) {
        sentMarked = true;
        markSent();
      }
    });
    p.on('error', error => {
      if (!sentMarked) markSentFailed(error);
      reject(error);
    });
    p.on('close', code => {
      if (code === 0) {
        if (!sentMarked) markSent();
        resolve({ out: out.trim(), err });
        return;
      }
      const error = new Error(err.trim() || `bridge exit ${code}`);
      if (!sentMarked) markSentFailed(error);
      reject(error);
    });
  });

  return { sent, completion };
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const randomLaunchDelay = () => 1500 + Math.floor(Math.random() * 1501);

function readImageResult(out) {
  const [path] = out.split(' ');
  const buf = readFileSync(path);
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  return {
    id: 'img_' + randomBytes(6).toString('hex'),
    mime_type: 'image/png',
    width,
    height,
    path
  };
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
      serverInfo: { name: 'image', version: '1.1.0' }
    });
  }

  if (method === 'tools/list') return reply(id, { tools: TOOLS });
  if (method === 'ping') return reply(id, {});

  if (method === 'tools/call') {
    const a = params?.arguments ?? {};
    if (params?.name !== 'generate') return fail(id, `unknown tool: ${params?.name}`);

    const prompts = Array.isArray(a.prompts) ? a.prompts : [];
    if (!prompts.length || prompts.some(p => typeof p !== 'string' || !p.trim())) {
      return fail(id, 'non-empty prompts is required');
    }
    if (Array.isArray(a.outs) && a.outs.length !== prompts.length) return fail(id, 'outs length must match prompts length');

    const commonArgs = ['--timeout', String(a.timeout ?? 300), '--queue-timeout', String(a.queue_timeout ?? 900)];
    const jobs = [];

    try {
      for (let index = 0; index < prompts.length; index++) {
        const bridgeArgs = [prompts[index], ...commonArgs];
        const outPath = a.outs?.[index];
        if (outPath) bridgeArgs.push('--out', outPath);

        const job = startBridge(bridgeArgs);
        jobs.push(job.completion);

        if (index < prompts.length - 1) {
          await job.sent;
          await sleep(randomLaunchDelay());
        }
      }

      const runs = await Promise.all(jobs);
      const result = { status: 'success', images: runs.map(({ out }) => readImageResult(out)) };
      return reply(id, {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        isError: false
      });
    } catch (e) {
      return reply(id, {
        content: [{ type: 'text', text: JSON.stringify({ status: 'error', message: e.message }) }],
        isError: true
      });
    }
  }

  if (id !== null) reply(id, {});
});
