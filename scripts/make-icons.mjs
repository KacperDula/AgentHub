#!/usr/bin/env node
// Draws the app icon (1024px) and tray icons as PNGs with no dependencies; electron-builder derives
// .icns/.ico from build/icon.png. Run: node scripts/make-icons.mjs
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const OUT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../apps/desktop/build");

function png(w, h, px) {
  const crc = (buf) => {
    let c = ~0;
    for (const b of buf) {
      c ^= b;
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return ~c >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    px.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// Shapes in a 0..1 coordinate space: a prompt node on top, an agent node, and three children (the live map).
const NODES = [
  [0.5, 0.24, 0.085],
  [0.5, 0.48, 0.085],
  [0.24, 0.76, 0.07],
  [0.5, 0.76, 0.07],
  [0.76, 0.76, 0.07],
];
const EDGES = [
  [0, 1],
  [1, 2],
  [1, 3],
  [1, 4],
];
const segDist = (x, y, [ax, ay], [bx, by]) => {
  const dx = bx - ax,
    dy = by - ay;
  const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(x - ax - t * dx, y - ay - t * dy);
};
const roundRect = (x, y, r) => {
  const qx = Math.abs(x - 0.5) - (0.5 - r),
    qy = Math.abs(y - 0.5) - (0.5 - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
};

function draw(size, { mono, background }) {
  const px = Buffer.alloc(size * size * 4);
  const aa = 1.2 / size;
  const S = 4; // supersampling
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      let r = 0,
        g = 0,
        b = 0,
        a = 0;
      for (let sy = 0; sy < S; sy++)
        for (let sx = 0; sx < S; sx++) {
          const u = (x + (sx + 0.5) / S) / size,
            v = (y + (sy + 0.5) / S) / size;
          let cr = 0,
            cg = 0,
            cb = 0,
            ca = 0;
          if (background && roundRect(u, v, 0.22) < 0) [cr, cg, cb, ca] = [13, 18, 24, 255];
          const edge = Math.min(...EDGES.map(([i, j]) => segDist(u, v, NODES[i], NODES[j])));
          if (edge < 0.022) [cr, cg, cb, ca] = mono ? [0, 0, 0, 255] : [31, 120, 112, 255];
          NODES.forEach(([nx, ny, nr], i) => {
            const d = Math.hypot(u - nx, v - ny);
            if (d < nr)
              [cr, cg, cb, ca] = mono
                ? [0, 0, 0, 255]
                : i === 0
                  ? [56, 189, 248, 255]
                  : i === 1
                    ? [45, 212, 191, 255]
                    : [167, 139, 250, 255];
          });
          r += cr;
          g += cg;
          b += cb;
          a += ca;
        }
      const n = S * S,
        o = (y * size + x) * 4;
      px[o] = r / n;
      px[o + 1] = g / n;
      px[o + 2] = b / n;
      px[o + 3] = a / n;
      void aa;
    }
  return png(size, size, px);
}

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, "icon.png"), draw(1024, { background: true }));
fs.writeFileSync(path.join(OUT, "tray.png"), draw(32, {}));
fs.writeFileSync(path.join(OUT, "trayTemplate.png"), draw(16, { mono: true }));
fs.writeFileSync(path.join(OUT, "trayTemplate@2x.png"), draw(32, { mono: true }));
console.log("icons written to", OUT);
