#!/usr/bin/env node
/**
 * Full end-to-end test through a REAL browser.
 *
 * Spawns the proxy with compression ON, drives chrome-devtools-mcp to open a
 * page that logs ~600 console messages plus a real TypeError and a warning,
 * then calls list_console_messages and checks the response came back as a
 * compressed digest (not the raw dump). This exercises the entire path:
 * Claude → proxy → chrome-devtools-mcp → Chrome → qwen3.5:9b → digest.
 *
 *   OLLAMA_MODEL=qwen3.5:9b node scripts/e2e-browser.mjs
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const proxy = spawn("node", [join(root, "dist", "proxy.js")], {
  stdio: ["pipe", "pipe", "inherit"],
  env: { ...process.env, COMPRESSION_THRESHOLD_TOKENS: "500" },
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
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});

let id = 0;
function rpc(method, params) {
  const myId = ++id;
  return new Promise((resolve, reject) => {
    pending.set(myId, (m) => (m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result)));
    proxy.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: myId, method, params }) + "\n");
  });
}
const textOf = (r) => (r?.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");

const page = `<!doctype html><html><body><h1>e2e</h1><script>
for (let i = 0; i < 600; i++) console.log('render tick ' + i + ' fps=60 heap=30MB ok ok ok ok');
console.warn("Deprecated API 'webkitStorageInfo' used at vendor.js:88");
try { null.value; } catch (e) { console.error('Uncaught ' + e.stack.split('\\n')[0]); }
<\/script></body></html>`;
const dataUrl = "data:text/html," + encodeURIComponent(page);

const fail = (m) => { process.stderr.write(`E2E FAIL: ${m}\n`); proxy.kill(); process.exitCode = 1; };
const timeout = setTimeout(() => fail("timed out after 120s"), 120000);

try {
  await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "e2e", version: "0" } });
  proxy.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  process.stdout.write("opening page in Chrome...\n");
  await rpc("tools/call", { name: "new_page", arguments: { url: dataUrl } });
  // small settle so all console events register
  await new Promise((r) => setTimeout(r, 1500));

  process.stdout.write("calling list_console_messages through the proxy...\n");
  const res = await rpc("tools/call", { name: "list_console_messages", arguments: {} });
  const out = textOf(res);
  process.stdout.write(`\n--- response Claude would receive (${out.length} chars) ---\n${out}\n---\n`);

  const compressed = out.includes("[compressed by");
  const keptError = /TypeError|null/.test(out);
  process.stdout.write(`\ncompressed: ${compressed} | error preserved: ${keptError}\n`);
  clearTimeout(timeout);
  if (compressed && keptError) process.stdout.write("E2E OK\n");
  else fail(`expected a compressed digest that preserved the error (compressed=${compressed}, error=${keptError})`);
} catch (e) {
  clearTimeout(timeout);
  fail(e.message);
} finally {
  try { await rpc("tools/call", { name: "close_page", arguments: { pageIdx: 0 } }); } catch {}
  proxy.kill();
}
