# chatgpt-image-bridge

透過**獨立 Google Chrome profile 中的 ChatGPT Web**自動生成圖片的 CLI 工具與 MCP server。

不是逆向 API、不用額外訂閱：工具用 Chrome DevTools Protocol（CDP）驅動一個專用 Chrome profile 裡已登入的 ChatGPT Web——在「新對話」輸入框注入 prompt、按「傳送」、輪詢到生成完畢、把圖片取回落盤。這個 profile 與你平常使用的 ChatGPT Desktop/Chrome 完全分離。

## 存在的意義

你訂閱 ChatGPT 就已經有聊天生圖額度，但它只能靠人在聊天窗口裡手動使用。這個工具把那份額度**變成一個可被程式呼叫的介面**：任何支援 MCP 的 Agent 環境（OpenCode、Claude Desktop 等）裝上它，Agent 就能直接「叫圖生圖」，產出 PNG 回傳繼續工作流——不用額外申請 OpenAI API key、不用按 API 計費付費、不動到帳號安全性（它只是自動化你本人的 UI 操作，官方看到的就是一個使用者在聊天）。

一句話：**把 ChatGPT 聊天的生圖額度搬進你自己的 Agent 工具鏈。**

## 原理

bridge 會以獨立 Chrome profile 啟動 ChatGPT Web，並用 loopback CDP 對頁面執行 `Runtime.evaluate`：

1. 檢查 `127.0.0.1:9342/json/version`；若尚未啟動，開啟 Google Chrome，使用 `~/.chatgpt-bridge/chrome-profile`、`--remote-debugging-port=9342` 並前往 `https://chatgpt.com/`。不會關閉或重啟 ChatGPT Desktop。
2. Attach `https://chatgpt.com/` 頁面。
3. 點「新對話」→ 找到目前可見的 ChatGPT composer → 透過 CDP `Input.insertText` 注入 prompt → 點「傳送」。
4. 每 3 秒輪詢：無「停止」按鈕且生成圖片容器（`[data-testid="generated-image-preview"]`／`generated-image-gallery`）中出現比發送前更多的圖片即完成。
5. 同時支援 `data:image/...` 與新版 ChatGPT Web 的 `blob:https://chatgpt.com/...` 圖片來源；blob 會在頁面內轉成 data URL，再經 CDP 回傳並寫成 PNG。stdout 輸出 `路徑 bytes`。

CDP 只綁 127.0.0.1，不外露。

## 需求

- macOS + `/Applications/Google Chrome.app`
- 第一次使用時，在自動開啟的專用 Chrome 視窗登入一次 ChatGPT；登入狀態會保存在 `~/.chatgpt-bridge/chrome-profile`
- Node.js >= 22（使用全域 `fetch` / `WebSocket`，零依賴）
- ChatGPT Web 介面語言為中文或英文皆可（按鈕比對同時支援「新對話/傳送/停止」與 New chat/Send/Stop）

## 安裝

```bash
git clone https://github.com/XiaoPuOuO/chatgpt-image-bridge.git
cd chatgpt-image-bridge
chmod +x chatgpt-image-bridge.mjs chatgpt-image-mcp.mjs
```

## 用法

### CLI

```bash
node chatgpt-image-bridge.mjs "畫一張扁平插畫風的小圖：一隻戴耳機的柴犬在打鍵盤"
# stderr: [bridge] 新對話: clicked / 注入: ... / 發送: clicked
# stdout: /Users/you/.chatgpt-bridge/out/chatgpt-1700000000000.png 1271253
```

| 選項 | 預設 | 說明 |
|---|---|---|
| `--port` | `9342` | CDP port |
| `--timeout` | `300` | 等待生成逾時（秒） |
| `--queue-timeout` | `900` | 等待其他 bridge 任務完成的最長秒數，逾時退出碼 3 |
| `--out` | `~/.chatgpt-bridge/out/chatgpt-<ts>.png` | 輸出路徑 |

### 多 Agent 併發

多個 bridge 行程同時啟動時，會透過 `~/.chatgpt-bridge/lock` 檔案鎖自動排隊，同一時間只有一個操作專用 ChatGPT Web 頁面，其餘等待前一個完成後依序執行。持有鎖的行程崩潰時，鎖會因 pid 失效或超過 15 分鐘而被自動搶佔。

### MCP server（給 AI Agent 呼叫）

`chatgpt-image-mcp.mjs` 是零依賴的 stdio MCP server，暴露單一工具 `generate`；建議將 MCP server 註冊名設為 `image`。不同 MCP 用戶端可能會用不同 namespace 格式顯示，例如 OpenChatX 會顯示為 `image__generate`。引數：`prompt` 必填、`timeout`、`queue_timeout`、`out`。回傳 JSON：

```json
{ "status": "success", "images": [ { "id": "img_...", "mime_type": "image/png", "width": 1254, "height": 1254, "path": "..." } ] }
```

失敗時為 `{ "status": "error", "message": "..." }`。多個 Agent 同時呼叫時自動排隊，不會互相干擾。

OpenCode（`~/.config/opencode/opencode.jsonc`）：

```jsonc
"mcp": {
  "image": {
    "type": "local",
    "command": ["node", "/路徑/chatgpt-image-bridge/chatgpt-image-mcp.mjs"],
    "enabled": true,
    "timeout": 1800000
  }
}
```

Claude Desktop 等其它 MCP 用戶端 similarly 以 `node chatgpt-image-mcp.mjs` 註冊為 local/stdio server。

## 已知限制

- **會留下一般對話紀錄**：生成結果會留在 ChatGPT 歷史中，需手動刪除。
- 第一次使用需要在專用 Chrome profile 登入 ChatGPT 一次。
- 生成耗時取決於官方配額與排隊狀態，預設逾時 5 分鐘。
- 依賴 ChatGPT Web 的按鈕文字（新對話/傳送/停止）與 `generated-image-*` testid。OpenAI 改版或新增語言介面時需更新選擇器。
- 本質上是 UI 自動化：同一時間只有一個 bridge 操作專用頁面，多 bridge 併發時由檔案鎖自動排隊。

## License

MIT
