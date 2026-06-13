/**
 * Token-optimal defaults for the two firehose list tools.
 *
 * `list_console_messages` and `list_network_requests` return EVERYTHING by
 * default, which floods the context window. This module narrows both to the
 * signal that matters unless Claude explicitly widens the range:
 *
 *  - Console: a `minLevel`..`maxLevel` severity band (default warn..error),
 *    translated to upstream's native `types` filter (lossless, no parsing).
 *  - Network: a `statusMin`..`statusMax` band (default 400..599 = errors),
 *    applied by post-filtering the concise request lines (upstream cannot
 *    filter by status).
 */

import { type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { config, log } from "./config.js";

// --- Console severity ladder ---------------------------------------------

/** Severity order, low → high. */
export const CONSOLE_LEVELS = ["debug", "info", "warn", "error"] as const;
export type ConsoleLevel = (typeof CONSOLE_LEVELS)[number];

/** Map each severity bucket to the upstream console `types` it covers. */
const LEVEL_TYPES: Record<ConsoleLevel, string[]> = {
  debug: ["debug", "verbose", "trace"],
  info: [
    "info", "log", "dir", "dirxml", "table", "count", "timeEnd",
    "profile", "profileEnd", "startGroup", "startGroupCollapsed", "endGroup", "clear",
  ],
  warn: ["warn", "issue"],
  error: ["error", "assert"],
};

const levelIdx = (l: string): number => CONSOLE_LEVELS.indexOf(l as ConsoleLevel);

/** Expand a min..max severity band to the upstream `types` array. */
export function levelsToTypes(min: ConsoleLevel, max: ConsoleLevel): string[] {
  const lo = levelIdx(min) < 0 ? levelIdx(config.consoleMinLevel) : levelIdx(min);
  const hi = levelIdx(max) < 0 ? levelIdx(config.consoleMaxLevel) : levelIdx(max);
  const [a, b] = lo <= hi ? [lo, hi] : [hi, lo];
  return CONSOLE_LEVELS.slice(a, b + 1).flatMap((l) => LEVEL_TYPES[l]);
}

/** Rewrite list_console_messages so a severity band is the primary knob. */
export function transformConsoleTool(tool: Tool): Tool {
  const props = { ...(tool.inputSchema?.properties ?? {}) } as Record<string, unknown>;
  const level = {
    type: "string",
    enum: [...CONSOLE_LEVELS],
    description: "Severity: debug < info < warn < error",
  };
  props.minLevel = {
    ...level,
    description: `Lowest severity to include (default ${config.consoleMinLevel}). debug < info < warn < error`,
  };
  props.maxLevel = {
    ...level,
    description: `Highest severity to include (default ${config.consoleMaxLevel})`,
  };
  return {
    ...tool,
    description:
      "List console messages for the selected page since the last navigation. " +
      `[proxy] Defaults to ${config.consoleMinLevel}..${config.consoleMaxLevel} only — ` +
      "set minLevel/maxLevel to widen (minLevel:debug for everything)",
    inputSchema: { ...tool.inputSchema, properties: props } as Tool["inputSchema"],
  };
}

/** Strip proxy keys and inject the upstream `types` band for console. */
export function consoleUpstreamArgs(
  args: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(args ?? {}) };
  const min = out.minLevel as ConsoleLevel;
  const max = out.maxLevel as ConsoleLevel;
  delete out.minLevel;
  delete out.maxLevel;
  // An explicit `types` array is an advanced override — honor it untouched.
  if (Array.isArray(out.types) && out.types.length > 0) return out;
  out.types = levelsToTypes(min ?? config.consoleMinLevel, max ?? config.consoleMaxLevel);
  return out;
}

// --- Network status band --------------------------------------------------

/** Rewrite list_network_requests so a status band is the primary knob. */
export function transformNetworkTool(tool: Tool): Tool {
  const props = { ...(tool.inputSchema?.properties ?? {}) } as Record<string, unknown>;
  props.statusMin = {
    type: "integer",
    minimum: 0,
    maximum: 599,
    description: `Lowest HTTP status to include (default ${config.networkStatusMin}). Set 0 with statusMax 599 for all requests`,
  };
  props.statusMax = {
    type: "integer",
    minimum: 0,
    maximum: 599,
    description: `Highest HTTP status to include (default ${config.networkStatusMax})`,
  };
  return {
    ...tool,
    description:
      "List network requests for the selected page since the last navigation. " +
      `[proxy] Defaults to status ${config.networkStatusMin}-${config.networkStatusMax} (errors) plus failed requests — ` +
      "set statusMin/statusMax to widen (statusMin:0 statusMax:599 for all)",
    inputSchema: { ...tool.inputSchema, properties: props } as Tool["inputSchema"],
  };
}

const REQ_LINE = /^reqid=\S+\s+\S+\s+.*?\s\[([^\]]+)\]/;

/**
 * Post-filter a list_network_requests result by HTTP status band. Numeric
 * statuses must fall in [min,max]; non-numeric statuses (failures like
 * net::ERR_*, or "pending") are kept whenever the band reaches into errors
 * (max >= 400), since a failed request is the most important kind. The pagination
 * header is replaced with a concise filtered summary.
 */
export function filterNetworkResult(
  result: CallToolResult,
  args: Record<string, unknown> | undefined,
): CallToolResult {
  if (!Array.isArray(result.content)) return result;
  const idx = result.content.findIndex((c) => c.type === "text");
  if (idx < 0) return result;
  const part = result.content[idx] as { type: "text"; text: string };

  const min = clampStatus(args?.statusMin, config.networkStatusMin);
  const max = clampStatus(args?.statusMax, config.networkStatusMax);

  const lines = part.text.split("\n");
  const reqLines = lines.filter((l) => REQ_LINE.test(l));
  if (reqLines.length === 0) return result; // not a request listing (or empty)

  const keepStatus = (status: string): boolean => {
    const n = Number.parseInt(status, 10);
    if (Number.isFinite(n) && String(n) === status.trim()) return n >= min && n <= max;
    return max >= 400; // failure / pending — keep when querying errors
  };

  const kept = reqLines.filter((l) => keepStatus(l.match(REQ_LINE)![1]));
  const nav = lines.filter((l) => /^(Next page|Previous page|Invalid page)/.test(l));

  const header =
    `## Network requests (status ${min}-${max}${max >= 400 ? "+failed" : ""}): ` +
    `${kept.length} of ${reqLines.length}` +
    (kept.length === 0 ? " — none in range; widen statusMin/statusMax (0-599 = all)" : "");

  const text = [header, ...kept, ...nav].join("\n");
  log(`network filter: kept ${kept.length}/${reqLines.length} (status ${min}-${max})`);
  const content = result.content.map((c, i) =>
    i === idx ? { type: "text" as const, text } : c,
  );
  return { ...result, content };
}

function clampStatus(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(599, Math.round(n))) : fallback;
}
