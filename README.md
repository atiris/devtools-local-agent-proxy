# devtools-local-agent-proxy

A Claude Code plugin that wraps [`chrome-devtools-mcp`](https://github.com/ChromeDevTools/chrome-devtools-mcp) and cuts token usage during browser testing. Tool names stay the same — Claude talks to this proxy instead of the upstream server.

```txt
Claude Code  →  devtools-local-agent-proxy  →  chrome-devtools-mcp  →  Chrome
                      ↑ Ollama (optional)
```

## Requirements

- Node.js 20+
- **[`sharp`](https://sharp.pixelplumbing.com)** — installed automatically; used for screenshot crop/downscale/WebP
- **Ollama** — optional, only for LLM compression of large diagnostic dumps. Screenshot and list optimizations work without it.

```bash
ollama pull qwen3.5:9b   # if you want LLM digests
```

## Install & build

**You must build before use.** The proxy runs from compiled JavaScript at `dist/proxy.js`. Without a build, Claude Code and manual MCP configs will fail to start.

```bash
git clone <this-repo> devtools-local-agent-proxy
cd devtools-local-agent-proxy
npm install      # runs `tsc` via the "prepare" script
npm run build    # recompile after any source change
```

After every `git pull` or code change, run `npm run build` again.

Quick checks:

```bash
npm run test:screenshot && npm run test:diagnostics   # no browser, no model
OLLAMA_MODEL=qwen3.5:9b npm run smoke                 # compression test
node scripts/handshake.mjs                            # MCP protocol test
```

## Proxy specification

The proxy intercepts MCP tool calls between Claude and `chrome-devtools-mcp`. Most tools pass through unchanged. The differences below are the reason to use this plugin.

### Rewritten tools

#### `list_console_messages`

Adds a severity band as the primary filter. Defaults to **warn..error** only.

| Param | Default | Effect |
| --- | --- | --- |
| `minLevel` | `warn` | Lowest severity to include (`debug` < `info` < `warn` < `error`) |
| `maxLevel` | `error` | Highest severity to include |

The band is translated to upstream's native `types` filter (lossless). Set `minLevel: "debug"` for everything. An explicit `types: [...]` array overrides the band. Toggle with `OPTIMIZE_DIAGNOSTICS=false`.

#### `list_network_requests`

Adds an HTTP status band. Defaults to **400–599** (client/server errors) plus failed requests (`net::ERR_*`, `pending`).

| Param | Default | Effect |
| --- | --- | --- |
| `statusMin` | `400` | Lowest status to include |
| `statusMax` | `599` | Highest status to include |

Upstream cannot filter by status, so the proxy post-filters request lines and replaces the pagination header with a `kept of total` summary. Set `statusMin: 0, statusMax: 599` for everything. Toggle with `OPTIMIZE_DIAGNOSTICS=false`.

#### `take_screenshot`

Requires a focus `region`. The proxy crops the upstream PNG, downscales to `maxWidth`, and re-encodes as **WebP**. Claude is billed by pixel area — width is the main token lever; WebP quality only trims bytes.

| Param | Required | Default | Effect |
| --- | --- | --- | --- |
| `region` | **yes** | — | `full`, `top`/`bottom`/`left`/`right` (half), `center` (central quarter), `top-strip`/`bottom-strip` (top/bottom 20%) |
| `maxWidth` | no | `1024` | Downscale to fit this width (never enlarged) |
| `quality` | no | `50` | WebP quality 1–100 |

The upstream `format` param is removed (proxy always outputs WebP). `uid`, `fullPage`, and `filePath` still work; when `filePath` is used the image is written to disk upstream and passes through unchanged. Toggle with `OPTIMIZE_SCREENSHOTS=false`.

**Per-side cap:** no image sent to Claude may exceed `SCREENSHOT_MAX_SIDE` px (default 3000) on either side. Larger captures are withheld with guidance to narrow the region — enforced even when `OPTIMIZE_SCREENSHOTS=false`.

### Added tool

#### `take_element_screenshot` *(synthetic)*

Screenshots a single element by `uid` from `take_snapshot`. The proxy resolves geometry, takes a full-page capture, crops to the element plus padding, downscales, and WebP-encodes. Cheaper than a page shot when inspecting one component.

| Param | Required | Default | Effect |
| --- | --- | --- | --- |
| `uid` | **yes** | — | Element uid from `take_snapshot` |
| `padding` | no | `10` | Extra px around the element |
| `maxWidth` | no | `1024` | Downscale to fit this width |
| `quality` | no | `50` | WebP quality 1–100 |

### LLM compression *(optional)*

When `OLLAMA_MODEL` is set, large responses from **read-only diagnostic tools** are summarized by a local Ollama model into compact digests:

| Tool | What the digest keeps |
| --- | --- |
| `list_console_messages` | errors + warnings verbatim, logs/info counted |
| `list_network_requests` | 4xx/5xx + slow (>1s) requests, rest counted |
| `get_network_request` | method/url/status/content-type + error body |
| `performance_stop_trace` | Core Web Vitals + slowest tasks |
| `performance_analyze_insight` | name / impact / cause / fix |
| `lighthouse_audit` | category scores + failing audits only |

**Never compressed:** interaction tools (`take_snapshot`, `evaluate_script`, `click`, `fill`, `take_screenshot`, …). Their output carries element `uid`s or structured values Claude needs verbatim. Upstream errors (`isError`) are never compressed either.

If `OLLAMA_MODEL` is unset or empty, LLM compression is off — the proxy still applies screenshot and list optimizations.

## Claude Code setup

**1. Build** (required — see above):

```bash
cd /path/to/devtools-local-agent-proxy
npm install && npm run build
```

**2. Register the local marketplace** (once):

```
/plugin marketplace add /path/to/devtools-local-agent-proxy
```

Windows: `/plugin marketplace add C:\Users\you\projects\devtools-local-agent-proxy`

**3. Install the plugin:**

```
/plugin install devtools-local-agent-proxy@atiris-local
```

**4. Disable the official `chrome-devtools-mcp` plugin** in Settings → Plugins (running both disables compression):

```json
"enabledPlugins": {
  "chrome-devtools-mcp@claude-plugins-official": false,
  "devtools-local-agent-proxy@atiris-local": true
}
```

**5. Restart Claude Code.**

This plugin bundles the upstream Chrome DevTools skills — you can disable the official plugin entirely. See [`skills/README.md`](skills/README.md) for sync notes.

## Manual MCP config

Point any MCP client at the built proxy (`dist/proxy.js` must exist):

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

## Configuration

All settings are environment variables. Defaults below are from `src/config.ts`; the bundled plugin overrides some values in `.claude-plugin/plugin.json`.

### Ollama / LLM compression

| Variable | Default | Description |
| --- | --- | --- |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Ollama host |
| `OLLAMA_MODEL` | *(none)* | Compression model. **Unset or empty = LLM compression off.** Plugin sets `qwen3.5:9b` |
| `OLLAMA_NUM_CTX` | `24576` | Model context window (`num_ctx`). Must exceed input + output or dumps are silently truncated |
| `COMPRESSION_THRESHOLD_TOKENS` | `2000` | Responses larger than this (≈ chars/4) get compressed |
| `MAX_COMPRESSED_TOKENS` | `2000` | Generation budget (`num_predict`) |
| `MAX_INPUT_CHARS` | *(derived)* | Hard cap on chars sent to the model. Derived from `OLLAMA_NUM_CTX` unless overridden |
| `OLLAMA_TEMPERATURE` | `0` | Sampling temperature (0 = faithful extraction) |
| `DISABLE_THINKING` | `true` | Disable model thinking phase (recommended for bulk extraction) |
| `OLLAMA_FORMAT_MODE` | `json` | Output constraint: `json`, `schema`, or `off` |
| `USE_FEW_SHOT` | `true` | Prepend a worked example per tool to pin JSON shape |
| `OLLAMA_TIMEOUT_MS` | `120000` | Per-call model timeout (ms) |
| `OLLAMA_KEEP_ALIVE` | `10m` | How long Ollama keeps the model loaded. `-1` = never unload |

### Screenshots

| Variable | Default | Description |
| --- | --- | --- |
| `OPTIMIZE_SCREENSHOTS` | `true` | Crop/downscale/WebP for `take_screenshot`. `false` = stock pass-through |
| `SCREENSHOT_MAX_WIDTH` | `1024` | Default max output width (px) — main token lever |
| `SCREENSHOT_QUALITY` | `50` | Default WebP quality (1–100) |
| `SCREENSHOT_MAX_SIDE` | `3000` | Hard cap on either image side; larger images withheld with guidance |
| `SCREENSHOT_ELEMENT_PADDING` | `10` | Default padding (px) around element in `take_element_screenshot` |

### Diagnostic list defaults

| Variable | Default | Description |
| --- | --- | --- |
| `OPTIMIZE_DIAGNOSTICS` | `true` | Rewrite list tools with high-signal defaults. `false` = stock pass-through |
| `CONSOLE_MIN_LEVEL` | `warn` | Default console severity floor (`debug` < `info` < `warn` < `error`) |
| `CONSOLE_MAX_LEVEL` | `error` | Default console severity ceiling |
| `NETWORK_STATUS_MIN` | `400` | Default network status floor |
| `NETWORK_STATUS_MAX` | `599` | Default network status ceiling |

### Tools, cache & escape hatches

| Variable | Default | Description |
| --- | --- | --- |
| `COMPRESSIBLE_TOOLS` | *(see table above)* | Comma-separated tools eligible for LLM compression |
| `ALLOWED_TOOLS` | *(all)* | If set, only these tools are exposed — cuts persistent tool-schema tokens |
| `CACHE_TTL_MS` | `300000` | Cache lifetime for compressed results (ms) |
| `CACHE_MAX_ENTRIES` | `100` | Max cache entries |
| `DISABLE_COMPRESSION` | `false` | Force LLM pass-through (debug). Also forced when `OLLAMA_MODEL` is empty |
| `FALLBACK_ON_ERROR` | `original` | On model failure: `original` (safe) or `truncate` |
| `PROXY_VERBOSE` | `true` | Log to stderr |
| `UPSTREAM_COMMAND` | `npx` | Command to spawn upstream server |
| `UPSTREAM_ARGS` | `-y,chrome-devtools-mcp@latest` | Args for upstream server (comma-separated) |

### Cutting the tool-schema tax

The ~29 chrome-devtools tools cost a few thousand tokens of schema on every turn. Expose only what you use:

```bash
ALLOWED_TOOLS="navigate_page,take_snapshot,click,fill,list_console_messages,list_network_requests"
```

## Behavior notes

- Interaction tools are never text-compressed — Claude needs exact output to drive the page.
- Upstream errors are always passed through unchanged.
- On Ollama failure the original response is returned by default.
- Compressed results are cached by `tool + args` with a short TTL.
- Digests are lossy summaries; Claude can re-run a tool for raw data.

## License

Apache-2.0. Bundled skills are from [`chrome-devtools-mcp`](https://github.com/ChromeDevTools/chrome-devtools-mcp) (Google LLC). See [`NOTICE`](NOTICE).
