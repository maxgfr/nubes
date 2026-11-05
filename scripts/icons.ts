/**
 * Generates the PWA icons (PNG + SVG) from the nubes mark, a cloud on blue,
 * with no image dependency: the cloud is a union of circles and a rounded
 * bar, rasterized with 4×4 supersampling and written by a minimal PNG
 * encoder. Run with `bun scripts/icons.ts`; output is committed.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { deflateSync } from "node:zlib";

const OUT = resolve(import.meta.dir, "../public/icons");
const BG: [number, number, number] = [47, 111, 222];
const FG: [number, number, number] = [255, 255, 255];

// On a 100-unit grid.
const CIRCLES = [
  { cx: 38, cy: 56, r: 15 },
  { cx: 55, cy: 46, r: 20 },
  { cx: 69, cy: 59, r: 12 },
];
const BAR = { x0: 30, x1: 76, y0: 56, y1: 71, r: 7.5 };

function inCloud(x: number, y: number): boolean {
  for (const c of CIRCLES) if ((x - c.cx) ** 2 + (y - c.cy) ** 2 <= c.r ** 2) return true;
  const qx = Math.max(BAR.x0 + BAR.r - x, 0, x - (BAR.x1 - BAR.r));
  const qy = Math.max(BAR.y0 + BAR.r - y, 0, y - (BAR.y1 - BAR.r));
  return (
    x >= BAR.x0 && x <= BAR.x1 && y >= BAR.y0 && y <= BAR.y1 && qx * qx + qy * qy <= BAR.r ** 2
  );
}

function crc32(buf: Uint8Array): number {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ~c >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

function png(size: number, rgba: Uint8Array): Uint8Array {
  const raw = new Uint8Array(size * (size * 4 + 1));
  for (let y = 0; y < size; y++)
    raw.set(rgba.subarray(y * size * 4, (y + 1) * size * 4), y * (size * 4 + 1) + 1);
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, size);
  dv.setUint32(4, size);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const parts = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", new Uint8Array(deflateSync(raw))),
    chunk("IEND", new Uint8Array()),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** `scale` < 1 shrinks the mark (maskable icons keep a safe zone); `rounded` clips the corners. */
function render(size: number, scale: number, rounded: boolean): Uint8Array {
  const px = new Uint8Array(size * size * 4);
  const S = 4;
  const radius = 22;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let fg = 0;
      let inside = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const u = ((x + (sx + 0.5) / S) / size) * 100;
          const v = ((y + (sy + 0.5) / S) / size) * 100;
          const qx = Math.max(radius - u, 0, u - (100 - radius));
          const qy = Math.max(radius - v, 0, v - (100 - radius));
          if (rounded && qx * qx + qy * qy > radius * radius) continue;
          inside++;
          const cu = 50 + (u - 50) / scale;
          const cv = 50 + (v - 50) / scale;
          if (inCloud(cu, cv)) fg++;
        }
      }
      const a = inside / (S * S);
      const t = inside ? fg / inside : 0;
      const i = (y * size + x) * 4;
      for (let k = 0; k < 3; k++)
        px[i + k] = Math.round((BG[k] as number) * (1 - t) + (FG[k] as number) * t);
      px[i + 3] = Math.round(a * 255);
    }
  }
  return px;
}

mkdirSync(OUT, { recursive: true });
for (const [name, size, scale, rounded] of [
  ["icon-192.png", 192, 1, true],
  ["icon-512.png", 512, 1, true],
  ["maskable-512.png", 512, 0.8, false],
  ["apple-touch-icon.png", 180, 1, false],
] as const) {
  writeFileSync(join(OUT, name), png(size, render(size, scale, rounded)));
}
const circles = CIRCLES.map((c) => `<circle cx="${c.cx}" cy="${c.cy}" r="${c.r}"/>`).join("");
writeFileSync(
  join(OUT, "icon.svg"),
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><title>nubes</title><rect width="100" height="100" rx="22" fill="rgb(${BG.join(",")})"/><g fill="#fff">${circles}<rect x="${BAR.x0}" y="${BAR.y0}" width="${BAR.x1 - BAR.x0}" height="${BAR.y1 - BAR.y0}" rx="${BAR.r}"/></g></svg>\n`,
);
console.log("icons written to public/icons");
