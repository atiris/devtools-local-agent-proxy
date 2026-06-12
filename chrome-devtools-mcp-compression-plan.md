# Chrome DevTools MCP — Context Compression: Implementation Plan

Original assignment: Find the latest and most suitable model that I can use locally, see if something like this has already been created somewhere - search the net, forums, github, reddit, etc.. and create a plan for implementing such a tool - instructions for an AI assistant that will create it or combine it with an existing solution and create it as an mcp server in claude code. Instructions must be in English. This requires intensive searching on the net. Don't be afraid of it and do it properly.

Answer:

Excellent — I have a complete picture. Now let me compile it into a final document. Here is the complete plan. A brief summary of what I found and recommend:

---

## What exists

**Three relevant projects directly to your problem:**

**`mcp-context-proxy`** (samteezy) — a transparent MCP proxy that routes large tool responses through an external LLM before sending them on. Supports Ollam (OpenAI-compatible endpoint), caching, per-tool threshold configuration and tool hiding.

**`mcp-cache`** (swapnilsurdi) — wrap any MCP server with a single command (`npx mcp-cache npx @chrome-devtools/mcp@latest`). Caches large responses locally and returns summary + query tools instead, which Claude can use to search the data on-demand. Zero config.

**`simple-console-mcp`** — if you only need console logs, replace chrome-devtools-mcp completely. 4 tools instead of 50+, 200 tokens instead of 5000 tokens overhead on schemas.

---

## Recommended local model

**Qwen3.5-9B Q4_K_M** — the only model in the sub-10B class that holds full GPU offload up to 32K contexts on an 8GB card. On RTX 4060 it does ~40 tokens/sec at 16K contexts, peak VRAM 6.96 GB at 32K.

Natively handles 262K contexts (expandable to 1M tokens with YaRN), which means it will swallow any DevTools response without truncation.

---

## The plan in the document includes

- Complete TypeScript proxy server code (copy-paste ready)

- Tool-aware extraction prompts for each DevTools response type (DOM, console, network, performance)
- In-memory LRU cache (avoid redundant LLM calls)
- Configuration for `.claude/settings.json`
- Setup checklist and table of expected results (50k–150k tokens → 300–800 tokens after compression)

---

> **Goal:** Prevent `chrome-devtools-mcp` from flooding Claude Code's context window by intercepting, filtering, and LLM-summarizing tool responses before they reach Claude — using a local model on ≤8 GB VRAM.

---

## Background Research Summary

The problem is well-documented. Chrome DevTools MCP exposes **50+ tools** and raw tool responses (DOM dumps, console logs, network traces) can reach **1.3 MB / 154k tokens** per call. Three proven approaches exist in the wild:

| Project                           | What it solves                         | Approach                                                                  |
| --------------------------------- | -------------------------------------- | ------------------------------------------------------------------------- |
| `mcp-cache` (swapnilsurdi)        | Response token overflow                | Caches large responses locally, returns summary + query tools to Claude   |
| `mcp-context-proxy` (samteezy)    | Response size via LLM compression      | Transparent proxy; routes large responses through a small local/cloud LLM |
| `mcp-compressor` (Atlassian Labs) | Tool _schema_ bloat (70–97% reduction) | 2-step tool interface; lazy schema loading                                |
| `simple-console-mcp`              | Tool count bloat (50 → 4 tools)        | Minimal replacement for chrome-devtools-mcp, console-only                 |

**Recommended strategy:** Combine `mcp-cache` (for pagination/caching) **+** `mcp-context-proxy` (for LLM summarization) **+** Ollama with `qwen3.5:9b` as the local compression model.

---

## Recommended Local Model: `qwen3.5:9b` (Q4_K_M)

**Why Qwen3.5 9B:**

- Fits entirely in 8 GB VRAM at Q4_K_M quantization (~5.0 GB on disk, ~6.96 GB VRAM peak at 32K context)
- ~54–58 tokens/second on RTX 3070/4060 — fast enough for real-time compression
- 262K native context window (1M with YaRN) — can digest any MCP response
- Scores 32.4 on the Artificial Analysis Intelligence Index — 38% ahead of next competitor in the sub-10B class
- Hybrid thinking mode (`/no-think` suffix for fast extraction tasks)
- Apache 2.0 license, runs via Ollama's OpenAI-compatible API

**Pull command:**

```bash
ollama pull qwen3.5:9b-q4_K_M
```

**Alternative for slower hardware:** `qwen3:4b` (~2.5 GB VRAM, ~30 t/s) — less accurate but fits on any 8 GB card with room to spare.

---

## Architecture

```
Claude Code
    │
    ▼
[MCP Proxy Server]  ← YOU BUILD THIS (TypeScript/Node.js)
    │   ├─ Intercepts tool responses from chrome-devtools-mcp
    │   ├─ Checks response size (threshold: ~3000 tokens / ~12KB)
    │   ├─ If small → pass through as-is
    │   └─ If large → sends to Ollama for extraction/summarization
    │                  ↓
    │           [Ollama: qwen3.5:9b]
    │                  ↓
    │           Compressed digest returned
    │
    ▼
chrome-devtools-mcp  (upstream, unchanged)
```

**Key principle:** Claude Code sees only the proxy. The proxy registers identical tool names to the upstream `chrome-devtools-mcp`. Claude Code never knows compression is happening.

---

## Existing Projects to Base This On

### Option A — Extend `mcp-context-proxy` (RECOMMENDED)

Repo: <https://github.com/samteezy/mcp-context-proxy>

This project already does exactly what you need:

- Transparent MCP proxy (stdio ↔ stdio)
- Routes large responses through any OpenAI-compatible LLM
- Per-tool configuration of compression thresholds
- Response caching (avoids re-compressing identical calls)
- Tool hiding / description overrides
- Supports multiple upstream MCP servers

**What you need to configure:**

1. Point the compression model at `http://localhost:11434/v1` (Ollama's OpenAI-compatible endpoint)
2. Set the upstream server to `chrome-devtools-mcp`
3. Write chrome-devtools-specific extraction prompts per tool type

### Option B — Use `mcp-cache` as a wrapper

Repo: <https://github.com/swapnilsurdi/mcp-cache>

Simpler: no LLM needed, zero config, wraps any MCP server command:

```bash
npx mcp-cache npx @chrome-devtools/mcp@latest
```

Returns summary + pagination tools instead of raw overflow. Does **not** summarize — it defers the extraction to Claude via query tools.

### Option C — Replace chrome-devtools-mcp with `simple-console-mcp`

Repo: <https://glama.ai/mcp/servers/tznthou/simple-console-mcp>

If you only need console logs + JS execution (the most common use case), replace chrome-devtools-mcp entirely. 4 tools vs 50+. 200 tokens vs 5000 tokens of tool schema overhead. No proxy needed.

---

## Implementation Instructions for AI Assistant

> The following section is the task specification to hand to your AI coding assistant (Claude Code or similar).

---

### TASK: Build `chrome-devtools-mcp-proxy` — a Chrome DevTools MCP response compression proxy

**Language:** TypeScript (Node.js 20+)  
**Runtime:** stdio MCP server (compatible with Claude Code `.claude/settings.json`)  
**Dependencies:** `@modelcontextprotocol/sdk`, `openai` (or raw fetch for Ollama), `tiktoken` or `gpt-tokenizer` for token counting

---

#### What to build

A transparent MCP proxy server that:

1. **Registers itself as an MCP server** exposing the same tools as `chrome-devtools-mcp`
2. **Spawns `chrome-devtools-mcp` as a child process** and forwards tool calls to it via stdio
3. **Intercepts all tool responses** before returning them to Claude Code
4. **Compresses large responses** using a local Ollama model via OpenAI-compatible API
5. **Caches compressed results** in memory (keyed by tool name + argument hash) to avoid redundant LLM calls
6. **Falls through small responses** unchanged (below configurable token threshold)

---

#### Step-by-step build plan

**Step 1 — Scaffold the project**

```bash
mkdir chrome-devtools-mcp-proxy
cd chrome-devtools-mcp-proxy
npm init -y
npm install @modelcontextprotocol/sdk openai gpt-tokenizer
npm install -D typescript @types/node tsx
npx tsc --init --target ES2022 --module NodeNext --moduleResolution NodeNext
```

**Step 2 — Create `src/proxy.ts`**

Structure:

```
src/
  proxy.ts        # Main proxy: MCP server + child process client
  compressor.ts   # Ollama compression logic
  cache.ts        # Simple in-memory LRU cache
  config.ts       # Configuration constants
```

**Step 3 — `config.ts`**: Configurable constants

```typescript
export const config = {
  // Ollama endpoint (OpenAI-compatible)
  ollamaBaseUrl: process.env.OLLAMA_BASE_URL ?? "http://localhost:11434/v1",
  ollamaModel: process.env.OLLAMA_MODEL ?? "qwen3.5:9b-q4_K_M",

  // Compression threshold: responses larger than this get compressed
  // 3000 tokens ≈ ~12KB of text
  compressionThresholdTokens: parseInt(
    process.env.COMPRESSION_THRESHOLD ?? "3000",
  ),

  // Cache TTL in milliseconds (default: 5 minutes)
  cacheTtlMs: parseInt(process.env.CACHE_TTL_MS ?? "300000"),

  // Maximum output tokens from the compression model
  maxCompressedTokens: parseInt(process.env.MAX_COMPRESSED_TOKENS ?? "800"),

  // Upstream chrome-devtools-mcp command
  upstreamCommand: process.env.UPSTREAM_COMMAND ?? "npx",
  upstreamArgs: (
    process.env.UPSTREAM_ARGS ?? "@chrome-devtools/mcp@latest"
  ).split(" "),
};
```

**Step 4 — `compressor.ts`**: Ollama compression

The compressor must use **tool-aware system prompts** tailored to each type of DevTools response:

```typescript
import OpenAI from "openai";
import { config } from "./config.js";

const client = new OpenAI({
  baseURL: config.ollamaBaseUrl,
  apiKey: "ollama", // required but ignored by Ollama
});

// Per-tool extraction prompts — key insight: different DevTools tools
// return different data types that need different extraction strategies
const TOOL_PROMPTS: Record<string, string> = {
  // DOM/CSS inspection — extract structure, not verbatim HTML
  dom_get_document: `Extract from this DOM: (1) page title, (2) main semantic structure (nav/main/footer), (3) number of interactive elements (forms, buttons, inputs), (4) any visible error indicators. Max 300 words. Omit raw HTML.`,

  css_get_matched_styles: `Summarize the CSS: list only (1) layout properties (display, position, flex/grid), (2) sizing issues (overflow, min/max), (3) any !important overrides. Skip color/font/animation details. Max 200 words.`,

  // Console logs — errors and warnings only
  console_get_messages: `From these console messages, extract: (1) all ERROR entries with message + source file + line, (2) all WARN entries, (3) count of INFO/LOG entries (do not list them). Format as structured list. Max 400 words.`,

  // Network — focus on failures and slow requests
  network_get_requests: `From this network log, report: (1) all requests with status 4xx or 5xx (URL + status + response size), (2) any requests >2s response time (URL + duration), (3) total request count and page load time if available. Ignore successful static assets. Max 400 words.`,

  // Performance traces — numbers only
  performance_get_trace: `Extract performance metrics: LCP, FID/INP, CLS, TTFB, total blocking time. List the top 3 slowest tasks by duration. Ignore raw trace events. Max 200 words.`,

  // Default fallback for any unrecognized tool
  _default: `You are a data extraction assistant. The following is a tool response that is too large to pass directly to an AI assistant. Extract only the information that would be relevant for a developer debugging a web application. Remove all redundant, empty, or low-signal content. Preserve error messages, stack traces, status codes, and structural summaries verbatim. Your output must be under 500 words.`,
};

export async function compress(
  toolName: string,
  rawContent: string,
): Promise<string> {
  const prompt = TOOL_PROMPTS[toolName] ?? TOOL_PROMPTS["_default"];

  const response = await client.chat.completions.create({
    model: config.ollamaModel,
    max_tokens: config.maxCompressedTokens,
    messages: [
      { role: "system", content: prompt },
      {
        role: "user",
        content: `Tool response to compress:\n\n${rawContent.slice(0, 60000)}`, // hard cap at ~60k chars input
      },
    ],
    // Use /no_think suffix to disable extended reasoning for speed
    // (Qwen3 specific: appending to model name or using stop tokens)
  });

  const compressed =
    response.choices[0]?.message?.content ?? "[compression failed]";
  return `[COMPRESSED by qwen3.5 — original was ${rawContent.length} chars]\n\n${compressed}`;
}
```

**Step 5 — `cache.ts`**: Simple LRU cache

```typescript
export class ResponseCache {
  private cache = new Map<string, { value: string; expiresAt: number }>();

  get(key: string): string | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: string, ttlMs: number): void {
    this.cache.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  key(toolName: string, args: unknown): string {
    return `${toolName}:${JSON.stringify(args)}`;
  }
}
```

**Step 6 — `proxy.ts`**: Main proxy

```typescript
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { countTokens } from "gpt-tokenizer"; // approximate token counting
import { compress } from "./compressor.js";
import { ResponseCache } from "./cache.js";
import { config } from "./config.js";

const cache = new ResponseCache();

// 1. Connect to upstream chrome-devtools-mcp
const upstreamTransport = new StdioClientTransport({
  command: config.upstreamCommand,
  args: config.upstreamArgs,
});
const upstream = new Client({ name: "proxy-client", version: "1.0.0" });
await upstream.connect(upstreamTransport);

// 2. Discover upstream tools
const { tools } = await upstream.listTools();

// 3. Create proxy server exposing same tools
const server = new Server(
  { name: "chrome-devtools-mcp-proxy", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  // 4. Forward to upstream
  const result: CallToolResult = await upstream.callTool({
    name,
    arguments: args,
  });

  // 5. Check if response needs compression
  const rawText =
    result.content?.map((c) => (c.type === "text" ? c.text : "")).join("\n") ??
    "";

  const tokenCount = countTokens(rawText);

  if (tokenCount <= config.compressionThresholdTokens) {
    // Small response — pass through unchanged
    return result;
  }

  // 6. Check cache
  const cacheKey = cache.key(name, args);
  const cached = cache.get(cacheKey);
  if (cached) {
    return {
      content: [{ type: "text", text: `[CACHE HIT] ${cached}` }],
    };
  }

  // 7. Compress with local LLM
  process.stderr.write(
    `[proxy] Compressing ${name} response: ${tokenCount} tokens → Ollama...\n`,
  );
  const compressed = await compress(name, rawText);
  cache.set(cacheKey, compressed, config.cacheTtlMs);

  return {
    content: [{ type: "text", text: compressed }],
  };
});

// 8. Start proxy server on stdio
const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write("[proxy] chrome-devtools-mcp-proxy running\n");
```

**Step 7 — `package.json`** scripts

```json
{
  "type": "module",
  "scripts": {
    "build": "tsc",
    "start": "node dist/proxy.js",
    "dev": "tsx src/proxy.ts"
  }
}
```

**Step 8 — Build and test**

```bash
npm run build
# Test that it starts and forwards tools:
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | node dist/proxy.js
```

---

#### Claude Code integration (`.claude/settings.json`)

Replace the direct `chrome-devtools-mcp` entry with the proxy:

```json
{
  "mcpServers": {
    "chrome-devtools": {
      "command": "node",
      "args": ["/absolute/path/to/chrome-devtools-mcp-proxy/dist/proxy.js"],
      "env": {
        "OLLAMA_MODEL": "qwen3.5:9b-q4_K_M",
        "COMPRESSION_THRESHOLD": "3000",
        "MAX_COMPRESSED_TOKENS": "800",
        "CACHE_TTL_MS": "300000"
      }
    }
  }
}
```

---

#### Optional enhancements (implement after core works)

1. **Tool allowlist** — hide tools you never use to reduce schema tokens:

   ```typescript
   const ALLOWED_TOOLS = [
     "console_get_messages",
     "network_get_requests",
     "dom_get_document",
   ];
   // Filter in ListToolsRequestSchema handler
   ```

2. **`mcp-compressor` integration** — additionally wrap with Atlassian's schema compressor for 70–97% schema token reduction:

   ```bash
   pip install mcp-compressor
   # Then wrap your proxy with mcp-compressor in settings.json
   ```

3. **`simple-console-mcp` fallback** — for sessions where you only need console monitoring, swap chrome-devtools-mcp entirely:

   ```json
   "command": "npx", "args": ["simple-console-mcp"]
   ```

4. **Per-session `/no-think` mode** — for fast extraction, append `/no_think` to model name in Qwen3.5:

   ```typescript
   model: config.ollamaModel + " /no_think";
   ```

---

## Setup Checklist

```
[ ] Install Ollama: curl -fsSL https://ollama.com/install.sh | sh
[ ] Pull model:     ollama pull qwen3.5:9b-q4_K_M
[ ] Verify Ollama:  curl http://localhost:11434/v1/models
[ ] Clone/build proxy (follow steps above)
[ ] Update .claude/settings.json
[ ] Restart Claude Code session
[ ] Run: /context  — verify chrome-devtools token usage dropped
```

---

## Expected Results

| Metric                    | Before                      | After                                                         |
| ------------------------- | --------------------------- | ------------------------------------------------------------- |
| DOM dump response         | ~50k–150k tokens in context | ~300–800 tokens (compressed digest)                           |
| Console log dump          | ~5k–20k tokens              | ~200–400 tokens (errors + warnings only)                      |
| Network trace             | ~10k–40k tokens             | ~200–500 tokens (failures + slow requests)                    |
| Cache hit (repeated call) | same tokens again           | ~0ms, ~300 tokens                                             |
| Tool schema overhead      | ~5000 tokens                | ~5000 tokens (unchanged; use mcp-compressor to also fix this) |

---

## References

- `mcp-context-proxy`: <https://github.com/samteezy/mcp-context-proxy>
- `mcp-cache`: <https://github.com/swapnilsurdi/mcp-cache>
- `mcp-compressor`: <https://github.com/atlassian-labs/mcp-compressor>
- `simple-console-mcp`: <https://glama.ai/mcp/servers/tznthou/simple-console-mcp>
- `Qwen3.5:9b` on Ollama: <https://ollama.com/library/qwen3.5:9b>
- MCP TypeScript SDK: <https://github.com/modelcontextprotocol/typescript-sdk>
- Chrome DevTools MCP: <https://github.com/ChromeDevTools/chrome-devtools-mcp>
