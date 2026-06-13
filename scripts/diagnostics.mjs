#!/usr/bin/env node
/**
 * Offline test for the diagnostic list optimizers (no browser, no model).
 *
 *   npm run build && node scripts/diagnostics.mjs
 */

import {
  levelsToTypes,
  transformConsoleTool,
  consoleUpstreamArgs,
  transformNetworkTool,
  filterNetworkResult,
} from "../dist/diagnostics.js";

let failures = 0;
const check = (cond, msg) => {
  process.stdout.write(`${cond ? "ok  " : "FAIL"} ${msg}\n`);
  if (!cond) failures++;
};

// --- console severity band ------------------------------------------------
const def = levelsToTypes("warn", "error");
check(def.includes("warn") && def.includes("error") && def.includes("assert"), "default band has warn+error+assert");
check(!def.includes("log") && !def.includes("info") && !def.includes("debug"), "default band excludes info/log/debug");

const all = levelsToTypes("debug", "error");
check(all.includes("debug") && all.includes("log") && all.includes("warn") && all.includes("error"), "debug..error covers all buckets");

const reversed = levelsToTypes("error", "warn");
check(reversed.includes("warn") && reversed.includes("error"), "reversed min/max is normalized");

const cTool = transformConsoleTool({
  name: "list_console_messages",
  description: "List all console messages.",
  inputSchema: { type: "object", properties: { types: {}, pageSize: {} } },
});
check(!!cTool.inputSchema.properties.minLevel && !!cTool.inputSchema.properties.maxLevel, "minLevel/maxLevel added to console schema");
check(!!cTool.inputSchema.properties.pageSize, "upstream pageSize preserved");

const cArgsDefault = consoleUpstreamArgs({});
check(Array.isArray(cArgsDefault.types) && cArgsDefault.types.includes("error") && !cArgsDefault.types.includes("log"), "omitted band -> default warn..error types");
check(cArgsDefault.minLevel === undefined, "proxy-only minLevel stripped from upstream args");

const cArgsExplicit = consoleUpstreamArgs({ types: ["log"] });
check(cArgsExplicit.types.length === 1 && cArgsExplicit.types[0] === "log", "explicit types override honored");

const cArgsWide = consoleUpstreamArgs({ minLevel: "info" });
check(cArgsWide.types.includes("info") && cArgsWide.types.includes("warn"), "minLevel:info widens to info..error");

// --- network status band --------------------------------------------------
const nTool = transformNetworkTool({
  name: "list_network_requests",
  description: "List all requests.",
  inputSchema: { type: "object", properties: { resourceTypes: {}, pageSize: {} } },
});
check(!!nTool.inputSchema.properties.statusMin && !!nTool.inputSchema.properties.statusMax, "statusMin/statusMax added to network schema");
check(!!nTool.inputSchema.properties.resourceTypes, "upstream resourceTypes preserved");

const netText = [
  "## Network requests",
  "Showing 1-6 of 6 (Page 1 of 1).",
  "reqid=1 GET https://cdn.x/a.png [200]",
  "reqid=2 GET https://cdn.x/b.css [200]",
  "reqid=3 POST https://api.x/cart [500]",
  "reqid=4 GET https://api.x/user [404]",
  "reqid=5 GET https://api.x/img [302]",
  "reqid=6 GET https://api.x/down [net::ERR_CONNECTION_REFUSED]",
].join("\n");
const makeNet = () => ({ content: [{ type: "text", text: netText }] });

const defNet = filterNetworkResult(makeNet(), {});
const defOut = defNet.content[0].text;
check(defOut.includes("[500]") && defOut.includes("[404]"), "default keeps 4xx/5xx");
check(!defOut.includes("[200]") && !defOut.includes("[302]"), "default drops 2xx/3xx");
check(defOut.includes("net::ERR_CONNECTION_REFUSED"), "default keeps failed (non-numeric) request");
check(/2 of 6|3 of 6/.test(defOut), "header reports kept/total");

const allNet = filterNetworkResult(makeNet(), { statusMin: 0, statusMax: 599 });
const allOut = allNet.content[0].text;
check(allOut.includes("[200]") && allOut.includes("[302]") && allOut.includes("[500]"), "0-599 keeps everything");

const serverErr = filterNetworkResult(makeNet(), { statusMin: 500, statusMax: 599 });
const seOut = serverErr.content[0].text;
check(seOut.includes("[500]") && !seOut.includes("[404]"), "500-599 keeps only server errors");

const okOnly = filterNetworkResult(makeNet(), { statusMin: 200, statusMax: 299 });
const okOut = okOnly.content[0].text;
check(okOut.includes("[200]") && !okOut.includes("net::ERR"), "2xx-only excludes failures");

const empty = filterNetworkResult({ content: [{ type: "text", text: "## Network requests\nNo requests found." }] }, {});
check(empty.content[0].text.includes("No requests found"), "empty listing passed through");

process.stdout.write(failures ? `\n${failures} CHECK(S) FAILED\n` : "\nALL CHECKS PASSED\n");
process.exit(failures ? 1 : 0);
