#!/usr/bin/env node
/**
 * devtools-local-agent-proxy
 *
 * A transparent stdio MCP proxy that sits between Claude Code and
 * chrome-devtools-mcp. It forwards every tool call to the real server, then
 * intercepts oversized responses from read-only diagnostic tools and replaces
 * them with a compact digest produced by a local Ollama model — keeping
 * Claude's context window small during browser e2e testing.
 *
 * Claude Code only ever sees this proxy; the tool names and schemas are
 * identical to the upstream server (optionally filtered by an allow-list).
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";

import { config, estimateTokens, log } from "./config.js";
import { compress } from "./compressor.js";
import { ResponseCache } from "./cache.js";
import {
  transformScreenshotTool,
  upstreamScreenshotArgs,
  optimizeScreenshotResult,
  enforceImageCap,
  elementScreenshotTool,
  takeElementScreenshot,
  ELEMENT_SCREENSHOT_TOOL,
} from "./screenshot.js";
import {
  transformConsoleTool,
  consoleUpstreamArgs,
  transformNetworkTool,
  filterNetworkResult,
} from "./diagnostics.js";

const SCREENSHOT_TOOL = "take_screenshot";
const CONSOLE_TOOL = "list_console_messages";
const NETWORK_TOOL = "list_network_requests";

const cache = new ResponseCache(config.cacheTtlMs, config.cacheMaxEntries);

/** Join the text parts of a tool result; returns "" if there is no text. */
function textOf(result: CallToolResult): string {
  if (!Array.isArray(result.content)) return "";
  return result.content
    .map((c) => (c.type === "text" ? c.text : ""))
    .join("\n");
}

/** Does this result carry non-text content (e.g. an image) we must preserve? */
function hasNonText(result: CallToolResult): boolean {
  if (!Array.isArray(result.content)) return false;
  return result.content.some((c) => c.type !== "text");
}

async function main(): Promise<void> {
  // 1. Spawn and connect to the upstream chrome-devtools-mcp.
  log(`starting upstream: ${config.upstreamCommand} ${config.upstreamArgs.join(" ")}`);
  const upstreamTransport = new StdioClientTransport({
    command: config.upstreamCommand,
    args: config.upstreamArgs,
    // Inherit env so chrome-devtools-mcp finds Chrome, etc.
    env: process.env as Record<string, string>,
  });
  const upstream = new Client({ name: "devtools-proxy-client", version: "0.1.0" });
  await upstream.connect(upstreamTransport);

  // 2. Discover upstream tools, apply optional allow-list.
  const { tools: allTools } = await upstream.listTools();
  let tools: Tool[] = allTools;
  if (config.allowedTools.length > 0) {
    const allow = new Set(config.allowedTools);
    tools = allTools.filter((t) => allow.has(t.name));
    log(
      `tool allow-list active: exposing ${tools.length}/${allTools.length} tools ` +
        `(${tools.map((t) => t.name).join(", ")})`,
    );
  } else {
    log(`exposing all ${tools.length} upstream tools`);
  }
  // Rewrite take_screenshot so Claude must declare a focus region and the proxy
  // can return a cropped, downscaled WebP instead of a full-resolution PNG, and
  // add the synthetic take_element_screenshot tool.
  if (config.optimizeScreenshots) {
    tools = tools.map((t) => (t.name === SCREENSHOT_TOOL ? transformScreenshotTool(t) : t));
    if (!tools.some((t) => t.name === ELEMENT_SCREENSHOT_TOOL)) {
      tools = [...tools, elementScreenshotTool()];
    }
  }
  // Rewrite the firehose list tools so they default to high-signal rows only.
  if (config.optimizeDiagnostics) {
    tools = tools.map((t) =>
      t.name === CONSOLE_TOOL
        ? transformConsoleTool(t)
        : t.name === NETWORK_TOOL
          ? transformNetworkTool(t)
          : t,
    );
  }

  const exposed = new Set(tools.map((t) => t.name));

  // 3. Build the proxy server advertising the same (filtered) tools.
  const server = new Server(
    { name: "devtools-local-agent-proxy", version: "0.4.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    if (config.allowedTools.length > 0 && !exposed.has(name)) {
      return {
        isError: true,
        content: [{ type: "text", text: `Tool "${name}" is not exposed by this proxy.` }],
      };
    }

    // Element screenshot: synthetic tool — resolve the uid's geometry, take a
    // full-page shot, and return just the padded element. Never forwarded.
    if (config.optimizeScreenshots && name === ELEMENT_SCREENSHOT_TOOL) {
      return takeElementScreenshot(
        (n, a) => upstream.callTool({ name: n, arguments: a }) as Promise<CallToolResult>,
        args,
      );
    }

    // Focused screenshots: drive a lossless PNG from upstream, then crop +
    // downscale + WebP-encode locally so the image stays cheap in tokens.
    if (name === SCREENSHOT_TOOL) {
      const result = (await upstream.callTool({
        name,
        arguments: config.optimizeScreenshots ? upstreamScreenshotArgs(args) : args,
      })) as CallToolResult;
      if (result.isError) return result;
      // Optimize (which includes the cap) when on; otherwise still enforce the
      // hard per-side cap so the model never receives an oversized image.
      return config.optimizeScreenshots
        ? optimizeScreenshotResult(result, args)
        : enforceImageCap(result);
    }

    // Console: translate the severity band into upstream's native `types`
    // filter so only the requested levels (default warn..error) come back.
    const upstreamArgs =
      config.optimizeDiagnostics && name === CONSOLE_TOOL ? consoleUpstreamArgs(args) : args;

    // Forward to upstream.
    let result = (await upstream.callTool({
      name,
      arguments: upstreamArgs,
    })) as CallToolResult;

    // Network: upstream cannot filter by status, so narrow the result to the
    // requested status band (default 400..599) here before anything else.
    if (config.optimizeDiagnostics && name === NETWORK_TOOL && !result.isError) {
      result = filterNetworkResult(result, args);
    }

    // Decide whether to compress.
    const compressible =
      !config.disableCompression &&
      config.compressibleTools.has(name) &&
      !result.isError;

    if (!compressible) return result;

    const rawText = textOf(result);
    const tokens = estimateTokens(rawText);
    if (tokens <= config.compressionThresholdTokens) {
      return result; // small enough — pass through
    }

    // Cache check (keyed by tool + args).
    const cacheKey = cache.key(name, args);
    const cached = cache.get(cacheKey);
    if (cached) {
      log(`cache hit for ${name} (${tokens} tokens saved)`);
      return wrap(cached, result);
    }

    // Compress with the local model.
    log(`compressing ${name}: ~${tokens} tokens over threshold`);
    const { text } = await compress(name, rawText);
    cache.set(cacheKey, text);
    return wrap(text, result);
  });

  // 4. Serve on stdio.
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log("proxy running on stdio");
}

/**
 * Re-wrap a (compressed) text payload, preserving any non-text content (such
 * as screenshots) that lived alongside it in the original result.
 */
function wrap(text: string, original: CallToolResult): CallToolResult {
  const nonText = hasNonText(original)
    ? original.content.filter((c) => c.type !== "text")
    : [];
  return {
    ...original,
    content: [{ type: "text", text }, ...nonText],
  };
}

main().catch((err) => {
  process.stderr.write(
    `[devtools-proxy] fatal: ${err instanceof Error ? err.stack : String(err)}\n`,
  );
  process.exit(1);
});
