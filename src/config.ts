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

export const config = {
  // --- Local model (Ollama native API) ---
  ollamaBaseUrl: (
    process.env.OLLAMA_BASE_URL ?? "http://localhost:11434"
  ).replace(/\/$/, ""),
  ollamaModel: process.env.OLLAMA_MODEL ?? "qwen3.5:9b",

  // --- Compression behaviour ---
  // Responses estimated larger than this (tokens ≈ chars/4) get compressed.
  compressionThresholdTokens: num(process.env.COMPRESSION_THRESHOLD_TOKENS, 2000),
  // Upper bound on the digest the local model produces.
  maxCompressedTokens: num(process.env.MAX_COMPRESSED_TOKENS, 600),
  // Hard cap on characters fed to the local model (protects its context window).
  maxInputChars: num(process.env.MAX_INPUT_CHARS, 80000),
  // Sampling temperature for the extraction model (low = deterministic).
  temperature: Number.parseFloat(process.env.OLLAMA_TEMPERATURE ?? "0"),
  // Disable the model's "thinking" phase for fast extraction (qwen3 family).
  disableThinking: bool(process.env.DISABLE_THINKING, true),
  // Request timeout for the local model in ms.
  ollamaTimeoutMs: num(process.env.OLLAMA_TIMEOUT_MS, 120000),

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
