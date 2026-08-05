#!/usr/bin/env node
// Render the raster icons from public/favicon.svg.
//
// Uses the Chromium that Playwright already installs for the browser tests
// rather than adding an image toolchain: no sharp, no librsvg, no ImageMagick,
// and the renderer is the same engine that will draw the SVG favicon in a tab.
//
// Run after editing the SVG:  pnpm icons
//
// The SVG is rendered as-is, with no recolouring and no wrapper tile. It draws
// its own violet background precisely so that every output — SVG, .ico, the
// manifest PNGs, apple-touch-icon — is the same image. apple-touch-icon in
// particular is composited by iOS onto its own background and ignores
// transparency, so a mark that relies on the surface behind it cannot be made
// to work there.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";

const OUT = "public";

// 16/32/48 go into the .ico; 180 is apple-touch; 192/512 are the manifest.
const SIZES = [16, 32, 48, 180, 192, 512];

const svg = readFileSync(path.join(OUT, "favicon.svg"), "utf8");

function page(size) {
  return `<!doctype html><html><body style="margin:0">
    <div style="width:${size}px;height:${size}px">${svg.replace("<svg", `<svg width="${size}" height="${size}"`)}</div>
  </body></html>`;
}

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
const rendered = new Map();
for (const size of SIZES) {
  const p = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
  await p.setContent(page(size));
  // omitBackground so the tile's rounded corners stay transparent instead of
  // being filled with white.
  const buf = await p.screenshot({ omitBackground: true, type: "png" });
  rendered.set(size, buf);
  await p.close();
  const name = size === 180 ? "apple-touch-icon.png" : `icon-${size}.png`;
  writeFileSync(path.join(OUT, name), buf);
  console.log(`  ${name.padEnd(22)} ${String(buf.length).padStart(6)} bytes`);
}
await browser.close();

// ICO container. The format is a 6-byte header, then one 16-byte directory
// entry per image, then the images themselves. PNG payloads are legal in ICO
// and understood by every browser in use, so no BMP encoding is needed.
function ico(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // 1 = icon
  header.writeUInt16LE(images.length, 4);

  const dir = Buffer.alloc(16 * images.length);
  let offset = header.length + dir.length;
  images.forEach(({ size, data }, i) => {
    const at = i * 16;
    dir.writeUInt8(size >= 256 ? 0 : size, at + 0); // width, 0 means 256
    dir.writeUInt8(size >= 256 ? 0 : size, at + 1); // height
    dir.writeUInt8(0, at + 2); // palette size — 0 for PNG
    dir.writeUInt8(0, at + 3); // reserved
    dir.writeUInt16LE(1, at + 4); // colour planes
    dir.writeUInt16LE(32, at + 6); // bits per pixel
    dir.writeUInt32LE(data.length, at + 8);
    dir.writeUInt32LE(offset, at + 12);
    offset += data.length;
  });
  return Buffer.concat([header, dir, ...images.map((i) => i.data)]);
}

const icoBuf = ico([16, 32, 48].map((size) => ({ size, data: rendered.get(size) })));
writeFileSync(path.join(OUT, "favicon.ico"), icoBuf);
console.log(`  favicon.ico            ${String(icoBuf.length).padStart(6)} bytes  (16, 32, 48)`);
