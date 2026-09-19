# chatgpt-image-bridge

透過**本機 ChatGPT Desktop App**（macOS）自動生成圖片的 CLI 工具與 MCP server。

不是逆向 API、不用額外訂閱：工具用 Chrome DevTools Protocol（CDP）驅動你自己已登入的 ChatGPT.app——在「新對話」輸入框注入 prompt、按「傳送」、輪詢到生成完畢、把圖片取回落盤。用的就是你 App 本身的帳號與配額。

## 原理

ChatGPT Desktop App 是 Electron 應用。以 `--remote-debugging-port` 參數啟動後，可用 loopback CDP 對其 renderer 執行 `Runtime.evaluate`：

1. 檢查 `127.0.0.1:9341/json/version`；若 App 未在 CDP 模式，先 `kill` 再以 `open -na /Applications/ChatGPT.app --args --remote-debugging-address=127.0.0.1 --remote-debugging-port=9341` 重啟（單實例鎖會忽略第二次啟動的參數，必須先結束舊進程；登入狀態保留）。
2. Attach 主視窗 target（`app://-/index.html`）。
3. 點「新對話」→ 清空 composer → `execCommand('insertText')` 注入 prompt → 點「傳送」。
4. 每 3 秒輪詢：無「停止」按鈕且出現新的生成圖片（`data:` URL 或 estuary/oaiusercontent URL）即完成。
5. 直接從 `data:` URL 取 base64（或頁內 `fetch` 帶 cookie 下載），寫成 PNG。stdout 輸出 `路徑 bytes`。

CDP 只綁 127.0.0.1，不外露。

## 需求

- macOS + `/Applications/ChatGPT.app`（已登入，方案需有圖片生成配額）
- Node.js >= 22（使用全域 `fetch` / `WebSocket`，零依賴）
- App 介面語言為中文或英文皆可（按鈕比對同時支援「新對話/傳送/停止」與 New chat/Send/Stop）

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
| `--port` | `9341` | CDP port |
| `--timeout` | `300` | 等待生成逾時（秒） |
| `--out` | `~/.chatgpt-bridge/out/chatgpt-<ts>.png` | 輸出路徑 |
| `--no-restart` | off | App 不在 CDP 模式時直接報錯而不重啟 |

### MCP server（給 AI Agent 呼叫）

`chatgpt-image-mcp.mjs` 是零依賴的 stdio MCP server，暴露單一工具 `generate_image`（引數：`prompt` 必填、`timeout`、`out`），回傳存檔路徑與 PNG 圖片內容。

OpenCode（`~/.config/opencode/opencode.jsonc`）：

```jsonc
"mcp": {
  "chatgpt-image": {
    "type": "local",
    "command": ["node", "/路徑/chatgpt-image-bridge/chatgpt-image-mcp.mjs"],
    "enabled": true,
    "timeout": 600000
  }
}
```

Claude Desktop 等其它 MCP 用戶端 similarly 以 `node chatgpt-image-mcp.mjs` 註冊為 local/stdio server。

## 已知限制

- **會留下一般對話紀錄**：App 右上角的「暫存對話」模式目前不支援圖片生成，所以生成結果會留在歷史中，需手動刪除。
- 重啟 App 期間視覺上會閃一下；建議不在 App 裡手動操作時使用。
- 生成耗時取決於官方配額與排隊狀態，預設逾時 5 分鐘。
- 依賴 App 內的按鈕文字（新對話/傳送/停止）。OpenAI 改版或新增語言介面時需更新選擇器。
- 本質上是 UI 自動化：同一時間請只跑一個 bridge，避免兩個橋搶同一個 composer。

## License

MIT
