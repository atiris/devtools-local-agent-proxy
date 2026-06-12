/**
 * Configuration for the devtools-local-agent-proxy.
 *
 * Everything is overridable via environment variables so the same build can be
 * pointed at a different local model, a remote Ollama host, or run in a pure
 * pass-through mode for debugging.
 */

function num(envValue: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(envValue ?? "", 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function bool(envValue: string | undefined, fallback: boolean): boolean {
  if (envValue === undefined) return fallback;
  return /^(1|true|yes|on)$/i.test(envValue.trim());
}

function list(envValue: string | undefined, fallback: string[]): string[] {
  if (envValue === undefined || envValue.trim() === "") return fallback;
  return envValue
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Tools whose responses are SAFE to summarize with an LLM. These are read-only
 * diagnostic tools where a human-readable digest is more useful than the raw
 * dump. We deliberately EXCLUDE interaction-critical tools (take_snapshot,
 * evaluate_script, take_screenshot) by default because their output contains
 * element `uid`s, structured return values, or binary data that Claude needs
 * verbatim to keep automating the page.
 */
const DEFAULT_COMPRESSIBLE_TOOLS = [
  "list_console_messages",
  "list_network_requests",
  "get_network_request",
  "performance_stop_trace",
  "performance_analyze_insight",
  "lighthouse_audit",
];

const numCtx = num(process.env.OLLAMA_NUM_CTX, 24576);

/**
 * Chars we dare feed the model. Dense, repetitive DevTools output tokenizes at
 * ~2.4 chars/token (far below the naive 4), so a char budget computed from
 * num_ctx must assume the worst case or the prompt silently overflows the
 * window. We reserve ~3500 tokens for the system/few-shot/output and assume
 * 2.2 chars/token. Anything beyond this is head+tail truncated (see compressor)
 * so trailing errors are never lost.
 */
const derivedMaxInputChars = Math.max(8000, Math.floor((numCtx - 3500) * 2.2));

export const config = {
  // --- Local model (Ollama native API) ---
  ollamaBaseUrl: (
    process.env.OLLAMA_BASE_URL ?? "http://localhost:11434"
  ).replace(/\/$/, ""),
  ollamaModel: process.env.OLLAMA_MODEL ?? "qwen3.5:9b",

  // --- Compression behaviour ---
  // Responses estimated larger than this (tokens ≈ chars/4) get compressed.
  compressionThresholdTokens: num(process.env.COMPRESSION_THRESHOLD_TOKENS, 2000),
  // Total generation budget (num_predict). For thinking models this must also
  // cover the hidden reasoning phase, so it is generous; the rendered digest
  // itself stays tiny regardless.
  maxCompressedTokens: num(process.env.MAX_COMPRESSED_TOKENS, 2000),
  // Model context window (num_ctx). CRITICAL: Ollama defaults to only 4096
  // tokens — a large DevTools dump fills that entirely, leaving no room to
  // generate (and silently truncating the input, which causes missed errors
  // and hallucinations). Must comfortably exceed input + output. Lower it if
  // your GPU is tight on VRAM; raise it to handle bigger dumps.
  numCtx,
  // Hard cap on chars sent to the model, derived from numCtx unless overridden.
  maxInputChars: num(process.env.MAX_INPUT_CHARS, derivedMaxInputChars),
  // Sampling temperature for the extraction model (low = deterministic).
  temperature: Number.parseFloat(process.env.OLLAMA_TEMPERATURE ?? "0"),
  // Disable the model's "thinking" phase. ON by default: thinking models
  // (qwen3.5:9b) "over-think" bulk extraction — reasoning about every log line
  // for 100+ seconds and exhausting the generation budget before emitting an
  // answer. Fast extraction wants thinking OFF.
  disableThinking: bool(process.env.DISABLE_THINKING, true),
  // How to constrain output: "json" (loose JSON mode — most portable, works
  // with thinking OFF), "schema" (full JSON schema — strongest, but qwen3.5
  // only honors it with thinking ON), or "off" (prompt only).
  formatMode: (process.env.OLLAMA_FORMAT_MODE as "schema" | "json" | "off") ?? "json",
  // Include a worked example per tool. ON by default: with thinking OFF and
  // loose JSON mode, the example is what pins the exact output shape. (Turn OFF
  // only if you switch to schema mode WITH a thinking model, where examples
  // bloat the reasoning budget.)
  useFewShot: bool(process.env.USE_FEW_SHOT, true),
  // Request timeout for the local model in ms.
  ollamaTimeoutMs: num(process.env.OLLAMA_TIMEOUT_MS, 120000),
  // How long Ollama keeps the model loaded after the last request. Use "-1" to
  // keep it loaded indefinitely, "10m" for 10 minutes, etc. Default keeps the
  // model warm for 10 minutes so repeated compression calls don't pay cold-start
  // cost (Ollama's default of 5 min often expires mid-session).
  ollamaKeepAlive: process.env.OLLAMA_KEEP_ALIVE ?? "10m",

  // --- Which tools to compress / expose ---
  compressibleTools: new Set(
    list(process.env.COMPRESSIBLE_TOOLS, DEFAULT_COMPRESSIBLE_TOOLS),
  ),
  // Optional allow-list. If set, ONLY these tools are exposed to Claude — this
  // is the single biggest lever for cutting the persistent tool-schema tax.
  allowedTools: list(process.env.ALLOWED_TOOLS, []),

  // --- Cache ---
  cacheTtlMs: num(process.env.CACHE_TTL_MS, 300000),
  cacheMaxEntries: num(process.env.CACHE_MAX_ENTRIES, 100),

  // --- Escape hatches ---
  // Turn off compression entirely (pure pass-through) for debugging.
  disableCompression: bool(process.env.DISABLE_COMPRESSION, false),
  // On model failure: "original" (safe, returns raw) or "truncate" (returns a
  // hard-truncated slice + note). Default keeps correctness over savings.
  fallbackOnError:
    (process.env.FALLBACK_ON_ERROR as "original" | "truncate") ?? "original",
  // Verbose stderr logging.
  verbose: bool(process.env.PROXY_VERBOSE, true),

  // --- Upstream chrome-devtools-mcp ---
  upstreamCommand: process.env.UPSTREAM_COMMAND ?? "npx",
  upstreamArgs: list(process.env.UPSTREAM_ARGS, ["-y", "chrome-devtools-mcp@latest"]),
};

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function log(...args: unknown[]): void {
  if (config.verbose) {
    process.stderr.write(`[devtools-proxy] ${args.join(" ")}\n`);
  }
}
