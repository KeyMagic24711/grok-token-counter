# Grok Token Counter

Unofficial Chrome extension (Manifest V3) for **grok.com**. It shows a slim usage strip inside the chat composer, along the bottom edge below the control row:

```
1,234 tokens · Grok weekly: 6% (resets in 5d 23h) [■■|─────]   [■■■|────] Grok Bot weekly: 24% (resets in 5d 23h) ↻
```

## Features
- **Conversation token count** (v0.6+): estimated tokens of the whole open conversation, counted offline with the bundled `o200k_base` tokenizer (gpt-tokenizer, MIT). Grok's real tokenizer is different, so treat the number as an approximation.
  - It works in both normal Grok chats and Grok Bot chats, and updates on new messages and navigation.
  - It is hidden on the empty home page.
- **Grok weekly (SuperGrok):** weekly usage % and reset time, from grok.com's `GetGrokCreditsConfig` API.
- **Grok Bot weekly:** usage % and reset time, fetched in the background over grok.com's own WebSocket (`wss://grok.com/ws/bot/`: hello frame `protocol_version 1.0.0`, then JSON-RPC `bot.usage`). It runs on page load and every 5 minutes, so you don't need to open the Usage page.
  - Fallback: values read from Settings > Usage. The reader works with both the English and the Vietnamese UI.
- Bars are blue while usage is low, amber from 75% and red from 90%. A thin black tick marks how much of the period has elapsed.
- Hover for the data source, the exact reset date/time and the last update time. Press ↻ to refresh.
- The strip switches to short labels in narrow composers and always stays on one row.
- UI labels follow the browser language (Vietnamese or English).

**Privacy:** the extension only talks to grok.com, using your existing session. No telemetry, no third-party requests. Data is stored locally in the browser only.

## Install
1. Download the `.zip` from a release and unzip it into a folder.
2. Open `chrome://extensions` (Edge: `edge://extensions`) and enable **Developer mode**.
3. Click **Load unpacked** and select the folder that contains `manifest.json`.
4. Open or reload https://grok.com.

**Update:** unzip the new version over the same folder, click ↻ on the extension card in `chrome://extensions`, then reload grok.com.

## Options (grok.com DevTools console)
- Token badge position: `localStorage.setItem('gtcBadgePos', 'strip' | 'right' | 'left')`, then reload. The default is `strip`.
- Debug logging, off by default: `localStorage.setItem('gtcDebug', '1')`, then reload. Filter the console by `[GTC-WS]`, `[GTC-NET]` or `[GTC-FIND]`. Turn it off with `localStorage.removeItem('gtcDebug')`.

## Releases
- **v0.6.3** (latest, with token counter): https://github.com/KeyMagic24711/grok-token-counter/releases/tag/v0.6.3
- **v0.5.2** (usage bars only, no token counter): https://github.com/KeyMagic24711/grok-token-counter/releases/tag/v0.5.2

## Limitations
- grok.com's APIs, WebSocket protocol and UI are internal and may change at any time. If they do, the strip shows "no data yet" or asks you to open Usage.

## Credits
- The usage strip and chip UI (bars, elapsed-time tick, composer anchoring) are adapted from **Claude Token Counter** by kr1shnasomani (MIT, see `LICENSE-claude-token-counter`).
- The credits endpoint and protobuf decoding are based on **Grok Usage Watch** by JoshuaWang2211 (MIT, see `LICENSE-grok-usage-watch`).
- Tokenizer: gpt-tokenizer `o200k_base` (MIT).

*Unofficial. Not affiliated with xAI.*
