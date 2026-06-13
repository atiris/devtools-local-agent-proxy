# devtools-local-agent-proxy

A Claude Code **plugin** that keeps token usage low during browser e2e testing.

It wraps [`chrome-devtools-mcp`](https://github.com/ChromeDevTools/chrome-devtools-mcp)
with a transparent MCP proxy. It cuts token usage three ways:

1. **Firehose list tools → high-signal defaults.** `list_console_messages` and
   `list_network_requests` return *everything* by default. The proxy rewrites
   them so they default to only what matters — console `warn`..`error`, network
   status `400`–`599` plus failed requests — and makes Claude opt in to more.
2. **Screenshots → focused WebP.** `take_screenshot` is rewritten to *require* a
   focus `region`, then the image is cropped, downscaled, and re-encoded as
   **WebP** locally — so a visual check costs a fraction of the pixels (and
   therefore tokens) of a full-resolution PNG.
3. **Big diagnostic dumps → local digest.** Whatever still comes back large
   (network traces, performance data, Lighthouse audits) is routed through a
   **local Ollama model** and returned as a compact, structured digest.

Either way, Claude's context window stays small.

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

**Interaction-critical tools are never text-compressed** (`take_snapshot`,
`evaluate_script`, `click`, `fill`, …). Their output carries element `uid`s or
structured return values that Claude needs **verbatim** to keep driving the
page. Compressing them would break automation. Non-image, non-screenshot binary
content is always passed through intact.

The compressible set is fully configurable (`COMPRESSIBLE_TOOLS`).

## Token-optimal list defaults

The two firehose tools are rewritten so they return high-signal rows by default
and force Claude to widen explicitly. Both transforms run *before* (and feed)
the Ollama compression stage above.

**`list_console_messages`** — a severity band, default `warn`..`error`:

| Param      | Default | Effect |
| ---------- | ------- | ------ |
| `minLevel` | `warn`  | Lowest severity to include (`debug` < `info` < `warn` < `error`) |
| `maxLevel` | `error` | Highest severity to include |

The band is translated to upstream's native `types` filter (lossless — no
parsing). `minLevel: "debug"` returns everything; an explicit `types: [...]`
array is honored as an advanced override.

**`list_network_requests`** — an HTTP status band, default `400`–`599`:

| Param       | Default | Effect |
| ----------- | ------- | ------ |
| `statusMin` | `400`   | Lowest status to include |
| `statusMax` | `599`   | Highest status to include |

Upstream cannot filter by status, so the proxy post-filters the request lines:
numeric statuses must fall in `[statusMin, statusMax]`; **failed requests**
(`net::ERR_*`, `pending`) are kept whenever the band reaches into errors
(`statusMax ≥ 400`), since a failed request is the most important kind. The
pagination header is replaced with a `kept of total` summary. `statusMin: 0,
statusMax: 599` returns everything; combine with `resourceTypes` to also skip
images/fonts. Toggle both with `OPTIMIZE_DIAGNOSTICS=false`.

> When you need successful resources (e.g. LCP image/font timing), widen the
> band — the bundled `debug-optimize-lcp` skill already does this.

## Focused screenshots (the other big lever)

Claude is billed for images by **pixel area**, not file size — so the only way
to make a screenshot cheap is to send fewer pixels. WebP quality shrinks bytes
(latency and the API's per-message payload limit) but **not** tokens; cropping
and downscaling shrink tokens.

The proxy rewrites the `take_screenshot` tool so Claude **must** declare a focus
`region`, then post-processes the upstream PNG with [`sharp`](https://sharp.pixelplumbing.com):
crop to the region → downscale to a max width → re-encode as WebP. The page is
never resized, so there are no layout side effects.

Added parameters on `take_screenshot`:

| Param      | Required | Default | Effect |
| ---------- | -------- | ------- | ------ |
| `region`   | **yes**  | —       | `full`, `top`/`bottom`/`left`/`right` (that half), `center` (central quarter), or `top-strip`/`bottom-strip` (top/bottom 20% band, for headers/footers) |
| `maxWidth` | no       | `1024`  | Output is downscaled to fit this width (never enlarged). **The real token lever.** |
| `quality`  | no       | `50`    | WebP quality 1–100. Trims bytes/latency, not tokens. |

The upstream `format` param is dropped (the proxy always re-encodes to WebP).
`uid`, `fullPage`, and `filePath` still work; when `filePath` is used the image
is written to disk by upstream and there is nothing to re-encode, so it passes
through unchanged. A one-line note is prepended to the result so Claude knows
the exact crop and dimensions it received.

Measured on a 1920×1080 capture: a full-page PNG (~31 KB, ~2700 image tokens at
full res) → `region: "full", maxWidth: 1024` becomes a **1024×576 WebP (~1.2 KB)**;
`region: "top-strip"` becomes a **1024×115 WebP (~0.4 KB)** — roughly an 80–95%
token cut versus a full-resolution screenshot. Toggle the whole behaviour with
`OPTIMIZE_SCREENSHOTS=false`.

### Hard per-side cap

No image handed to Claude may exceed `SCREENSHOT_MAX_SIDE` px (default **3000**)
on either side. This mainly catches tall full-page captures: even after a width
downscale, a long page stays thousands of px tall. Rather than send a giant
image (which blows the token budget and which some hosts reject outright), the
proxy **withholds it** and returns guidance instead — pick a focus region, lower
`maxWidth`, use `take_element_screenshot`, or `resize_page`/`fullPage:false`. The
cap is enforced even when `OPTIMIZE_SCREENSHOTS=false`.

### `take_element_screenshot` (by uid, padded, fully covered)

A synthetic tool the proxy adds: hand it the `uid` of an element from
`take_snapshot` and it returns a tight WebP of **just that element**, padded so
the whole thing (border, focus ring) is covered. Far cheaper than a page shot
when you only need to inspect one component.

How it works: the proxy resolves the element's geometry via `evaluate_script`
(passing the uid), takes a full-page PNG so even tall/below-the-fold elements are
covered, then crops to the element's box expanded by `padding`, downscales, and
WebP-encodes. Scale is calibrated from the captured image vs document size, so it
is correct at any `devicePixelRatio`.

| Param      | Required | Default | Effect |
| ---------- | -------- | ------- | ------ |
| `uid`      | **yes**  | —       | Element uid from `take_snapshot` |
| `padding`  | no       | `10`    | Extra px around the element (`SCREENSHOT_ELEMENT_PADDING`) |
| `maxWidth` | no       | `1024`  | Downscale to fit this width |
| `quality`  | no       | `50`    | WebP quality 1–100 |

If the element is larger than the per-side cap, the image is withheld with
guidance (screenshot a child element instead). An invalid/stale uid returns a
clear error telling Claude to take a fresh snapshot. Verified end-to-end against
real Chrome (`scripts/e2e-element.mjs`): a 200×100 button → a 220×120 WebP
covering exactly the element plus 10px.

## Requirements

- **Node.js 20+**
- **[`sharp`](https://sharp.pixelplumbing.com)** (installed automatically; ships
  prebuilt binaries — used for focused-screenshot crop/downscale/WebP)
- **[Ollama](https://ollama.com)** running locally (only for the diagnostic-dump
  digests; focused screenshots need no model)
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
# 0. Focused screenshots + list filters (no browser, no model):
npm run build && npm run test:screenshot && npm run test:diagnostics

# 1. Compression quality against your local model (no browser):
OLLAMA_MODEL=qwen3.5:9b npm run smoke

# 2. Full MCP protocol handshake through chrome-devtools-mcp:
node scripts/handshake.mjs

# 3. Full round-trip through a REAL browser (opens Chrome, needs the model):
OLLAMA_MODEL=qwen3.5:9b node scripts/e2e-browser.mjs

# 4. take_element_screenshot through a REAL browser (opens Chrome, no model):
node scripts/e2e-element.mjs
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
| `OPTIMIZE_DIAGNOSTICS` | `true` | Rewrite `list_console_messages`/`list_network_requests` with high-signal defaults. Set `false` for stock pass-through |
| `CONSOLE_MIN_LEVEL` / `CONSOLE_MAX_LEVEL` | `warn` / `error` | Default console severity band (`debug`<`info`<`warn`<`error`) |
| `NETWORK_STATUS_MIN` / `NETWORK_STATUS_MAX` | `400` / `599` | Default network HTTP status band |
| `OPTIMIZE_SCREENSHOTS` | `true` | Crop/downscale/WebP-encode `take_screenshot` output and require a focus `region`. Set `false` for stock pass-through |
| `SCREENSHOT_MAX_WIDTH` | `1024` | Default max output width (px) for focused screenshots — the main token lever |
| `SCREENSHOT_QUALITY` | `50` | Default WebP quality (1–100) for focused screenshots |
| `SCREENSHOT_MAX_SIDE` | `3000` | Hard cap on either side of any image sent to Claude; larger images are withheld with guidance |
| `SCREENSHOT_ELEMENT_PADDING` | `10` | Default px of padding around an element in `take_element_screenshot` |
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
src/screenshot.ts               Focused-screenshot crop/downscale/WebP optimizer
src/diagnostics.ts              Console severity + network status list filters
src/cache.ts                    TTL + size-bounded LRU cache
src/config.ts                   Env-driven configuration
skills/                         Vendored Chrome DevTools skills (Apache-2.0) + sync guide
scripts/smoke.mjs               Offline compression test (no browser)
scripts/screenshot.mjs          Offline focused-screenshot test (no browser)
scripts/diagnostics.mjs         Offline console/network filter test (no browser)
scripts/handshake.mjs           MCP protocol forwarding test
scripts/e2e-browser.mjs         Full round-trip test through real Chrome
scripts/e2e-element.mjs         take_element_screenshot test through real Chrome
```

## License

Licensed under the [Apache License, Version 2.0](LICENSE).

This project bundles skills derived from
[`chrome-devtools-mcp`](https://github.com/ChromeDevTools/chrome-devtools-mcp)
(Copyright Google LLC, Apache-2.0). See [`NOTICE`](NOTICE) for attribution and
[`skills/README.md`](skills/README.md) for how to keep them in sync.
