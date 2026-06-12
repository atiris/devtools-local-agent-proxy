/**
 * LLM-backed response compressor.
 *
 * Talks to Ollama's native /api/chat endpoint (no extra SDK dependency).
 *
 * Two mechanisms keep the output small AND on-task, in order of importance:
 *
 *  1. STRUCTURED OUTPUT. Each tool ships a JSON schema passed in Ollama's
 *     `format` field. Ollama grammar-constrains generation to that schema, so
 *     the model physically cannot ramble into a help-desk essay — a failure
 *     mode every small local model (qwen3:8b, qwen2.5-coder, llama3.1) falls
 *     into when steered by prose rules alone. We then render the JSON back to
 *     compact text for Claude.
 *
 *  2. FEW-SHOT. One worked input→output example per tool nudges the model
 *     toward the right *content* (which lines matter) within that schema.
 *
 * `get_network_request` and the `_default` fallback use a generic
 * `{ facts: string[] }` schema so even unknown tools collapse to a bullet list.
 */

import { config, log } from "./config.js";

type Json = Record<string, unknown>;

interface Shot {
  user: string;
  /** Example assistant turn, as a JSON object matching the schema. */
  assistant: Json;
}

interface ToolSpec {
  system: string;
  schema: Json;
  shots: Shot[];
  render: (obj: Json) => string;
}

const SYSTEM_RULES =
  "You are a terse data-extraction filter inside a tooling pipeline, not a chat assistant. " +
  "Respond ONLY with JSON matching the given schema. Extract facts verbatim; never explain or advise.";

// --- small render helpers -------------------------------------------------

function asStrings(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x) => String(x)) : [];
}

function bullets(items: string[]): string {
  return items.length ? items.map((i) => `- ${i}`).join("\n") : "- none";
}

// --- schemas --------------------------------------------------------------

const FACTS_SCHEMA: Json = {
  type: "object",
  properties: { facts: { type: "array", items: { type: "string" } } },
  required: ["facts"],
};

const renderFacts = (o: Json): string => bullets(asStrings(o.facts));

/**
 * Per-tool specs keyed to the REAL chrome-devtools-mcp tool names (verified
 * against chrome-devtools-mcp v1.x). `_default` handles anything unlisted.
 */
const TOOL_SPECS: Record<string, ToolSpec> = {
  list_console_messages: {
    system:
      SYSTEM_RULES +
      " From a browser console dump keep every error and warning verbatim (message + source:line); count logs/info.",
    schema: {
      type: "object",
      properties: {
        errors: { type: "array", items: { type: "string" } },
        warnings: { type: "array", items: { type: "string" } },
        omittedCount: { type: "integer" },
      },
      required: ["errors", "warnings", "omittedCount"],
    },
    shots: [
      {
        user:
          "Tool: list_console_messages\nResponse to compress:\n" +
          "[log] app started\n[log] route /home\n" +
          "[error] Uncaught TypeError: Cannot read properties of undefined (reading 'id') at cart.js:88:12\n" +
          "[log] fetched 12 items\n[warning] [Deprecation] webkitStorageInfo is deprecated at vendor.js:401\n" +
          "[info] analytics ready\n[log] idle",
        assistant: {
          errors: [
            "TypeError: Cannot read properties of undefined (reading 'id') — cart.js:88:12",
          ],
          warnings: ["[Deprecation] webkitStorageInfo is deprecated — vendor.js:401"],
          omittedCount: 5,
        },
      },
    ],
    render: (o) =>
      `ERRORS (${asStrings(o.errors).length}):\n${bullets(asStrings(o.errors))}\n` +
      `WARNINGS (${asStrings(o.warnings).length}):\n${bullets(asStrings(o.warnings))}\n` +
      `OMITTED: ${Number(o.omittedCount) || 0} log/info messages`,
  },

  list_network_requests: {
    system:
      SYSTEM_RULES +
      " From a network log keep only failed (4xx/5xx) and slow (>1000ms) requests; count the rest. Ignore successful static assets.",
    schema: {
      type: "object",
      properties: {
        failed: {
          type: "array",
          items: {
            type: "object",
            properties: {
              request: { type: "string" },
              status: { type: "integer" },
              ms: { type: "integer" },
            },
            required: ["request", "status"],
          },
        },
        slow: {
          type: "array",
          items: {
            type: "object",
            properties: { request: { type: "string" }, ms: { type: "integer" } },
            required: ["request", "ms"],
          },
        },
        okCount: { type: "integer" },
      },
      required: ["failed", "slow", "okCount"],
    },
    shots: [
      {
        user:
          "Tool: list_network_requests\nResponse to compress:\n" +
          "GET https://cdn.x/a.png 200 1200b 30ms\n" +
          "GET https://cdn.x/b.css 200 900b 22ms\n" +
          "POST https://api.x/cart 500 142b 1840ms\n" +
          "GET https://api.x/user 404 88b 60ms\n" +
          "GET https://api.x/feed 200 9000b 3120ms",
        assistant: {
          failed: [
            { request: "POST https://api.x/cart", status: 500, ms: 1840 },
            { request: "GET https://api.x/user", status: 404, ms: 60 },
          ],
          slow: [{ request: "GET https://api.x/feed", ms: 3120 }],
          okCount: 3,
        },
      },
    ],
    render: (o) => {
      const failed = (Array.isArray(o.failed) ? o.failed : []) as Json[];
      const slow = (Array.isArray(o.slow) ? o.slow : []) as Json[];
      const fLines = failed.map(
        (f) => `${f.request} — ${f.status}${f.ms ? ` — ${f.ms}ms` : ""}`,
      );
      const sLines = slow.map((s) => `${s.request} — ${s.ms}ms`);
      return (
        `FAILED (${fLines.length}):\n${bullets(fLines)}\n` +
        `SLOW >1s (${sLines.length}):\n${bullets(sLines)}\n` +
        `OK: ${Number(o.okCount) || 0} other requests`
      );
    },
  },

  get_network_request: {
    system:
      SYSTEM_RULES +
      " Summarize one request as short facts: method+url, status, content-type, size, and the error or JSON shape of the body. Drop verbose headers and cookies.",
    schema: FACTS_SCHEMA,
    shots: [
      {
        user:
          "Tool: get_network_request\nResponse to compress:\n" +
          "POST https://api.x/cart\nstatus: 500\nrequest-headers: {authorization: Bearer ..., content-type: application/json}\n" +
          'body: {"error":"OutOfStock","sku":"A-19"}',
        assistant: {
          facts: [
            "POST https://api.x/cart — 500",
            "req content-type: application/json (auth: Bearer)",
            'error body: {"error":"OutOfStock","sku":"A-19"}',
          ],
        },
      },
    ],
    render: renderFacts,
  },

  performance_stop_trace: {
    system:
      SYSTEM_RULES +
      " Extract Core Web Vitals and the slowest tasks from a performance trace.",
    schema: {
      type: "object",
      properties: {
        metrics: {
          type: "object",
          properties: {
            lcp: { type: "string" },
            cls: { type: "string" },
            inp: { type: "string" },
            ttfb: { type: "string" },
            fcp: { type: "string" },
            tbt: { type: "string" },
          },
        },
        topTasks: { type: "array", items: { type: "string" } },
      },
      required: ["metrics", "topTasks"],
    },
    shots: [
      {
        user:
          "Tool: performance_stop_trace\nResponse to compress:\n" +
          "LCP 4200ms CLS 0.18 INP 320ms TTFB 880ms FCP 1900ms TBT 540ms\n" +
          "tasks: Evaluate hero.js 610ms, Layout 180ms, Parse HTML 140ms, idle 20ms",
        assistant: {
          metrics: {
            lcp: "4200ms",
            cls: "0.18",
            inp: "320ms",
            ttfb: "880ms",
            fcp: "1900ms",
            tbt: "540ms",
          },
          topTasks: ["Evaluate hero.js 610ms", "Layout 180ms", "Parse HTML 140ms"],
        },
      },
    ],
    render: (o) => {
      const m = (o.metrics ?? {}) as Json;
      const pairs = Object.entries(m)
        .filter(([, v]) => v)
        .map(([k, v]) => `${k.toUpperCase()} ${v}`);
      return (
        `${pairs.join(" | ") || "no metrics found"}\n` +
        `Top tasks:\n${bullets(asStrings(o.topTasks))}`
      );
    },
  },

  performance_analyze_insight: {
    system:
      SYSTEM_RULES + " Output the insight name, impact, one-line cause, and fix.",
    schema: {
      type: "object",
      properties: {
        name: { type: "string" },
        impact: { type: "string" },
        cause: { type: "string" },
        fix: { type: "string" },
      },
      required: ["name", "impact", "cause", "fix"],
    },
    shots: [
      {
        user:
          "Tool: performance_analyze_insight\nResponse to compress:\n" +
          "Insight: Render-blocking requests. Est savings 1.2s. Two stylesheets in <head> block first paint. Recommendation: inline critical CSS and defer the rest.",
        assistant: {
          name: "Render-blocking requests",
          impact: "~1.2s",
          cause: "2 head stylesheets block first paint",
          fix: "inline critical CSS, defer the rest",
        },
      },
    ],
    render: (o) =>
      `Insight: ${o.name ?? "?"}\nImpact: ${o.impact ?? "?"}\nCause: ${o.cause ?? "?"}\nFix: ${o.fix ?? "?"}`,
  },

  lighthouse_audit: {
    system:
      SYSTEM_RULES +
      " Output category scores and one line per FAILING audit. Skip passing audits.",
    schema: {
      type: "object",
      properties: {
        scores: {
          type: "object",
          properties: {
            performance: { type: "integer" },
            accessibility: { type: "integer" },
            bestPractices: { type: "integer" },
            seo: { type: "integer" },
          },
        },
        failing: { type: "array", items: { type: "string" } },
      },
      required: ["scores", "failing"],
    },
    shots: [
      {
        user:
          "Tool: lighthouse_audit\nResponse to compress:\n" +
          "Performance 62, Accessibility 88, Best-Practices 100, SEO 91\n" +
          "audits: LCP score 0.3 (4.2s); color-contrast score 0 (3 elements); viewport score 1",
        assistant: {
          scores: { performance: 62, accessibility: 88, bestPractices: 100, seo: 91 },
          failing: ["Largest Contentful Paint — 4.2s", "Contrast — 3 elements below threshold"],
        },
      },
    ],
    render: (o) => {
      const s = (o.scores ?? {}) as Json;
      return (
        `Scores: Perf ${s.performance ?? "?"} | A11y ${s.accessibility ?? "?"} | ` +
        `BP ${s.bestPractices ?? "?"} | SEO ${s.seo ?? "?"}\n` +
        `Failing:\n${bullets(asStrings(o.failing))}`
      );
    },
  },

  _default: {
    system:
      SYSTEM_RULES +
      " Keep only high-signal facts: errors, stack traces, status codes, failing assertions, key numbers. Drop expected/successful content.",
    schema: FACTS_SCHEMA,
    shots: [
      {
        user:
          "Tool: some_tool\nResponse to compress:\n" +
          "ok ok ok\nWARN retrying (1/3)\nok\nFATAL connect ECONNREFUSED 127.0.0.1:5432\nok ok ok",
        assistant: {
          facts: [
            "FATAL: connect ECONNREFUSED 127.0.0.1:5432",
            "WARN: retrying (1/3)",
            "~6 ok lines omitted",
          ],
        },
      },
    ],
    render: renderFacts,
  },
};

interface OllamaChatResponse {
  message?: { content?: string };
  error?: string;
}

async function callOllama(spec: ToolSpec, userContent: string): Promise<Json> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.ollamaTimeoutMs);

  const messages: { role: string; content: string }[] = [
    { role: "system", content: spec.system },
  ];
  if (config.useFewShot) {
    for (const shot of spec.shots) {
      messages.push({ role: "user", content: shot.user });
      messages.push({ role: "assistant", content: JSON.stringify(shot.assistant) });
    }
  }
  messages.push({ role: "user", content: userContent });

  // Output constraint. "schema" gives the strongest guarantee but some
  // thinking models only honor it with thinking ON; "json" is a looser mode
  // that pairs with thinking OFF for speed; "off" relies on the prompt alone.
  const format =
    config.formatMode === "schema"
      ? spec.schema
      : config.formatMode === "json"
        ? "json"
        : undefined;

  try {
    const res = await fetch(`${config.ollamaBaseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model: config.ollamaModel,
        stream: false,
        think: config.disableThinking ? false : undefined,
        format,
        messages,
        keep_alive: config.ollamaKeepAlive,
        options: {
          temperature: config.temperature,
          num_predict: config.maxCompressedTokens,
          num_ctx: config.numCtx,
        },
      }),
    });

    if (!res.ok) throw new Error(`Ollama HTTP ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as OllamaChatResponse;
    if (data.error) throw new Error(`Ollama error: ${data.error}`);
    const content = data.message?.content?.trim();
    if (!content) throw new Error("Ollama returned empty content");
    // Lenient parse: strip ```json fences and isolate the outermost object,
    // in case the model wraps the JSON in prose despite json mode.
    const cleaned = content.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    const candidate = start >= 0 && end > start ? cleaned.slice(start, end + 1) : cleaned;
    try {
      return JSON.parse(candidate) as Json;
    } catch {
      throw new Error(`model returned non-JSON: ${content.slice(0, 200)}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

export interface CompressResult {
  text: string;
  ok: boolean;
}

/**
 * Compress a raw tool response. On any failure, falls back per config
 * (original passthrough or hard truncation) so a flaky local model never
 * breaks an e2e run.
 */
export async function compress(
  toolName: string,
  rawContent: string,
): Promise<CompressResult> {
  const spec = TOOL_SPECS[toolName] ?? TOOL_SPECS._default;
  const truncated = rawContent.length > config.maxInputChars;
  // Keep head AND tail: errors and failed requests frequently appear at the end
  // of a dump, so naive head-only truncation would silently drop them.
  const input = truncated
    ? rawContent.slice(0, Math.floor(config.maxInputChars * 0.6)) +
      "\n\n…[middle truncated]…\n\n" +
      rawContent.slice(-Math.floor(config.maxInputChars * 0.4))
    : rawContent;
  const truncatedNote = truncated
    ? `\n\n[note: input truncated from ${rawContent.length} chars (kept head+tail); raise OLLAMA_NUM_CTX for full coverage]`
    : "";

  const started = Date.now();
  try {
    const obj = await callOllama(
      spec,
      `Tool: ${toolName}\nResponse to compress:\n${input}`,
    );
    const digest = spec.render(obj);
    const ms = Date.now() - started;
    log(`compressed ${toolName}: ${rawContent.length} -> ${digest.length} chars in ${ms}ms`);
    return {
      ok: true,
      text:
        `[compressed by ${config.ollamaModel} — original ${rawContent.length} chars; ` +
        `re-run the tool if you need the raw data]${truncatedNote}\n\n${digest}`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`compression FAILED for ${toolName}: ${msg}`);
    if (config.fallbackOnError === "truncate") {
      const slice = rawContent.slice(0, config.maxInputChars);
      return {
        ok: false,
        text: `[compression unavailable: ${msg} — showing first ${slice.length} of ${rawContent.length} chars]\n\n${slice}`,
      };
    }
    return { ok: false, text: rawContent };
  }
}
