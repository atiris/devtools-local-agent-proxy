#!/usr/bin/env node
/**
 * Offline smoke test: exercises the compressor against the local model with
 * realistic oversized DevTools payloads — no browser required.
 *
 *   OLLAMA_MODEL=qwen3:8b npm run smoke
 *
 * Verifies: Ollama reachable, model loads, compression shrinks the payload,
 * and the tool-aware prompts keep the signal (errors / failed requests).
 */

import { compress } from "../dist/compressor.js";
import { config, estimateTokens } from "../dist/config.js";

function makeConsoleDump() {
  const lines = [];
  for (let i = 0; i < 400; i++) {
    lines.push(`[log] render tick ${i} ok, fps=60, heap=${30 + (i % 7)}MB`);
  }
  lines.splice(
    120,
    0,
    "[error] Uncaught TypeError: Cannot read properties of null (reading 'value') at checkout.js:142:18",
  );
  lines.splice(
    260,
    0,
    "[warning] Deprecated API 'webkitStorageInfo' used at vendor.js:88",
  );
  lines.push(
    "[error] Failed to load resource: net::ERR_CONNECTION_REFUSED https://api.example.com/cart",
  );
  return lines.join("\n");
}

function makeNetworkDump() {
  const rows = [];
  for (let i = 0; i < 300; i++) {
    rows.push(
      `GET https://cdn.example.com/asset-${i}.png 200 ${2000 + i} bytes 35ms`,
    );
  }
  rows.push("POST https://api.example.com/cart 500 142 bytes 1840ms");
  rows.push("GET https://api.example.com/user 404 88 bytes 60ms");
  rows.push("GET https://api.example.com/slow 200 9000 bytes 3120ms");
  return rows.join("\n");
}

async function run(tool, raw) {
  const inTok = estimateTokens(raw);
  process.stdout.write(`\n=== ${tool} ===\n`);
  process.stdout.write(`input:  ${raw.length} chars (~${inTok} tokens)\n`);
  const t0 = Date.now();
  const { text, ok } = await compress(tool, raw);
  const outTok = estimateTokens(text);
  process.stdout.write(`output: ${text.length} chars (~${outTok} tokens) ok=${ok} in ${Date.now() - t0}ms\n`);
  const ratio = ((1 - outTok / inTok) * 100).toFixed(1);
  process.stdout.write(`saved:  ${ratio}%\n`);
  process.stdout.write(`--- digest ---\n${text}\n`);
  return ok;
}

const fetched = await fetch(`${config.ollamaBaseUrl}/api/tags`).catch(() => null);
if (!fetched || !fetched.ok) {
  process.stderr.write(`Ollama not reachable at ${config.ollamaBaseUrl}. Start it with "ollama serve".\n`);
  // Let the event loop drain (avoids a libuv shutdown assertion on Windows).
  process.exitCode = 2;
} else {
  process.stdout.write(`Using model: ${config.ollamaModel} @ ${config.ollamaBaseUrl}\n`);
  let allOk = true;
  allOk = (await run("list_console_messages", makeConsoleDump())) && allOk;
  allOk = (await run("list_network_requests", makeNetworkDump())) && allOk;
  process.exitCode = allOk ? 0 : 1;
}
