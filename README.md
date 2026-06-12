# devtools-local-agent-proxy

A Claude Code **plugin** that keeps token usage low during browser e2e testing.

It wraps [`chrome-devtools-mcp`](https://github.com/ChromeDevTools/chrome-devtools-mcp)
with a transparent MCP proxy. The proxy forwards every tool call to the real
server unchanged, but when a **read-only diagnostic tool** returns a large dump
(console logs, network traces, performance data, Lighthouse audits) it routes
the response through a **local Ollama model** and returns a compact, structured
digest instead — so Claude's context window stays small.

Claude Code only ever sees this proxy. The tool names and schemas are identical
to the upstream server, so nothing in your workflow changes.

```
Claude Code
   │  (identical tool names)
   ▼
devtools-local-agent-proxy   ← this plugin
   │   ├─ small response  → pass through unchanged
   │   └─ large + diagnostic → local model → compact digest
   │                              ▲
   │                     Ollama (qwen3.5:9b)
   ▼
chrome-devtools-mcp  (upstream, unchanged)
   ▼
Chrome
```

## Why structured output (the key design choice)

Small local instruct models (qwen3:8b, qwen2.5-coder, llama3.1) *ignore* prose
instructions like "be terse, don't explain" and turn an extraction task into a
help-desk essay — which would make responses **bigger**, not smaller. This
proxy instead passes a **JSON schema** per tool in Ollama's `format` field, so
generation is grammar-constrained and the model physically cannot ramble. The
JSON is then rendered back to compact text for Claude. A one-shot example per
tool steers *which* facts to keep.

Measured on a ~18 KB console/network dump with qwen3:8b: **~98% token
reduction** (4400 → ~80 tokens), ~3–4 s per call. A stronger model such as
`qwen3.5:9b` improves extraction fidelity further.

## What gets compressed (and what doesn't)

Only **read-only diagnostic tools** are compressed, because their raw output is
noisy and a digest is strictly more useful:

| Compressed by default          | Extracted |
| ------------------------------ | --------- |
| `list_console_messages`        | errors + warnings verbatim, logs/info counted |
| `list_network_requests`        | 4xx/5xx + slow (>1s) requests, rest counted |
| `get_network_request`          | method/url/status/content-type + error body |
| `performance_stop_trace`       | Core Web Vitals + slowest tasks |
| `performance_analyze_insight`  | name / impact / cause / fix |
| `lighthouse_audit`             | category scores + failing audits only |

**Interaction-critical tools are never compressed** (`take_snapshot`,
`evaluate_script`, `take_screenshot`, `click`, `fill`, …). Their output carries
element `uid`s, structured return values, or binary image data that Claude
needs **verbatim** to keep driving the page. Compressing them would break
automation. Screenshots and other non-text content are always passed through
intact, even when they ride alongside a compressed text part.

The compressible set is fully configurable (`COMPRESSIBLE_TOOLS`).

## Requirements

- **Node.js 20+**
- **[Ollama](https://ollama.com)** running locally
- A compression model pulled, e.g.:
  ```bash
  ollama pull qwen3.5:9b
  ```
  Any Ollama model that supports structured output works (`qwen3:8b`,
  `qwen2.5-coder:7b`, `llama3.1:8b`, …). Stronger models extract more
  faithfully; pick one that fits your VRAM.

## Install & build

```bash
git clone <this-repo> devtools-local-agent-proxy
cd devtools-local-agent-proxy
npm install      # also builds via the "prepare" script
npm run build    # (re)compile TypeScript → dist/
```

### Verify locally (no Claude Code needed)

```bash
# 1. Compression quality against your local model (no browser):
OLLAMA_MODEL=qwen3.5:9b npm run smoke

# 2. Full MCP protocol handshake through chrome-devtools-mcp:
node scripts/handshake.mjs
```

## Use as a Claude Code plugin

The plugin ships `.claude-plugin/plugin.json`, which registers the proxy as the
`chrome-devtools` MCP server. After adding the plugin to Claude Code (via your
marketplace or a local plugin path), **disable the stock `chrome-devtools-mcp`
plugin** so the names don't collide — this proxy replaces it.

Then restart Claude Code and run `/context` before and after a browser session
to see the drop.

### Or wire it up manually

Point any MCP client at the built proxy:

```json
{
  "mcpServers": {
    "chrome-devtools": {
      "command": "node",
      "args": ["/absolute/path/to/devtools-local-agent-proxy/dist/proxy.js"],
      "env": {
        "OLLAMA_MODEL": "qwen3.5:9b",
        "COMPRESSION_THRESHOLD_TOKENS": "2000",
        "MAX_COMPRESSED_TOKENS": "600"
      }
    }
  }
}
```

## Configuration (environment variables)

| Variable | Default | Description |
| --- | --- | --- |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Ollama host |
| `OLLAMA_MODEL` | `qwen3.5:9b` | Compression model |
| `COMPRESSION_THRESHOLD_TOKENS` | `2000` | Responses larger than this (≈ chars/4) get compressed |
| `MAX_COMPRESSED_TOKENS` | `600` | Upper bound on the digest (`num_predict`) |
| `MAX_INPUT_CHARS` | `80000` | Hard cap on chars sent to the model |
| `OLLAMA_TEMPERATURE` | `0` | Sampling temperature (0 = faithful) |
| `DISABLE_THINKING` | `true` | Disable the model's thinking phase (qwen3 family) |
| `OLLAMA_TIMEOUT_MS` | `120000` | Per-call model timeout |
| `COMPRESSIBLE_TOOLS` | *(diagnostic set above)* | Comma-separated tools to compress |
| `ALLOWED_TOOLS` | *(all)* | If set, only these tools are exposed — cuts the persistent tool-schema cost |
| `CACHE_TTL_MS` | `300000` | Cache lifetime for compressed results |
| `CACHE_MAX_ENTRIES` | `100` | Max cache entries |
| `DISABLE_COMPRESSION` | `false` | Pure pass-through (debug) |
| `FALLBACK_ON_ERROR` | `original` | On model failure: `original` (safe) or `truncate` |
| `PROXY_VERBOSE` | `true` | Log to stderr |
| `UPSTREAM_COMMAND` / `UPSTREAM_ARGS` | `npx` / `-y chrome-devtools-mcp@latest` | The wrapped server |

### Cutting the tool-schema tax

The ~29 chrome-devtools tools cost a few thousand tokens of schema on *every*
turn, regardless of compression. If you only use a handful, expose just those:

```bash
ALLOWED_TOOLS="navigate_page,take_snapshot,click,fill,list_console_messages,list_network_requests"
```

## Safety & correctness notes

- Failed upstream calls (`isError`) are never compressed — you always see the
  real error.
- On any model/Ollama failure the proxy returns the **original** response by
  default, so a flaky local model can never break a test run.
- Compressed results are cached by `tool + args` with a short TTL to avoid
  re-spending model time on repeated diagnostic calls in an agent loop.
- A digest is a lossy summary. Each one is labeled and tells Claude it can
  re-run the tool for raw data if needed.

## Project layout

```
.claude-plugin/plugin.json   Claude Code plugin manifest (registers the MCP server)
src/proxy.ts                 MCP server ⇄ upstream client; interception logic
src/compressor.ts            Tool-aware, schema-constrained Ollama compression
src/cache.ts                 TTL + size-bounded LRU cache
src/config.ts                Env-driven configuration
scripts/smoke.mjs            Offline compression test (no browser)
scripts/handshake.mjs        End-to-end MCP protocol test
```

## License

MIT
