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

const msgOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const textResult = (text: string, isError = false): CallToolResult => ({
  ...(isError ? { isError: true } : {}),
  content: [{ type: "text", text }],
});

const imageContent = (buf: Buffer) => ({
  type: "image" as const,
  data: buf.toString("base64"),
  mimeType: "image/webp",
});

/** First text part of a result, for parsing helper-tool output. */
function firstText(result: CallToolResult): string {
  if (!Array.isArray(result.content)) return "";
  const t = result.content.find((c) => c.type === "text") as { text?: string } | undefined;
  return t?.text ?? "";
}

/** First inline image part of a result, or undefined. */
function firstImage(result: CallToolResult): { data: string } | undefined {
  if (!Array.isArray(result.content)) return undefined;
  return result.content.find(
    (c) => c.type === "image" && typeof (c as { data?: unknown }).data === "string",
  ) as { data: string } | undefined;
}

/** Guidance returned in place of an image that breaches the per-side cap. */
function capGuidance(w: number, h: number, cap: number, kind: "page" | "element"): string {
  const which = w > cap && h > cap ? "both sides" : w > cap ? "width" : "height";
  const lines = [
    `[screenshot withheld] ${w}x${h}px exceeds the ${cap}px-per-side cap (${which} too large); ` +
      "no image sent — a larger image would blow the token budget and some hosts reject it outright.",
    "Capture a smaller area instead:",
  ];
  if (kind === "page") {
    lines.push(
      "- pick a focus region (top/bottom/left/right/center, or top-strip/bottom-strip)",
      "- lower maxWidth (e.g. 768)",
      "- use take_element_screenshot with a uid to frame just the element you need",
      "- or resize_page to a shorter viewport, or set fullPage:false",
    );
  } else {
    lines.push(
      "- the element is larger than the cap; screenshot a child element by its uid",
      "- or lower maxWidth and re-check",
    );
  }
  return lines.join("\n");
}

/**
 * Enforce the per-side cap on any inline image in a result (used on the
 * pass-through path when full optimization is off). Withholds an oversized
 * image, replacing it with guidance. Returns the result unchanged on success
 * or any failure.
 */
export async function enforceImageCap(result: CallToolResult): Promise<CallToolResult> {
  const img = firstImage(result);
  if (!img) return result;
  try {
    const meta = await sharp(Buffer.from(img.data, "base64")).metadata();
    const w = meta.width ?? 0;
    const h = meta.height ?? 0;
    const cap = config.screenshotMaxSide;
    if (w > cap || h > cap) {
      log(`screenshot withheld: ${w}x${h} over ${cap}px cap`);
      return textResult(capGuidance(w, h, cap, "page"));
    }
  } catch {
    /* leave as-is */
  }
  return result;
}

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
    const outW = outMeta.width ?? 0;
    const outH = outMeta.height ?? 0;

    // Hard per-side cap: withhold an oversized image and tell Claude to narrow.
    const cap = config.screenshotMaxSide;
    if (outW > cap || outH > cap) {
      log(`screenshot withheld: ${outW}x${outH} over ${cap}px cap (region=${region})`);
      return textResult(capGuidance(outW, outH, cap, "page"));
    }

    const note =
      `[focused screenshot] region=${region} ${outW}x${outH} webp q${quality} ` +
      `(from ${w}x${h}, ${fmtBytes(srcBytes)} -> ${fmtBytes(outBuf.length)})`;
    log(note);

    const content = result.content.map((c, i) => (i === imgIdx ? imageContent(outBuf) : c));
    // Prepend a one-line note so Claude knows what it is looking at.
    content.unshift({ type: "text", text: note });
    return { ...result, content };
  } catch (err) {
    log(`screenshot optimize failed (passing original): ${err instanceof Error ? err.message : String(err)}`);
    return result;
  }
}

// --- Element screenshot (by uid, padded, fully covered) -------------------

export const ELEMENT_SCREENSHOT_TOOL = "take_element_screenshot";

/** Synthetic tool the proxy adds: a tight, padded shot of one element. */
export function elementScreenshotTool(): Tool {
  return {
    name: ELEMENT_SCREENSHOT_TOOL,
    description:
      "Screenshot a SINGLE element by its snapshot uid. The proxy measures the " +
      `element, pads it by ${config.screenshotElementPadding}px (configurable), and returns a cropped, ` +
      "downscaled WebP covering the whole element — far cheaper than a page screenshot. " +
      "Get the uid from take_snapshot. Prefer this over take_screenshot for inspecting one component.",
    inputSchema: {
      type: "object",
      properties: {
        uid: {
          type: "string",
          description: "REQUIRED. uid of the element from take_snapshot",
        },
        padding: {
          type: "number",
          description: `Extra px around the element (default ${config.screenshotElementPadding})`,
          minimum: 0,
          maximum: 200,
        },
        maxWidth: {
          type: "number",
          description: `Max output width in px (default ${config.screenshotMaxWidth}); downscaled to fit`,
          minimum: 64,
          maximum: 4096,
        },
        quality: {
          type: "number",
          description: `WebP quality 1-100 (default ${config.screenshotQuality})`,
          minimum: 1,
          maximum: 100,
        },
      },
      required: ["uid"],
    } as Tool["inputSchema"],
  };
}

/**
 * Element geometry probe. Receives the resolved element handle (passed by
 * evaluate_script via the uid in `args`), scrolls it into view, and returns its
 * document-relative box plus the document size for scale calibration.
 */
const BBOX_FN = `(el) => {
  if (!el || typeof el.getBoundingClientRect !== "function") return null;
  if (typeof el.scrollIntoView === "function") el.scrollIntoView({block: "center", inline: "center"});
  const r = el.getBoundingClientRect();
  const d = document.documentElement;
  return {
    x: r.left + window.scrollX,
    y: r.top + window.scrollY,
    w: r.width,
    h: r.height,
    docW: Math.max(d.scrollWidth, d.clientWidth, 1),
    docH: Math.max(d.scrollHeight, d.clientHeight, 1),
  };
}`;

interface Box {
  x: number; y: number; w: number; h: number; docW: number; docH: number;
}

function parseBox(text: string): Box | undefined {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    const o = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
    const n = (k: string) => Number(o[k]);
    const box = { x: n("x"), y: n("y"), w: n("w"), h: n("h"), docW: n("docW"), docH: n("docH") };
    return Object.values(box).every((v) => Number.isFinite(v)) ? box : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Take a padded screenshot of one element by uid. Resolves the element's
 * geometry via evaluate_script, takes a full-page PNG (so even tall/off-screen
 * elements are covered), crops to the element + padding, downscales, WebP-encodes
 * and enforces the per-side cap. `call` forwards a tool to the upstream server.
 */
export async function takeElementScreenshot(
  call: (name: string, args: Record<string, unknown>) => Promise<CallToolResult>,
  args: Record<string, unknown> | undefined,
): Promise<CallToolResult> {
  const uid = typeof args?.uid === "string" ? args.uid.trim() : "";
  if (!uid) {
    return textResult("take_element_screenshot requires a `uid` from take_snapshot.", true);
  }
  const padding = clampInt(Number(args?.padding ?? config.screenshotElementPadding), 0, 200);
  const maxWidth = clampInt(Number(args?.maxWidth) || config.screenshotMaxWidth, 64, 4096);
  const quality = clampInt(Number(args?.quality) || config.screenshotQuality, 1, 100);

  // 1. Resolve element geometry by uid.
  let box: Box | undefined;
  try {
    const ev = await call("evaluate_script", { function: BBOX_FN, args: [uid] });
    if (ev.isError) {
      return textResult(
        `Could not resolve uid "${uid}": ${firstText(ev)}. Take a fresh take_snapshot.`,
        true,
      );
    }
    box = parseBox(firstText(ev));
  } catch (err) {
    return textResult(`Could not resolve uid "${uid}": ${msgOf(err)}. Take a fresh take_snapshot.`, true);
  }
  if (!box) {
    return textResult(`uid "${uid}" did not resolve to an element. Take a fresh take_snapshot.`, true);
  }

  // 2. Full-page PNG so even tall / below-the-fold elements are fully covered.
  let shot: CallToolResult;
  try {
    shot = await call("take_screenshot", { fullPage: true, format: "png" });
  } catch (err) {
    return textResult(`Screenshot failed: ${msgOf(err)}`, true);
  }
  if (shot.isError) return shot;
  const img = firstImage(shot);
  if (!img) return textResult("Upstream returned no image to crop.", true);

  // 3. Crop to element + padding, downscale, WebP, enforce cap.
  try {
    const srcBuf = Buffer.from(img.data, "base64");
    const meta = await sharp(srcBuf).metadata();
    const imgW = meta.width ?? 0;
    const imgH = meta.height ?? 0;
    if (!imgW || !imgH) return textResult("Could not read screenshot dimensions.", true);

    // Calibrate CSS→image scale from the captured size (handles devicePixelRatio).
    const sx = imgW / box.docW;
    const sy = imgH / box.docH;
    const left = clampInt((box.x - padding) * sx, 0, imgW - 1);
    const top = clampInt((box.y - padding) * sy, 0, imgH - 1);
    const width = clampInt((box.w + 2 * padding) * sx, 1, imgW - left);
    const height = clampInt((box.h + 2 * padding) * sy, 1, imgH - top);

    let pipe = sharp(srcBuf).extract({ left, top, width, height });
    if (width > maxWidth) pipe = pipe.resize({ width: maxWidth, withoutEnlargement: true });
    const outBuf = await pipe.webp({ quality }).toBuffer();
    const outMeta = await sharp(outBuf).metadata();
    const outW = outMeta.width ?? 0;
    const outH = outMeta.height ?? 0;

    const cap = config.screenshotMaxSide;
    if (outW > cap || outH > cap) {
      log(`element screenshot withheld: ${outW}x${outH} over ${cap}px cap (uid=${uid})`);
      return textResult(capGuidance(outW, outH, cap, "element"));
    }

    const note =
      `[element screenshot] uid=${uid} +${padding}px ${outW}x${outH} webp q${quality} ` +
      `(element ${Math.round(box.w)}x${Math.round(box.h)} -> ${fmtBytes(outBuf.length)})`;
    log(note);
    return { content: [{ type: "text", text: note }, imageContent(outBuf)] };
  } catch (err) {
    return textResult(`Element crop failed: ${msgOf(err)}`, true);
  }
}
