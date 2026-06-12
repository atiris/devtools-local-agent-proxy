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

```txt
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

## Why JSON output + the settings that actually matter

Small local instruct models (qwen3:8b, qwen2.5-coder, llama3.1, qwen3.5:9b)
*ignore* prose instructions like "be terse, don't explain" and turn an
extraction task into a help-desk essay — which would make responses **bigger**,
not smaller. This proxy instead forces **JSON output** (Ollama `format`) and
renders the parsed JSON back to compact text. A one-shot example per tool pins
the exact shape and steers *which* facts to keep.

Two non-obvious settings make or break this, both learned the hard way and now
defaulted correctly:

- **`num_ctx` (context window).** Ollama defaults to **4096 tokens**. A single
  DevTools dump fills that entirely, so the model has no room to answer *and
  the input is silently truncated* — which causes missed errors and outright
  hallucinations. The proxy sets `num_ctx=16384` so the whole dump plus the
  digest fit.
- **Thinking OFF.** "Thinking" models like `qwen3.5:9b` over-think bulk
  extraction — reasoning about every log line for 100+ seconds and exhausting
  the generation budget before producing an answer. The proxy disables thinking
  for fast, faithful extraction.

Measured on a ~18 KB console/network dump with **qwen3.5:9b** (default config):
**~98% token reduction** (4400 → ~80 tokens), ~4 s per call, all errors and
failed/slow requests preserved verbatim with no hallucination.

## What gets compressed (and what doesn't)

Only **read-only diagnostic tools** are compressed, because their raw output is
noisy and a digest is strictly more useful:

| Compressed by default          | Extracted                                     |
| ------------------------------ | --------------------------------------------- |
| `list_console_messages`        | errors + warnings verbatim, logs/info counted |
| `list_network_requests`        | 4xx/5xx + slow (>1s) requests, rest counted   |
| `get_network_request`          | method/url/status/content-type + error body   |
| `performance_stop_trace`       | Core Web Vitals + slowest tasks               |
| `performance_analyze_insight`  | name / impact / cause / fix                   |
| `lighthouse_audit`             | category scores + failing audits only         |

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

# 3. Full round-trip through a REAL browser (opens Chrome, needs the model):
OLLAMA_MODEL=qwen3.5:9b node scripts/e2e-browser.mjs
```

```ps
set OLLAMA_MODEL=qwen3.5:9b
npm run smoke
node scripts/handshake.mjs
```

The browser e2e drives Chrome to log 600+ console messages plus a real error,
then confirms `list_console_messages` comes back as a compressed digest with the
error preserved. Measured: a 42 KB / ~10.5k-token live dump → ~73 tokens
(**99.3% reduction**), error and warning intact.

## Use as a Claude Code plugin

The plugin ships `.claude-plugin/plugin.json`, which registers the proxy as the
`chrome-devtools` MCP server. It replaces the stock `chrome-devtools-mcp`
plugin — running both at the same time causes conflicts and disables compression,
so you must disable the official one after installing this proxy.

### Step-by-step setup

**1. Build the proxy** (if you haven't yet):

```bash
cd /path/to/devtools-local-agent-proxy
npm install   # also runs tsc via the "prepare" script
```

**2. Register the local marketplace** (once per machine). In any Claude Code
chat input:

```
/plugin marketplace add /path/to/devtools-local-agent-proxy
```

On Windows use the full path, e.g.:

```
/plugin marketplace add C:\Users\you\projects\devtools-local-agent-proxy
```

This registers the directory as a marketplace named `atiris-local` (the name
defined in `.claude-plugin/marketplace.json`).

**3. Install the plugin:**

```
/plugin install devtools-local-agent-proxy@atiris-local
```

**4. Disable the official chrome-devtools-mcp plugin:**

Open Claude Code Settings → Plugins and toggle off
`chrome-devtools-mcp@claude-plugins-official`, or set it to `false` directly in
`~/.claude/settings.json`:

```json
"enabledPlugins": {
  "chrome-devtools-mcp@claude-plugins-official": false,
  "devtools-local-agent-proxy@atiris-local": true
}
```

**5. Restart Claude Code.** The proxy takes over the `chrome-devtools` tool
namespace. All tool names stay identical — nothing else in your workflow changes.

Run `/context` before and after a heavy browser session to see the token
reduction.

### Bundled skills

This plugin also vendors the Chrome DevTools **skills** (`chrome-devtools`,
`a11y-debugging`, `debug-optimize-lcp`, `memory-leak-debugging`,
`chrome-devtools-cli`, `troubleshooting`) from upstream, so it is fully
self-contained. After installing this plugin you can **disable
`chrome-devtools-mcp@claude-plugins-official` entirely** (step 4 above) — both
its MCP server *and* its skills are replaced by this plugin.

The skills reference tools by bare name (`take_snapshot`, `list_pages`, …), so
they work transparently against the proxied `chrome-devtools` server.

> ℹ️ The skills are copied from upstream and licensed under Apache-2.0. See
> [`skills/README.md`](skills/README.md) for **how to keep them in sync** when
> `chrome-devtools-mcp` updates, and the repo-root [`NOTICE`](NOTICE) for
> attribution.

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
| `OLLAMA_NUM_CTX` | `16384` | **Context window — must exceed input+output or the dump is truncated.** Raise for very large dumps (uses more VRAM) |
| `COMPRESSION_THRESHOLD_TOKENS` | `2000` | Responses larger than this (≈ chars/4) get compressed |
| `MAX_COMPRESSED_TOKENS` | `2000` | Generation budget (`num_predict`); the digest itself stays tiny |
| `MAX_INPUT_CHARS` | `40000` | Hard cap on chars sent to the model (kept below `num_ctx`) |
| `OLLAMA_TEMPERATURE` | `0` | Sampling temperature (0 = faithful) |
| `DISABLE_THINKING` | `true` | Disable the model's thinking phase (recommended for extraction) |
| `OLLAMA_FORMAT_MODE` | `json` | Output constraint: `json`, `schema`, or `off` |
| `USE_FEW_SHOT` | `true` | Prepend a worked example per tool (pins the JSON shape) |
| `OLLAMA_TIMEOUT_MS` | `120000` | Per-call model timeout |
| `OLLAMA_KEEP_ALIVE` | `10m` | How long Ollama keeps the model in memory after the last call. Use `-1` to never unload, `5m`, `1h`, etc. Default of 10 min avoids cold-start latency mid-session. |
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

- Failed upstream calls (`isError`) are never compressed — you always see the real error.
- On any model/Ollama failure the proxy returns the **original** response by default, so a flaky local model can never break a test run.
- Compressed results are cached by `tool + args` with a short TTL to avoid re-spending model time on repeated diagnostic calls in an agent loop.
- A digest is a lossy summary. Each one is labeled and tells Claude it can re-run the tool for raw data if needed.

## Project layout

```txt
.claude-plugin/plugin.json      Claude Code plugin manifest (registers the MCP server)
.claude-plugin/marketplace.json  Local marketplace manifest (enables /plugin install)
src/proxy.ts                    MCP server ⇄ upstream client; interception logic
src/compressor.ts               Tool-aware, schema-constrained Ollama compression
src/cache.ts                    TTL + size-bounded LRU cache
src/config.ts                   Env-driven configuration
skills/                         Vendored Chrome DevTools skills (Apache-2.0) + sync guide
scripts/smoke.mjs               Offline compression test (no browser)
scripts/handshake.mjs           MCP protocol forwarding test
scripts/e2e-browser.mjs         Full round-trip test through real Chrome
```

## License

Licensed under the [Apache License, Version 2.0](LICENSE).

This project bundles skills derived from
[`chrome-devtools-mcp`](https://github.com/ChromeDevTools/chrome-devtools-mcp)
(Copyright Google LLC, Apache-2.0). See [`NOTICE`](NOTICE) for attribution and
[`skills/README.md`](skills/README.md) for how to keep them in sync.
