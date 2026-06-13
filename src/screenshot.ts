/**
 * Focused-screenshot optimizer.
 *
 * Claude charges for images by their pixel area (~tiles), not by file size, so
 * the only way to make a screenshot cheap is to send FEWER pixels. WebP quality
 * shrinks bytes (latency + payload limits) but not tokens; cropping and
 * downscaling shrink tokens.
 *
 * This module rewrites the upstream `take_screenshot` tool so Claude is FORCED
 * to declare a focus `region` up front, then post-processes the returned image
 * with sharp: crop to that region, downscale to a max width, and re-encode as
 * WebP. The page itself is never resized, so there are no layout side effects.
 */

import sharp from "sharp";
import {
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { config, log } from "./config.js";

/** Focus regions Claude can request. Each maps to a fraction of the image. */
export const SCREENSHOT_REGIONS = [
  "full",
  "top",
  "bottom",
  "left",
  "right",
  "center",
  "top-strip",
  "bottom-strip",
] as const;
export type ScreenshotRegion = (typeof SCREENSHOT_REGIONS)[number];

/** Arguments the proxy adds on top of the upstream take_screenshot schema. */
const PROXY_KEYS = ["region", "maxWidth", "quality"] as const;

interface Crop {
  left: number;
  top: number;
  width: number;
  height: number;
}

const clampInt = (v: number, lo: number, hi: number): number =>
  Math.max(lo, Math.min(hi, Math.round(v)));

/** Map a named region to an integer pixel box inside a W×H image. */
function regionToCrop(region: ScreenshotRegion, w: number, h: number): Crop {
  switch (region) {
    case "top":
      return { left: 0, top: 0, width: w, height: Math.round(h / 2) };
    case "bottom":
      return { left: 0, top: Math.round(h / 2), width: w, height: h - Math.round(h / 2) };
    case "left":
      return { left: 0, top: 0, width: Math.round(w / 2), height: h };
    case "right":
      return { left: Math.round(w / 2), top: 0, width: w - Math.round(w / 2), height: h };
    case "center":
      return {
        left: Math.round(w / 4),
        top: Math.round(h / 4),
        width: Math.round(w / 2),
        height: Math.round(h / 2),
      };
    case "top-strip":
      return { left: 0, top: 0, width: w, height: clampInt(h * 0.2, 1, h) };
    case "bottom-strip": {
      const sh = clampInt(h * 0.2, 1, h);
      return { left: 0, top: h - sh, width: w, height: sh };
    }
    case "full":
    default:
      return { left: 0, top: 0, width: w, height: h };
  }
}

/**
 * Rewrite the upstream take_screenshot tool so the proxy's focus parameters are
 * advertised to Claude and a focus `region` is required. The upstream-only
 * params we drive ourselves (`format`) are removed to avoid confusion.
 */
export function transformScreenshotTool(tool: Tool): Tool {
  const upstream = (tool.inputSchema?.properties ?? {}) as Record<string, unknown>;
  // Keep the upstream params we still forward (uid, fullPage, filePath); drop
  // format because the proxy always re-encodes the output itself.
  const { format: _drop, quality: _dropQ, ...kept } = upstream;

  const properties: Record<string, unknown> = {
    ...kept,
    region: {
      type: "string",
      enum: [...SCREENSHOT_REGIONS],
      description:
        "REQUIRED. Which part of the page to keep, so the image stays cheap. " +
        "'full' = whole capture (still downscaled); 'top'/'bottom'/'left'/'right' = that half; " +
        "'center' = central quarter; 'top-strip'/'bottom-strip' = top/bottom 20% band " +
        "(use for headers/footers). Pick the smallest region that answers your question.",
    },
    maxWidth: {
      type: "number",
      description: `Max output width in px (default ${config.screenshotMaxWidth}). Image is downscaled to fit; never enlarged. Lower = fewer tokens.`,
      minimum: 64,
      maximum: 4096,
    },
    quality: {
      type: "number",
      description: `WebP quality 0-100 (default ${config.screenshotQuality}). Affects file size/latency, not token count.`,
      minimum: 1,
      maximum: 100,
    },
  };

  const required = Array.from(new Set([...(tool.inputSchema?.required ?? []), "region"]));

  return {
    ...tool,
    description:
      (tool.description ?? "Take a screenshot of the page or element.") +
      " [proxy] Focus-optimized: a `region` is required and the result is cropped, " +
      "downscaled, and returned as WebP to keep token usage low.",
    inputSchema: {
      ...tool.inputSchema,
      properties,
      required,
    } as Tool["inputSchema"],
  };
}

/** Strip proxy-only keys and force a lossless source format for upstream. */
export function upstreamScreenshotArgs(
  args: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(args ?? {}) };
  for (const k of PROXY_KEYS) delete out[k];
  // Ask upstream for a lossless PNG so OUR crop+downscale+WebP is the only lossy
  // step. (If the screenshot is written to disk via filePath, this is moot.)
  out.format = "png";
  delete out.quality;
  return out;
}

const fmtBytes = (n: number): string =>
  n < 1024 ? `${n}B` : `${(n / 1024).toFixed(1)}KB`;

/**
 * Post-process a take_screenshot result: crop to the requested region,
 * downscale to maxWidth, and re-encode as WebP. Returns the original result
 * unchanged if there is no inline image (e.g. filePath was used) or on any
 * failure — a screenshot must never break the run.
 */
export async function optimizeScreenshotResult(
  result: CallToolResult,
  args: Record<string, unknown> | undefined,
): Promise<CallToolResult> {
  if (!Array.isArray(result.content)) return result;
  const imgIdx = result.content.findIndex(
    (c) => c.type === "image" && typeof (c as { data?: unknown }).data === "string",
  );
  if (imgIdx < 0) return result; // nothing to optimize (e.g. saved to filePath)

  const region = (args?.region as ScreenshotRegion) ?? "full";
  const maxWidth = clampInt(
    Number(args?.maxWidth) || config.screenshotMaxWidth,
    64,
    4096,
  );
  const quality = clampInt(Number(args?.quality) || config.screenshotQuality, 1, 100);

  try {
    const part = result.content[imgIdx] as { type: "image"; data: string; mimeType?: string };
    const srcBuf = Buffer.from(part.data, "base64");
    const srcBytes = srcBuf.length;

    let img = sharp(srcBuf);
    const meta = await img.metadata();
    const w = meta.width ?? 0;
    const h = meta.height ?? 0;
    if (!w || !h) return result;

    const crop = regionToCrop(region, w, h);
    if (region !== "full") {
      img = img.extract({
        left: clampInt(crop.left, 0, w - 1),
        top: clampInt(crop.top, 0, h - 1),
        width: clampInt(crop.width, 1, w - crop.left),
        height: clampInt(crop.height, 1, h - crop.top),
      });
    }
    if (crop.width > maxWidth) {
      img = img.resize({ width: maxWidth, withoutEnlargement: true });
    }
    const outBuf = await img.webp({ quality }).toBuffer();
    const outMeta = await sharp(outBuf).metadata();

    const note =
      `[focused screenshot] region=${region} ${outMeta.width}x${outMeta.height} webp q${quality} ` +
      `(from ${w}x${h}, ${fmtBytes(srcBytes)} -> ${fmtBytes(outBuf.length)})`;
    log(note);

    const newImage = {
      type: "image" as const,
      data: outBuf.toString("base64"),
      mimeType: "image/webp",
    };
    const content = result.content.map((c, i) => (i === imgIdx ? newImage : c));
    // Prepend a one-line note so Claude knows what it is looking at.
    content.unshift({ type: "text", text: note });
    return { ...result, content };
  } catch (err) {
    log(`screenshot optimize failed (passing original): ${err instanceof Error ? err.message : String(err)}`);
    return result;
  }
}
