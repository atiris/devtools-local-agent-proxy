#!/usr/bin/env node
/**
 * MCP protocol handshake test. Spawns the built proxy exactly as Claude Code
 * would, performs `initialize`, then `tools/list`, and prints the tool count.
 * This proves the proxy stands up, launches chrome-devtools-mcp, and forwards
 * the real tool schemas — without needing Claude Code in the loop.
 *
 * Note: the first run downloads chrome-devtools-mcp (and may launch Chrome),
 * so allow up to a minute. Compression is disabled here — we only test wiring.
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const proxy = spawn("node", [join(root, "dist", "proxy.js")], {
  stdio: ["pipe", "pipe", "inherit"],
  env: { ...process.env, DISABLE_COMPRESSION: "true" },
});

let buffer = "";
const pending = new Map();

proxy.stdout.on("data", (chunk) => {
  buffer += chunk.toString();
  let nl;
  while ((nl = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});

function rpc(id, method, params) {
  return new Promise((resolve) => {
    pending.set(id, resolve);
    proxy.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

const fail = (m) => {
  process.stderr.write(`HANDSHAKE FAIL: ${m}\n`);
  proxy.kill();
  process.exitCode = 1;
};

const timeout = setTimeout(() => fail("timed out after 90s"), 90000);

try {
  const init = await rpc(1, "initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "handshake-test", version: "0.0.0" },
  });
  if (init.error) throw new Error(`initialize: ${JSON.stringify(init.error)}`);
  process.stdout.write(`initialize OK — server: ${init.result?.serverInfo?.name}\n`);

  proxy.stdin.write(
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n",
  );

  const list = await rpc(2, "tools/list", {});
  if (list.error) throw new Error(`tools/list: ${JSON.stringify(list.error)}`);
  const tools = list.result?.tools ?? [];
  process.stdout.write(`tools/list OK — ${tools.length} tools forwarded\n`);
  process.stdout.write(`first few: ${tools.slice(0, 6).map((t) => t.name).join(", ")}\n`);
  if (tools.length === 0) throw new Error("no tools forwarded");
  clearTimeout(timeout);
  process.stdout.write("HANDSHAKE OK\n");
} catch (e) {
  clearTimeout(timeout);
  fail(e.message);
} finally {
  proxy.kill();
}
