#!/usr/bin/env node
/**
 * Offline test for the focused-screenshot optimizer (no browser, no model).
 *
 * Builds a synthetic 1920x1080 PNG, runs it through optimizeScreenshotResult
 * for several regions, and asserts the output is a cropped, downscaled WebP.
 * Also checks transformScreenshotTool makes `region` required.
 *
 *   npm run build && node scripts/screenshot.mjs
 */

import sharp from "sharp";
import {
  optimizeScreenshotResult,
  transformScreenshotTool,
} from "../dist/screenshot.js";

let failures = 0;
const check = (cond, msg) => {
  process.stdout.write(`${cond ? "ok  " : "FAIL"} ${msg}\n`);
  if (!cond) failures++;
};

// --- schema rewrite -------------------------------------------------------
const tool = transformScreenshotTool({
  name: "take_screenshot",
  description: "Take a screenshot of the page or element.",
  inputSchema: {
    type: "object",
    properties: { format: {}, quality: {}, fullPage: {}, uid: {}, filePath: {} },
  },
});
check(tool.inputSchema.required?.includes("region"), "region is required in rewritten schema");
check(!!tool.inputSchema.properties.region, "region property added");
check(!tool.inputSchema.properties.format, "upstream format param dropped");
check(!!tool.inputSchema.properties.fullPage, "upstream fullPage param preserved");

// --- image pipeline -------------------------------------------------------
const SRC_W = 1920;
const SRC_H = 1080;
const pngBuf = await sharp({
  create: { width: SRC_W, height: SRC_H, channels: 3, background: "#3366aa" },
})
  .png()
  .toBuffer();

const makeResult = () => ({
  content: [
    { type: "text", text: "Took a screenshot." },
    { type: "image", data: pngBuf.toString("base64"), mimeType: "image/png" },
  ],
});

async function run(region, args = {}) {
  const res = await optimizeScreenshotResult(makeResult(), { region, ...args });
  const img = res.content.find((c) => c.type === "image");
  const meta = await sharp(Buffer.from(img.data, "base64")).metadata();
  return { res, img, meta, bytes: Buffer.from(img.data, "base64").length };
}

const full = await run("full");
check(full.img.mimeType === "image/webp", "output mime is image/webp");
check(full.meta.format === "webp", "output is decodable as webp");
check(full.meta.width === 1024, `full downscaled to maxWidth 1024 (got ${full.meta.width})`);
check(full.bytes < pngBuf.length, `webp smaller than source PNG (${full.bytes} < ${pngBuf.length})`);
check(
  full.res.content[0].type === "text" && full.res.content[0].text.includes("region=full"),
  "note prepended describing the crop",
);

const strip = await run("top-strip");
// 20% of 1080 = 216, then downscaled by 1024/1920 ≈ 0.533 -> ~115
check(strip.meta.width === 1024, "top-strip width capped at 1024");
check(
  strip.meta.height > 100 && strip.meta.height < 130,
  `top-strip height ≈ 20% scaled (got ${strip.meta.height})`,
);

const center = await run("center");
check(center.meta.width === 960, `center width = half of 1920, under cap (got ${center.meta.width})`);
check(center.meta.height === 540, `center height = half of 1080 (got ${center.meta.height})`);

const tiny = await run("full", { maxWidth: 512, quality: 30 });
check(tiny.meta.width === 512, `maxWidth override honored (got ${tiny.meta.width})`);
check(tiny.bytes < full.bytes, "lower maxWidth+quality yields smaller file");

// filePath path: no inline image -> passed through untouched
const noImg = await optimizeScreenshotResult(
  { content: [{ type: "text", text: "Saved screenshot to /tmp/x.png" }] },
  { region: "full" },
);
check(noImg.content.length === 1 && noImg.content[0].type === "text", "no-image result passed through");

process.stdout.write(failures ? `\n${failures} CHECK(S) FAILED\n` : "\nALL CHECKS PASSED\n");
process.exit(failures ? 1 : 0);
