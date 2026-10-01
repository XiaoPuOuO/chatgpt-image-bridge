# chatgpt-image-bridge

透過**獨立 Google Chrome profile 中的 ChatGPT Web**自動生成圖片的 CLI 工具與 MCP server。

不是逆向 API、不用額外訂閱：工具用 Chrome DevTools Protocol（CDP）驅動一個專用 Chrome profile 裡已登入的 ChatGPT Web——在「新對話」輸入框注入 prompt、按「傳送」、輪詢到生成完畢、把圖片取回落盤。這個 profile 與你平常使用的 ChatGPT Desktop/Chrome 完全分離。

## 存在的意義

你訂閱 ChatGPT 就已經有聊天生圖額度，但它只能靠人在聊天窗口裡手動使用。這個工具把那份額度**變成一個可被程式呼叫的介面**：任何支援 MCP 的 Agent 環境（OpenCode、Claude Desktop 等）裝上它，Agent 就能直接「叫圖生圖」，產出 PNG 回傳繼續工作流——不用額外申請 OpenAI API key、不用按 API 計費付費、不動到帳號安全性（它只是自動化你本人的 UI 操作，官方看到的就是一個使用者在聊天）。

一句話：**把 ChatGPT 聊天的生圖額度搬進你自己的 Agent 工具鏈。**

## 原理

bridge 會以獨立 Chrome profile 啟動 ChatGPT Web，並用 loopback CDP 對頁面執行 `Runtime.evaluate`：

1. 檢查 `127.0.0.1:<port>/json/version`；若尚未啟動，開啟 Google Chrome，使用 `~/.chatgpt-bridge/chrome-profile`、`--remote-debugging-port=<port>` 並前往 `https://chatgpt.com/`。port 預設從 `~/.chatgpt-bridge/cdp-port` 讀取（可用 `--port` 顯式指定）；新啟動的 Chrome 會使用隨機高端口並寫回該檔，避免與其他 CDP 工具固定搶 9342。不會關閉或重啟 ChatGPT Desktop。
2. Attach `https://chatgpt.com/` 頁面，並安裝反偵測加固層（見下節）。
3. 以模擬真人滑鼠軌跡的 trusted click 點「新對話」→ 找到目前可見的 ChatGPT composer → trusted click 聚焦後，以「假貼上」注入 prompt：在頁面內直接合成 `ClipboardEvent('paste')` 並把文字放進事件的 `DataTransfer`（不經系統剪貼簿），前導補發 `Cmd/Ctrl+V` 的按鍵事件序列；驗證文字未入欄時才回退系統剪貼簿真貼上，再失敗回退 `Input.insertText`。最後 trusted click 點「傳送」。
4. 隨機間隔輪詢：無「停止」按鈕且生成圖片容器（`[data-testid="generated-image-preview"]`／`generated-image-gallery`）中出現比發送前更多的圖片即完成。
5. 同時支援 `data:image/...` 與新版 ChatGPT Web 的 `blob:https://chatgpt.com/...` 圖片來源；blob 會在頁面內轉成 data URL，再經 CDP 回傳並寫成 PNG。stdout 輸出 `路徑 bytes`。

CDP 只綁 127.0.0.1，不外露。

## 反自動化偵測加固

工具盡量讓官方網頁看到的行為接近真人操作：

- **啟動參數**：`--disable-blink-features=AutomationControlled`（`navigator.webdriver=false`）、防止分頁被背景節流／遮擋降頻的幾個 flag。
- **可信輸入**：所有點擊都是 CDP `Input.dispatchMouseEvent` 產生的 trusted event，滑鼠沿貝茲爾曲線移動（速度緩動、落點抖動、偶發停頓），而非 in-page `element.click()`。prompt 預設走「假貼上」：頁面內合成 `ClipboardEvent('paste')`（文字直接塞在事件的 `DataTransfer`，不碰系統剪貼簿），並按真人毫秒間隔補發 `Cmd/Ctrl+V` 按鍵序列；僅在它失敗時才回退系統剪貼簿 + trusted `Cmd/Ctrl+V` 真貼上（寫入前暫存、事後還原剪貼簿），再失敗才回退 `Input.insertText`。
- **isTrusted 偽裝**：合成事件的 `isTrusted` 預設為 `false`，而 Chrome 的 `isTrusted` 是實例級不可覆寫的 accessor，只能從讀取側動手。bridge 在頁面任何腳本載入前包裝 `EventTarget.prototype.addEventListener`：站方註冊的每個 listener 實際收到的是外殼，讀被標記事件的 `isTrusted` 時回 `true`，其餘屬性原樣透傳；包裝外殼與 `addEventListener` 本身的 `toString()` 都以消毒層的 `Function.prototype.toString` 補丁維持 `[native code]` 外觀。站方若在載入前就拿到舊版 stealth 頁（無此層），bridge 會自動重載一次以啟用完整偽裝。理論上唯一補不起來的探針：站方在貼上當下同步讀 `navigator.clipboard.readText()` 比對剪貼簿內容——目前無證據顯示 ChatGPT 這樣做。
- **隨機時序**：各步驟等待與輪詢間隔皆為隨機區間，沒有固定節拍；關鍵動作之間插入 `humanDwell`（隨機停留，50% 機率順帶滾動捲輪），模擬閱讀與考慮的時間。
- **生成期間 micro-drift**：等待生成时每 6–16 秒發送小幅度滑鼠移動，維持「有人在頁面上」的信號；並以 `Page.setWebLifecycleState=active` 保持分頁 `visibilityState=visible`。
- **console 消毒層**：`console.log(new Error())` 的堆疊序列化是 CDP 連線的固有洩漏（高階偵測器如 Turnstile 用 `Error.stack` getter 探針偵測 debugger）。bridge 在頁面任何腳本載入前注入包裝層，把傳入 console 的 `Error` 轉為乾淨複製品，使站方探針的 getter 永不觸發；包裝層的 `toString()` 以 `Function.prototype.toString` 補丁維持 `[native code]` 外觀。站方監控套件（如 Datadog）之後再包裝 console 時，bridge 會把消毒層重新疊到最外側並驗證。

自證工具：

```bash
node chatgpt-image-bridge.mjs --selftest
# 輸出 JSON：navigator.webdriver、descriptor、languages、plugins、WebGL、
# visibilityState、error.stack 計時、console.log Error probe（期望 "clean"）、
# isTrusted spoof（期望 boxed/seenTrusted 為 true、unmarkedTrusted 為 false）等
```

殘留風險：只要 CDP socket 連線存在，理论上仍有極少數高階探針能從時序／序列化側間接推斷（本機無头對照實驗已把可見洩漏降到 console 探針一項，而該項已被消毒）。真正的账号級偵測（IP、行為模式）不在本工具控制範圍。

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
# stdout: /Users/you/.chatgpt-bridge/out/chatgpt-1700000000000-12345.png 1271253
```

| 選項 | 預設 | 說明 |
|---|---|---|
| `--port` | 讀 `~/.chatgpt-bridge/cdp-port`，探索不到時 `9342` | CDP port；未顯式指定時新啟動的 Chrome 會改用隨機高端口並記錄到該檔 |
| `--timeout` | `300` | 等待生成逾時（秒） |
| `--queue-timeout` | `900` | page allocator lock 的最長等待秒數；生成工作本身不排隊 |
| `--out` | `~/.chatgpt-bridge/out/chatgpt-<ts>-<pid>.png` | 輸出路徑 |
| `--selftest` | — | 租用頁面並輸出反偵測自檢 JSON，不生圖 |

### 多 Agent／多圖片併發

bridge 會至少保留 1 個 ChatGPT Web page。當既有 page 已被其他生成任務占用時，會在同一個 Chrome process、同一個已登入的 profile 中開新的臨時 page，讓不同 Agent 或同一次多圖片請求可以並行工作；臨時 page 在任務完成後會自動關閉。每個 page 都有獨立的 CDP target，因此不依賴目前前景 tab 的焦點。

同一次 MCP 呼叫若傳入多個 `prompts`，每個 prompt 各自生成 1 張圖片，並**串行執行**：上一個 prompt 完整生成結束後，隨機等待 8–25 秒再啟動下一個，避免同一帳號短時間內被 burst 觸發限流。MCP 會等待所有圖片完成後，依 `prompts` 原始順序一次回傳完整 `images` 陣列。

### MCP server（給 AI Agent 呼叫）

`chatgpt-image-mcp.mjs` 是零依賴的 stdio MCP server，暴露單一工具 `generate`；建議將 MCP server 註冊名設為 `image`。不同 MCP 用戶端可能會用不同 namespace 格式顯示，例如 OpenChatX 會顯示為 `image__generate`。

`prompts` 必填且為陣列；可只傳 1 個，也可一次傳多個。`timeout`、`queue_timeout`、`outs` 為可選。每個 prompt 對應 1 張圖片，多個 prompt 會在同一呼叫內串行處理並在全部完成後一次回傳：

```json
{
  "prompts": [
    "一隻戴耳機的柴犬在打鍵盤，扁平插畫風",
    "一隻戴墨鏡的橘貓騎滑板，扁平插畫風",
    "一隻白色兔子拿著相機，扁平插畫風"
  ]
}
```

回傳：

```json
{
  "status": "success",
  "images": [
    { "id": "img_...", "mime_type": "image/png", "width": 1254, "height": 1254, "path": "..." },
    { "id": "img_...", "mime_type": "image/png", "width": 1536, "height": 1024, "path": "..." },
    { "id": "img_...", "mime_type": "image/png", "width": 1374, "height": 1145, "path": "..." }
  ]
}
```

失敗時為 `{ "status": "error", "message": "..." }`。不同 Agent 同時發起不同呼叫時會各自取得獨立 page，跨呼叫仍可並行、不需要互相排隊；同一呼叫內的多個 `prompts` 則串行執行。

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
- 本質上是 UI 自動化：多任務會使用同一個專用 Chrome profile 的不同 page 並行操作；網站改版或帳號側限制仍可能影響穩定性。
- **回退路徑會暫時使用系統剪貼簿**：預設的假貼上路徑不碰剪貼簿；只有當假貼上失敗、回退到 Cmd+V 真貼上時（macOS），才會暫存並還原你的剪貼簿內容，期間若你手動複製，可能被還原動作覆蓋。

## License

MIT
