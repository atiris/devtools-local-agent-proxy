#!/usr/bin/env node
/**
 * End-to-end test for take_element_screenshot through a REAL browser.
 *
 * Opens a tall page with a red button placed BELOW the fold, finds its uid via
 * take_snapshot, then calls take_element_screenshot and verifies the returned
 * WebP is (a) element-sized, not page-sized, and (b) predominantly the button's
 * red — proving the uid→coordinate→crop math is correct, including dpr.
 *
 *   node scripts/e2e-element.mjs
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import sharp from "sharp";

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
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
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
const imageOf = (r) => (r?.content ?? []).find((c) => c.type === "image");

const page = `<!doctype html><html><body style="margin:0;background:#fff;height:3000px">
<button id="target" style="position:absolute;left:300px;top:1500px;width:200px;height:100px;background:#e00;color:#fff;border:0">TARGETBOX</button>
</body></html>`;
const dataUrl = "data:text/html," + encodeURIComponent(page);

const fail = (m) => { process.stderr.write(`E2E FAIL: ${m}\n`); proxy.kill(); process.exitCode = 1; };
const timeout = setTimeout(() => fail("timed out after 120s"), 120000);

try {
  await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "e2e", version: "0" } });
  proxy.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  process.stdout.write("opening tall page in Chrome...\n");
  await rpc("tools/call", { name: "new_page", arguments: { url: dataUrl } });
  await new Promise((r) => setTimeout(r, 800));

  const snap = await rpc("tools/call", { name: "take_snapshot", arguments: {} });
  const snapText = textOf(snap);
  // Match the button node specifically — the RootWebArea line echoes the data
  // URL, which also contains the literal text "TARGETBOX".
  const line = snapText.split("\n").find((l) => /button "TARGETBOX"/.test(l));
  if (!line) fail(`no TARGETBOX button in snapshot:\n${snapText.slice(0, 500)}`);
  const uid = line?.match(/uid=(\S+)/)?.[1];
  if (!uid) fail(`could not parse uid from: ${line}`);
  process.stdout.write(`target uid=${uid}\n`);

  const res = await rpc("tools/call", { name: "take_element_screenshot", arguments: { uid, padding: 10 } });
  const note = textOf(res);
  process.stdout.write(`note: ${note}\n`);
  const img = imageOf(res);
  if (!img) fail(`no image returned: ${note}`);

  const buf = Buffer.from(img.data, "base64");
  const meta = await sharp(buf).metadata();
  const stats = await sharp(buf).stats();
  const [r, g, b] = stats.channels.map((c) => c.mean);
  process.stdout.write(`image: ${meta.format} ${meta.width}x${meta.height}, mean RGB=(${r.toFixed(0)},${g.toFixed(0)},${b.toFixed(0)})\n`);

  const ratio = meta.width / meta.height;             // element is 200x100 (+padding) → ~1.83
  const elementSized = meta.width >= 150 && meta.width <= 1024 && ratio > 1.5 && ratio < 2.2;
  const mostlyRed = r > 180 && r - g > 90 && r - b > 90;
  const isWebp = meta.format === "webp";

  clearTimeout(timeout);
  process.stdout.write(`webp=${isWebp} element-sized=${elementSized} mostly-red=${mostlyRed}\n`);
  if (isWebp && elementSized && mostlyRed) process.stdout.write("E2E ELEMENT OK\n");
  else fail(`expected an element-sized red webp (webp=${isWebp}, sized=${elementSized}, red=${mostlyRed})`);
} catch (e) {
  clearTimeout(timeout);
  fail(e.message);
} finally {
  try { await rpc("tools/call", { name: "close_page", arguments: { pageIdx: 0 } }); } catch {}
  proxy.kill();
}
