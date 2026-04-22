# Browser Run MCP

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

An [MCP](https://modelcontextprotocol.io) server that gives AI agents direct, code-mode control over [Cloudflare Browser Run](https://developers.cloudflare.com/browser-run/) sessions.

The big idea: **one tool, raw CDP, explicit lifecycle control.** Instead of 29 browser tools cluttering the agent's context, the agent writes a small async JS function. Instead of sessions idling for 10 minutes because there's no close affordance, `browser.close()` tears the remote browser down immediately.

<p align="center">
  <img src="assets/diagram.svg" alt="Architecture: AI Agent → browser-run-mcp → Cloudflare Browser Run → Target Website, with animated packet flow and a dedicated browser.close() teardown path" width="880">
</p>

## Why this exists

The [official docs](https://developers.cloudflare.com/browser-run/cdp/mcp-clients/) suggest running [`chrome-devtools-mcp`](https://github.com/ChromeDevTools/chrome-devtools-mcp) locally with `--wsEndpoint` pointed at Browser Run. That works, but has two ergonomic problems:

1. **No way to end a session.** `chrome-devtools-mcp` holds the WebSocket open for the lifetime of the MCP server process, and there is no agent-invokable `Browser.close` tool. Your Browser Run session stays alive until the `keep_alive` timer (default 10 min) expires.
2. **29 tools in the agent's context** (~7k tokens), many of which duplicate what a small block of JS could do.

This server fixes both:

- **Agent-controllable lifecycle.** `browser.close()` sends the CDP `Browser.close` command. Cloudflare's CDP backend treats that as a teardown signal, so the remote session goes away immediately.
- **Short default `keep_alive` (30s)** so forgotten sessions do not idle for 10 min.
- **One tool** (~1k tokens) exposing a `browser` object in code-mode. The agent writes a small async arrow function, the server runs it, and it gets back whatever the function returns.
- **Raw CDP.** No Puppeteer, no Playwright. The `browser.send(method, params)` escape hatch lets the agent call any CDP command directly.

## Requirements

- Node.js 20 or newer
- A Cloudflare API token with **Browser Rendering – Edit** permission. [Create one here](https://dash.cloudflare.com/profile/api-tokens) using the template of that name.
- Your Cloudflare [account ID](https://dash.cloudflare.com/) (top-right of any account page).

> The token permission is still named "Browser Rendering – Edit" in the Cloudflare dashboard even though the product is now called Browser Run. The API path (`/browser-rendering/devtools/browser`) is similarly unchanged.

## Install

Clone and install locally — this is not a published npm package.

```bash
git clone https://github.com/jonnyparris/browser-run-mcp.git
cd browser-run-mcp
npm install
```

Note the absolute path — you will need it for your MCP client config:

```bash
pwd
# e.g. /Users/you/dev/browser-run-mcp
```

## Wire into your MCP client

Replace `/absolute/path/to/browser-run-mcp` with the output of `pwd` above.

### Claude Desktop / Claude Code

`claude_desktop_config.json` or `~/.claude.json`:

```json
{
  "mcpServers": {
    "browser-run": {
      "command": "node",
      "args": ["/absolute/path/to/browser-run-mcp/index.mjs"],
      "env": {
        "CF_ACCOUNT_ID": "your-account-id",
        "CF_API_TOKEN": "your-api-token"
      }
    }
  }
}
```

### OpenCode

`~/.config/opencode/opencode.jsonc`:

```jsonc
{
  "mcp": {
    "browser-run": {
      "type": "local",
      "command": ["node", "/absolute/path/to/browser-run-mcp/index.mjs"],
      "env": {
        "CF_ACCOUNT_ID": "your-account-id",
        "CF_API_TOKEN": "your-api-token"
      },
      "enabled": true
    }
  }
}
```

### Cursor

`~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "browser-run": {
      "command": "node",
      "args": ["/absolute/path/to/browser-run-mcp/index.mjs"],
      "env": {
        "CF_ACCOUNT_ID": "your-account-id",
        "CF_API_TOKEN": "your-api-token"
      }
    }
  }
}
```

## How it works

The server exposes two MCP tools:

### `browser_run`

The main tool. The agent passes a string of JavaScript — an async arrow function that receives a `browser` object:

```js
async (browser) => {
  await browser.navigate('https://example.com');
  const title = await browser.title();
  const shot = await browser.screenshot();
  await browser.close();  // tear down the remote session immediately
  return { title, screenshotBytes: shot.base64.length };
}
```

The `browser` object API:

| Method | Description |
| --- | --- |
| `navigate(url, { waitUntil?, timeoutMs? })` | Load a URL. `waitUntil` is `'load'` (default) or `'domcontentloaded'`. |
| `reload({ ignoreCache? })` | Reload the current page. |
| `evaluate(expression, { returnByValue?, awaitPromise? })` | Run JS in the page. |
| `title()` / `url()` / `content()` | Get page metadata. |
| `screenshot({ format?, quality?, fullPage? })` | Capture screenshot. Defaults to `format: 'jpeg'`, `quality: 75` — see [Screenshot safety](#screenshot-safety) below. Returns `{ format, base64 }`. |
| `screenshotPng({ fullPage? })` | Explicit lossless PNG opt-in. See [Screenshot safety](#screenshot-safety). |
| `click(selector, { button?, clickCount? })` | Click via CSS selector. |
| `type(text, { delay? })` | Type text into the focused element. |
| `close()` | **Send CDP `Browser.close`, end the Browser Run session immediately.** |
| `connected()` | Boolean — is the CDP WebSocket open? |
| `debugLog(limit?)` | Recent CDP traffic for debugging. |
| `send(method, params, { sessionId? })` | Raw target-scoped CDP command. |
| `sendBrowser(method, params)` | Raw browser-scoped CDP command (`Browser.*`, `Target.*`). |

### `close_browser_run`

A top-level escape hatch. If the agent loses track of state and cannot invoke `browser.close()` inside code, calling this tool directly tears the session down. Safe to call if no session is open.

## Screenshot safety

When this MCP is consumed by an LLM agent, screenshot size matters a lot. `screenshot()` defaults to **JPEG quality 75** because:

- PNG is lossless and uncompressed. A full-page PNG of a typical 1280px page is routinely **3–7 MB**.
- Many MCP clients (including Claude Desktop) silently save images **≥ 2 MB** to disk and hand the model only a file path. The model never sees the image.
- Claude's API rejects inline base64 content **≥ 5 MB** with a hard error. If this happens inside an agent loop, **the session is permanently unrecoverable** — compaction doesn't save you because it replays the same attachments.

JPEG at quality 75 is typically 90%+ smaller than the equivalent PNG with no perceptible difference for page inspection.

```js
// Safe default
await browser.screenshot();                            // JPEG q75
await browser.screenshot({ fullPage: true });          // JPEG q75, full page

// Override quality if JPEG q75 still exceeds 2 MB
await browser.screenshot({ quality: 50 });

// Explicit opt-in to PNG (small viewports only)
await browser.screenshotPng();
await browser.screenshot({ format: "png" });
```

Credit to [zeke/faster-chrome-devtools-skill](https://github.com/zeke/faster-chrome-devtools-skill) for documenting this failure mode.

## Session lifecycle

```
First browser_run call → Lazy-connect to Browser Run CDP endpoint → Page session created
Subsequent calls       → Reuse existing WebSocket                 → State persists
browser.close()        → Send Browser.close CDP command           → Server tears down immediately
Agent forgets to close → Idle timeout (30s default)               → Auto-cleanup by the backend
```

## Environment variables

| Variable | Default | Notes |
| --- | --- | --- |
| `CF_ACCOUNT_ID` | **required** | Your Cloudflare account ID. |
| `CF_API_TOKEN` | **required** | Token with **Browser Rendering – Edit** permission. |
| `BROWSER_RUN_KEEP_ALIVE_MS` | `30000` | Idle timeout. Shorter = less waste if the agent forgets to close. (Legacy: `BR_KEEP_ALIVE_MS`.) |
| `BROWSER_RUN_CDP_URL` | `wss://api.cloudflare.com/client/v4/accounts/{id}/browser-rendering/devtools/browser` | Override for staging or custom CDP proxies. (Legacy: `BR_CDP_URL`.) |

## Comparison

|  | `chrome-devtools-mcp` + `--wsEndpoint` | This server |
| --- | --- | --- |
| Tool count | 29 | 2 (`browser_run`, `close_browser_run`) |
| Agent can end session | No | Yes, `browser.close()` |
| Default idle before teardown | 10 min | 30 sec |
| Raw CDP access | No | Yes, `browser.send()` |
| Context size | ~7k tokens | ~1k tokens |

## Troubleshooting

**`Unexpected server response: 401`** — your API token does not have Browser Rendering – Edit permission. Create a new token using that template.

**`Unexpected server response: 429`** — you have hit the Browser Run concurrent session limit for your account. Close other sessions or wait.

**Session stays alive after the agent finishes** — make sure the agent calls `browser.close()` at the end of each workflow, or invoke `close_browser_run` directly. If that is not possible, lower `BROWSER_RUN_KEEP_ALIVE_MS`.

## Development

Run the smoke test against live Browser Run to verify the server works end-to-end:

```bash
CF_ACCOUNT_ID=... CF_API_TOKEN=... npm run smoke
```

## License

MIT
