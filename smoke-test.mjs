#!/usr/bin/env node

/**
 * Smoke test for browser-run-mcp.
 *
 * Spins up the server over stdio, calls the `browser_run` tool with a small
 * navigate + title + close workflow, then reconnects and exercises
 * `close_browser_run` directly.
 *
 * Run with: CF_ACCOUNT_ID=... CF_API_TOKEN=... npm run smoke
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(here, "index.mjs");

async function main() {
  const transport = new StdioClientTransport({
    command: "node",
    args: [serverPath],
    env: {
      ...process.env,
      CF_ACCOUNT_ID: process.env.CF_ACCOUNT_ID,
      CF_API_TOKEN: process.env.CF_API_TOKEN,
    },
  });

  const client = new Client(
    { name: "smoke-test", version: "1.0.0" },
    { capabilities: {} },
  );

  await client.connect(transport);

  const tools = await client.listTools();
  console.log("tools:", tools.tools.map((t) => t.name));

  console.log("\n--- test 1: navigate + title + close ---");
  const r1 = await client.callTool({
    name: "browser_run",
    arguments: {
      code: `async (browser) => {
        await browser.navigate('https://example.com');
        const title = await browser.title();
        const url = await browser.url();
        await browser.close();
        return { title, url };
      }`,
    },
  });
  console.log("result:", JSON.stringify(r1, null, 2));

  console.log("\n--- test 2: reconnect + screenshot, then top-level close ---");
  const r2 = await client.callTool({
    name: "browser_run",
    arguments: {
      code: `async (browser) => {
        await browser.navigate('https://example.com');
        const shot = await browser.screenshot();
        return { bytes: shot.base64.length };
      }`,
    },
  });
  console.log("result:", JSON.stringify(r2, null, 2));

  const r3 = await client.callTool({ name: "close_browser_run", arguments: {} });
  console.log("close_browser_run:", JSON.stringify(r3, null, 2));

  await client.close();
  console.log("\ndone");
}

main().catch((err) => {
  console.error("Smoke test failed:", err);
  process.exit(1);
});
