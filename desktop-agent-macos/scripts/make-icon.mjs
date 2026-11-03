/**
 * Draw the app icon and write it as a 1024 PNG.
 *
 * There is no SVG rasteriser on this machine that works from a sandboxed shell
 * (`sips` cannot read SVG, `qlmanage` fails to start its sandbox, and Electron's
 * own capture path never settles for a hidden window), so the drawing is done
 * here with signed-distance fields and encoded by hand. It has no dependencies
 * and produces the same bytes on every run.
 *
 * The artwork is the product's one sentence: three sources enter from the left,
 * one fused answer leaves to the right. Shapes are kept to a handful of
 * primitives on purpose — a Dock icon is read at 32px far more often than at
 * 1024.
 *
 * Usage: node scripts/make-icon.mjs [out.png]        (default resources/icon.png)
 *
 * The .icns is then built from that PNG, because `iconutil` cannot read a PNG
 * that is not part of an .iconset:
 *
 *   mkdir icon.iconset
 *   for n in 16 32 128 256 512; do
 *     sips -Z $n        resources/icon.png --out icon.iconset/icon_${n}x${n}.png
 *     sips -Z $((n * 2)) resources/icon.png --out icon.iconset/icon_${n}x${n}@2x.png
 *   done
 *   iconutil -c icns icon.iconset -o resources/icon.icns
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const OUT = 1024;
const SS = 2; // supersample factor; downsampled 2x2 for clean edges
const N = OUT * SS;

const here = path.dirname(new URL(import.meta.url).pathname);
const target = path.resolve(process.argv[2] ?? path.join(here, '..', 'resources', 'icon.png'));

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const mix = (a, b, t) => a + (b - a) * t;
const hex = value => [
  parseInt(value.slice(1, 3), 16),
  parseInt(value.slice(3, 5), 16),
  parseInt(value.slice(5, 7), 16)
];

const PLATE_TOP = hex('#232A4D');
const PLATE_BOTTOM = hex('#0A0C13');
const IN_FROM = hex('#6F8BFF');
const IN_TO = hex('#3FD8F0');
const OUT_FROM = hex('#FFFFFF');
const OUT_TO = hex('#BFD0FF');
const CORE = hex('#EAF0FF');

// --- geometry, in the 1024 grid -------------------------------------------

const PLATE = { cx: 512, cy: 512, half: 412, radius: 185 };
const CONVERGE = { x: 566, y: 512 };
const OUTPUT_END = { x: 786, y: 512 };
const SOURCES = [
  { x: 262, y: 330 },
  { x: 262, y: 512 },
  { x: 262, y: 694 }
];
const IN_WIDTH = 64;
const OUT_WIDTH = 96;
const CORE_R = 48; // matches the output line's half-width, so the two meet flush
const HALO_R = 62;

const roundRect = (x, y, { cx, cy, half, radius }) => {
  const qx = Math.abs(x - cx) - (half - radius);
  const qy = Math.abs(y - cy) - (half - radius);
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  return outside + Math.min(Math.max(qx, qy), 0) - radius;
};

const capsule = (x, y, a, b, radius) => {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  const t = lengthSq === 0 ? 0 : clamp(((x - a.x) * dx + (y - a.y) * dy) / lengthSq, 0, 1);
  return Math.hypot(x - (a.x + dx * t), y - (a.y + dy * t)) - radius;
};

// --- raster ----------------------------------------------------------------

const pixels = new Float32Array(N * N * 4); // straight alpha, 0..1

function blend(index, [r, g, b], alpha) {
  if (alpha <= 0) return;
  const a = clamp(alpha, 0, 1);
  const dstA = pixels[index + 3];
  const outA = a + dstA * (1 - a);
  if (outA <= 0) return;
  pixels[index] = (r * a + pixels[index] * dstA * (1 - a)) / outA;
  pixels[index + 1] = (g * a + pixels[index + 1] * dstA * (1 - a)) / outA;
  pixels[index + 2] = (b * a + pixels[index + 2] * dstA * (1 - a)) / outA;
  pixels[index + 3] = outA;
}

// coverage of a shape given its signed distance, in supersample pixels
const cover = distance => clamp(0.5 - distance * SS, 0, 1);

for (let py = 0; py < N; py += 1) {
  const y = (py + 0.5) / SS;
  for (let px = 0; px < N; px += 1) {
    const x = (px + 0.5) / SS;
    const index = (py * N + px) * 4;

    // the plate
    const dPlate = roundRect(x, y, PLATE);
    if (dPlate < 1) {
      const t = clamp((y - 100) / 824, 0, 1);
      const colour = [
        mix(PLATE_TOP[0], PLATE_BOTTOM[0], t),
        mix(PLATE_TOP[1], PLATE_BOTTOM[1], t),
        mix(PLATE_TOP[2], PLATE_BOTTOM[2], t)
      ];
      // a soft light from the upper left, so the plate is not a flat slab
      const glow = Math.max(0, 1 - Math.hypot(x - 330, y - 240) / 620) ** 2 * 0.22;
      blend(index, colour, cover(dPlate));
      if (glow > 0) blend(index, [143, 162, 255], cover(dPlate) * glow);
    }

    if (dPlate > 0) continue;

    // three sources converging
    for (const source of SOURCES) {
      const d = capsule(x, y, source, CONVERGE, IN_WIDTH / 2);
      if (d > 1) continue;
      const t = clamp((x - 262) / (CONVERGE.x - 262), 0, 1);
      blend(
        index,
        [mix(IN_FROM[0], IN_TO[0], t), mix(IN_FROM[1], IN_TO[1], t), mix(IN_FROM[2], IN_TO[2], t)],
        cover(d)
      );
    }

    // the fused answer
    const dOut = capsule(x, y, CONVERGE, OUTPUT_END, OUT_WIDTH / 2);
    if (dOut < 1) {
      const t = clamp((x - CONVERGE.x) / (OUTPUT_END.x - CONVERGE.x), 0, 1);
      blend(
        index,
        [
          mix(OUT_FROM[0], OUT_TO[0], t),
          mix(OUT_FROM[1], OUT_TO[1], t),
          mix(OUT_FROM[2], OUT_TO[2], t)
        ],
        cover(dOut)
      );
    }

    // convergence point, with a halo that fades instead of a blur filter.
    // The halo has to start at the core's edge: leaving a gap there exposed the
    // plate between a white dot and a white glow, which read as a dirty ring.
    const dCore = Math.hypot(x - CONVERGE.x, y - CONVERGE.y);
    if (dCore > CORE_R && dCore < CORE_R + 110) {
      const falloff = Math.exp(-(dCore - CORE_R) / 24);
      blend(index, [255, 255, 255], 0.34 * falloff);
    }
    if (dCore < CORE_R + 1) {
      const t = clamp(dCore / CORE_R, 0, 1);
      blend(
        index,
        [mix(255, CORE[0], t), mix(255, CORE[1], t), mix(255, CORE[2], t)],
        cover(dCore - CORE_R)
      );
    }
  }
}

// --- downsample ------------------------------------------------------------

const rgba = Buffer.alloc(OUT * OUT * 4);
for (let y = 0; y < OUT; y += 1) {
  for (let x = 0; x < OUT; x += 1) {
    let r = 0;
    let g = 0;
    let b = 0;
    let a = 0;
    for (let sy = 0; sy < SS; sy += 1) {
      for (let sx = 0; sx < SS; sx += 1) {
        const i = ((y * SS + sy) * N + (x * SS + sx)) * 4;
        const alpha = pixels[i + 3];
        r += pixels[i] * alpha;
        g += pixels[i + 1] * alpha;
        b += pixels[i + 2] * alpha;
        a += alpha;
      }
    }
    const count = SS * SS;
    const offset = (y * OUT + x) * 4;
    if (a > 0) {
      rgba[offset] = Math.round(clamp(r / a, 0, 255));
      rgba[offset + 1] = Math.round(clamp(g / a, 0, 255));
      rgba[offset + 2] = Math.round(clamp(b / a, 0, 255));
    }
    rgba[offset + 3] = Math.round(clamp((a / count) * 255, 0, 255));
  }
}

// --- PNG -------------------------------------------------------------------

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

const crc32 = buffer => {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

const chunk = (type, data) => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
};

const header = Buffer.alloc(13);
header.writeUInt32BE(OUT, 0);
header.writeUInt32BE(OUT, 4);
header[8] = 8; // bit depth
header[9] = 6; // RGBA
header[10] = 0;
header[11] = 0;
header[12] = 0;

const raw = Buffer.alloc(OUT * (OUT * 4 + 1));
for (let y = 0; y < OUT; y += 1) {
  raw[y * (OUT * 4 + 1)] = 0; // filter: none
  rgba.copy(raw, y * (OUT * 4 + 1) + 1, y * OUT * 4, (y + 1) * OUT * 4);
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', header),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0))
]);

fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, png);
console.log(`ok ${path.relative(process.cwd(), target)} ${String(OUT)}x${String(OUT)} ${String(png.length)} bytes`);
