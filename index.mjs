#!/usr/bin/env node

/**
 * Browser Run MCP Server
 *
 * A local MCP server that speaks raw CDP to Cloudflare Browser Run and
 * exposes a code-mode `browser_run` tool to the agent.
 *
 * Why this instead of chrome-devtools-mcp with --wsEndpoint?
 *
 *   1. Agent can explicitly end a session. `browser.close()` sends the
 *      CDP `Browser.close` command, which Cloudflare's Browser Run backend
 *      treats as a teardown signal. No more waiting out keep_alive after a
 *      one-shot task.
 *
 *   2. Hybrid session model. A session is created lazily on first call, kept
 *      across calls so pages and cookies persist for multi-step workflows,
 *      and uses a short keep_alive (30s) so forgotten sessions do not idle
 *      for 10 minutes.
 *
 *   3. Raw CDP. No Puppeteer, no Playwright. Direct WebSocket to the Browser
 *      Run CDP endpoint, JSON-RPC messages, so the agent's code can call
 *      anything in the CDP protocol.
 *
 *   4. Token-efficient. One tool (~1k tokens in the MCP handshake) instead of
 *      chrome-devtools-mcp's 29 tools (~7k tokens).
 *
 * Usage:
 *
 *   CF_ACCOUNT_ID=xxx CF_API_TOKEN=yyy node index.mjs
 *
 * Or wire it into an MCP client config, e.g. Claude Desktop:
 *
 *   {
 *     "mcpServers": {
 *       "browser-run": {
 *         "command": "node",
 *         "args": ["/absolute/path/to/browser-run-mcp/index.mjs"],
 *         "env": {
 *           "CF_ACCOUNT_ID": "...",
 *           "CF_API_TOKEN": "..."
 *         }
 *       }
 *     }
 *   }
 *
 * Note: the Cloudflare API path still uses the legacy "browser-rendering"
 * segment (`/accounts/{id}/browser-rendering/devtools/browser`). The product
 * was renamed to "Browser Run" but the API path remains unchanged for
 * backwards compatibility.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import WebSocket from "ws";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const CF_ACCOUNT_ID = process.env.CF_ACCOUNT_ID;
const CF_API_TOKEN = process.env.CF_API_TOKEN;

// Env vars: prefer BROWSER_RUN_* names, fall back to legacy BR_* for
// backwards compatibility.
const KEEP_ALIVE_MS = Number(
  process.env.BROWSER_RUN_KEEP_ALIVE_MS ??
    process.env.BR_KEEP_ALIVE_MS ??
    30_000,
);

const CDP_BASE_URL =
  process.env.BROWSER_RUN_CDP_URL ??
  process.env.BR_CDP_URL ??
  `wss://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/browser-rendering/devtools/browser`;

if (!CF_ACCOUNT_ID || !CF_API_TOKEN) {
  console.error(
    "browser-run-mcp: CF_ACCOUNT_ID and CF_API_TOKEN env vars are required",
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// CDP client
// ---------------------------------------------------------------------------

class CDPClient {
  #ws = null;
  #nextId = 1;
  #pending = new Map();
  #sessionTargets = new Map();
  #defaultSessionId = null;
  #eventListeners = [];
  #debugLog = [];

  get connected() {
    return this.#ws?.readyState === WebSocket.OPEN;
  }

  async connect() {
    if (this.connected) return;

    const url = `${CDP_BASE_URL}?keep_alive=${KEEP_ALIVE_MS}`;
    const ws = new WebSocket(url, {
      headers: { Authorization: `Bearer ${CF_API_TOKEN}` },
    });

    await new Promise((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });

    ws.on("message", (buf) => this.#onMessage(buf));
    ws.on("close", (code, reason) => {
      this.#onClose(code, reason?.toString?.() ?? "");
    });
    ws.on("error", (err) => {
      this.#log("ws-error", { error: err.message });
    });

    this.#ws = ws;
  }

  async send(method, params = {}, { sessionId } = {}) {
    await this.connect();
    const id = this.#nextId++;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    this.#log("send", { id, method, sessionId });
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject, method });
      this.#ws.send(JSON.stringify(msg));
    });
  }

  onEvent(filter, fn) {
    const entry = { ...filter, fn };
    this.#eventListeners.push(entry);
    return () => {
      const i = this.#eventListeners.indexOf(entry);
      if (i !== -1) this.#eventListeners.splice(i, 1);
    };
  }

  async ensurePageSession() {
    if (this.#defaultSessionId) return this.#defaultSessionId;

    const { targetInfos } = await this.send("Target.getTargets");
    let pageTarget = targetInfos.find(
      (t) => t.type === "page" && !t.url.startsWith("chrome://"),
    );

    let targetId;
    if (pageTarget) {
      targetId = pageTarget.targetId;
    } else {
      const created = await this.send("Target.createTarget", {
        url: "about:blank",
      });
      targetId = created.targetId;
    }

    const { sessionId } = await this.send("Target.attachToTarget", {
      targetId,
      flatten: true,
    });
    this.#defaultSessionId = sessionId;
    this.#sessionTargets.set(sessionId, targetId);
    return sessionId;
  }

  async close() {
    if (!this.connected) return;
    try {
      await this.send("Browser.close").catch(() => {});
    } finally {
      try {
        this.#ws.close(1000, "browser-run-mcp: close");
      } catch {}
      this.#ws = null;
      this.#defaultSessionId = null;
      this.#sessionTargets.clear();
      for (const { reject, method } of this.#pending.values()) {
        reject(new Error(`CDP connection closed during ${method}`));
      }
      this.#pending.clear();
    }
  }

  getDebugLog(limit = 50) {
    return this.#debugLog.slice(-limit);
  }

  #onMessage(buf) {
    let data;
    try {
      data = JSON.parse(buf.toString("utf-8"));
    } catch (err) {
      this.#log("parse-error", { error: err.message });
      return;
    }

    if (data.id != null) {
      const pending = this.#pending.get(data.id);
      if (!pending) return;
      this.#pending.delete(data.id);
      if (data.error) {
        const err = new Error(
          `CDP error: ${data.error.message} (code ${data.error.code})`,
        );
        err.cdpError = data.error;
        pending.reject(err);
      } else {
        pending.resolve(data.result ?? {});
      }
      return;
    }

    this.#log("event", { method: data.method, sessionId: data.sessionId });
    for (const { method, sessionId, fn } of this.#eventListeners) {
      if (method && method !== data.method) continue;
      if (sessionId && sessionId !== data.sessionId) continue;
      try {
        fn(data);
      } catch (err) {
        this.#log("listener-error", { error: err.message });
      }
    }
  }

  #onClose(code, reason) {
    this.#log("ws-close", { code, reason });
    this.#ws = null;
    this.#defaultSessionId = null;
    for (const { reject, method } of this.#pending.values()) {
      reject(new Error(`CDP WS closed (${code}): ${reason} — during ${method}`));
    }
    this.#pending.clear();
  }

  #log(type, data) {
    this.#debugLog.push({ at: new Date().toISOString(), type, ...data });
    if (this.#debugLog.length > 500) this.#debugLog.splice(0, 100);
  }
}

const cdp = new CDPClient();

// ---------------------------------------------------------------------------
// Browser API
// ---------------------------------------------------------------------------

function createBrowserAPI() {
  return {
    async send(method, params, opts = {}) {
      const sessionId = opts.sessionId ?? (await cdp.ensurePageSession());
      return cdp.send(method, params, { sessionId });
    },

    async sendBrowser(method, params) {
      return cdp.send(method, params);
    },

    async navigate(url, { waitUntil = "load", timeoutMs = 30_000 } = {}) {
      const sessionId = await cdp.ensurePageSession();
      await cdp.send("Page.enable", {}, { sessionId });
      const done = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          unsubscribe();
          reject(new Error(`navigate: timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        const unsubscribe = cdp.onEvent(
          {
            method:
              waitUntil === "domcontentloaded"
                ? "Page.domContentEventFired"
                : "Page.loadEventFired",
            sessionId,
          },
          () => {
            clearTimeout(timer);
            unsubscribe();
            resolve();
          },
        );
      });
      await cdp.send("Page.navigate", { url }, { sessionId });
      await done;
      return { url };
    },

    async reload({ ignoreCache = false } = {}) {
      const sessionId = await cdp.ensurePageSession();
      return cdp.send("Page.reload", { ignoreCache }, { sessionId });
    },

    async evaluate(expression, { returnByValue = true, awaitPromise = true } = {}) {
      const sessionId = await cdp.ensurePageSession();
      const { result, exceptionDetails } = await cdp.send(
        "Runtime.evaluate",
        { expression, returnByValue, awaitPromise },
        { sessionId },
      );
      if (exceptionDetails) {
        const text =
          exceptionDetails.exception?.description ??
          exceptionDetails.text ??
          "unknown evaluation error";
        throw new Error(`evaluate: ${text}`);
      }
      return result.value;
    },

    async title() {
      return this.evaluate("document.title");
    },

    async url() {
      return this.evaluate("location.href");
    },

    async content() {
      return this.evaluate("document.documentElement.outerHTML");
    },

    async screenshot({ format = "png", quality, fullPage = false } = {}) {
      const sessionId = await cdp.ensurePageSession();
      const params = { format };
      if (quality != null && format === "jpeg") params.quality = quality;
      if (fullPage) params.captureBeyondViewport = true;
      const { data } = await cdp.send(
        "Page.captureScreenshot",
        params,
        { sessionId },
      );
      return { format, base64: data };
    },

    async click(selector, { button = "left", clickCount = 1 } = {}) {
      const sessionId = await cdp.ensurePageSession();
      const { result } = await cdp.send(
        "Runtime.evaluate",
        {
          expression: `(() => {
            const el = document.querySelector(${JSON.stringify(selector)});
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
          })()`,
          returnByValue: true,
        },
        { sessionId },
      );
      if (!result?.value) {
        throw new Error(`click: element not found for selector ${selector}`);
      }
      const { x, y } = result.value;
      await cdp.send(
        "Input.dispatchMouseEvent",
        { type: "mousePressed", x, y, button, clickCount },
        { sessionId },
      );
      await cdp.send(
        "Input.dispatchMouseEvent",
        { type: "mouseReleased", x, y, button, clickCount },
        { sessionId },
      );
      return { clicked: selector };
    },

    async type(text, { delay = 0 } = {}) {
      const sessionId = await cdp.ensurePageSession();
      for (const ch of text) {
        await cdp.send(
          "Input.dispatchKeyEvent",
          { type: "char", text: ch },
          { sessionId },
        );
        if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      }
      return { typed: text.length };
    },

    async close() {
      await cdp.close();
      return { closed: true };
    },

    connected() {
      return cdp.connected;
    },

    debugLog(limit = 50) {
      return cdp.getDebugLog(limit);
    },
  };
}

// ---------------------------------------------------------------------------
// Code executor
// ---------------------------------------------------------------------------

async function executeCode(code) {
  const browser = createBrowserAPI();
  let fn;
  try {
    fn = new Function("browser", `return (${code})(browser);`);
  } catch {
    fn = new Function(
      "browser",
      `return (async (browser) => { ${code} })(browser);`,
    );
  }
  return fn(browser);
}

// ---------------------------------------------------------------------------
// MCP server
// ---------------------------------------------------------------------------

const TOOL_DESCRIPTION = `Control a Cloudflare Browser Run session. Write an async JS arrow function that receives a \`browser\` object.

The Browser Run session is created lazily on the first call and persists across calls, so cookies and page state survive between invocations. Always call \`browser.close()\` when you are done — otherwise the session idles until the keep_alive timeout (30s by default) expires.

## Methods

### Navigation
browser.navigate(url, { waitUntil? = 'load' | 'domcontentloaded', timeoutMs? })
browser.reload({ ignoreCache? })

### Inspection
browser.evaluate(expression, { returnByValue?, awaitPromise? }) — run JS in the page
browser.title() / browser.url() / browser.content()
browser.screenshot({ format? = 'png' | 'jpeg', quality?, fullPage? })

### Input
browser.click(selector, { button?, clickCount? })
browser.type(text, { delay? })

### Lifecycle
browser.close() — send CDP Browser.close, tear down the remote session now
browser.connected() — is the WS still open?
browser.debugLog(limit?) — recent CDP traffic for debugging

### Raw CDP (escape hatch)
browser.send(method, params, { sessionId? }) — target-scoped command
browser.sendBrowser(method, params) — browser-scoped command (Browser.*, Target.*)

## Example

async (browser) => {
  await browser.navigate('https://example.com');
  const title = await browser.title();
  const shot = await browser.screenshot();
  await browser.close();
  return { title, screenshotBytes: shot.base64.length };
}`;

async function main() {
  const server = new McpServer({
    name: "browser-run-mcp",
    version: "1.0.0",
  });

  server.tool(
    "browser_run",
    TOOL_DESCRIPTION,
    {
      code: z
        .string()
        .describe(
          "Async JS arrow function receiving `browser`. Return any JSON-serialisable value.",
        ),
    },
    async ({ code }) => {
      try {
        const result = await executeCode(code);
        const text =
          result === undefined
            ? "(no return value)"
            : typeof result === "string"
              ? result
              : JSON.stringify(result, null, 2);
        return { content: [{ type: "text", text }] };
      } catch (error) {
        const msg = error instanceof Error ? error.stack || error.message : String(error);
        return {
          content: [{ type: "text", text: `Error: ${msg}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "close_browser_run",
    "Immediately tear down the current Browser Run session by sending CDP Browser.close. Safe to call if no session is open.",
    {},
    async () => {
      await cdp.close();
      return { content: [{ type: "text", text: "Session closed." }] };
    },
  );

  const shutdown = async () => {
    try {
      await cdp.close();
    } catch {}
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
