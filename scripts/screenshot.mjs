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
  enforceImageCap,
  elementScreenshotTool,
  takeElementScreenshot,
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

// --- per-side cap ---------------------------------------------------------
const tallPng = await sharp({ create: { width: 1500, height: 9000, channels: 3, background: "#246" } })
  .png().toBuffer();
const tallRes = {
  content: [
    { type: "text", text: "shot" },
    { type: "image", data: tallPng.toString("base64"), mimeType: "image/png" },
  ],
};
const capped = await optimizeScreenshotResult(tallRes, { region: "full", maxWidth: 1024 });
check(!capped.content.some((c) => c.type === "image"), "over-cap full-page image withheld (no image returned)");
check(capped.content[0].text.includes("withheld") && capped.content[0].text.includes("3000px"), "withheld message explains the cap + remedies");

const wide = await sharp({ create: { width: 4000, height: 100, channels: 3, background: "#246" } }).png().toBuffer();
const wideRes = { content: [{ type: "image", data: wide.toString("base64"), mimeType: "image/png" }] };
const wideCap = await enforceImageCap(wideRes);
check(!wideCap.content.some((c) => c.type === "image"), "enforceImageCap withholds an over-wide pass-through image");

const okSmall = await enforceImageCap({ content: [{ type: "image", data: (await sharp({ create: { width: 800, height: 600, channels: 3, background: "#246" } }).png().toBuffer()).toString("base64"), mimeType: "image/png" }] });
check(okSmall.content.some((c) => c.type === "image"), "enforceImageCap leaves an in-range image intact");

// --- element screenshot ---------------------------------------------------
const eTool = elementScreenshotTool();
check(eTool.name === "take_element_screenshot" && eTool.inputSchema.required.includes("uid"), "element tool requires uid");

// Mock upstream: evaluate_script returns the box, take_screenshot returns a full-page PNG.
const pagePng = await sharp({ create: { width: 1000, height: 5000, channels: 3, background: "#135" } }).png().toBuffer();
const mockCall = (box) => async (name) => {
  if (name === "evaluate_script")
    return { content: [{ type: "text", text: "Script ran on page and returned:\n```json\n" + JSON.stringify(box) + "\n```" }] };
  if (name === "take_screenshot")
    return { content: [{ type: "text", text: "ok" }, { type: "image", data: pagePng.toString("base64"), mimeType: "image/png" }] };
  throw new Error("unexpected " + name);
};

const elBox = { x: 100, y: 200, w: 300, h: 150, docW: 1000, docH: 5000 };
const elRes = await takeElementScreenshot(mockCall(elBox), { uid: "el-1", padding: 10 });
const elImg = elRes.content.find((c) => c.type === "image");
check(!!elImg, "element screenshot returns an image");
const elMeta = await sharp(Buffer.from(elImg.data, "base64")).metadata();
check(elMeta.format === "webp", "element output is webp");
// scale = 1; crop = (w+2*pad) x (h+2*pad) = 320 x 170
check(elMeta.width === 320 && elMeta.height === 170, `element crop = element+padding (got ${elMeta.width}x${elMeta.height})`);
check(elRes.content[0].text.includes("uid=el-1") && elRes.content[0].text.includes("+10px"), "element note describes uid + padding");

const noUid = await takeElementScreenshot(mockCall(elBox), {});
check(noUid.isError && noUid.content[0].text.includes("uid"), "missing uid errors with guidance");

const hugeBox = { x: 50, y: 100, w: 300, h: 4000, docW: 1000, docH: 5000 };
const hugeRes = await takeElementScreenshot(mockCall(hugeBox), { uid: "el-big", padding: 10 });
check(!hugeRes.content.some((c) => c.type === "image"), "over-cap element withheld");
check(hugeRes.content[0].text.includes("withheld"), "over-cap element returns guidance");

process.stdout.write(failures ? `\n${failures} CHECK(S) FAILED\n` : "\nALL CHECKS PASSED\n");
process.exit(failures ? 1 : 0);
