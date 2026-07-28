#!/usr/bin/env node
// Rasterises public/icon.svg's design into the PNG sizes iOS/Android need for
// "add to home screen". Pure Node (zlib) so there is no image dependency.
//
//   node tools/gen-icons.mjs
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const BG = [0x15, 0x18, 0x1d];
const SPARKS = [
  // angle (deg, 0 = up), colour — the five standard suits, evenly spread
  [0, [0xe6, 0x00, 0x00]],
  [72, [0xe6, 0xe6, 0x00]],
  [144, [0x02, 0xec, 0x00]],
  [216, [0x00, 0x37, 0xff]],
  [288, [0x66, 0x00, 0xcc]],
];

/** Renders one pixel by supersampling, so the burst edges stay smooth. */
function pixel(x, y, size) {
  const samples = 3;
  let acc = [0, 0, 0];
  for (let sy = 0; sy < samples; sy++) {
    for (let sx = 0; sx < samples; sx++) {
      acc = add(acc, sample((x + (sx + 0.5) / samples) / size, (y + (sy + 0.5) / samples) / size));
    }
  }
  const n = samples * samples;
  return [acc[0] / n, acc[1] / n, acc[2] / n];
}

const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mix = (a, b, t) => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];

/** Unit-square sampler: a firework bursting outward from the middle. */
function sample(u, v) {
  const dx = u - 0.5;
  const dy = v - 0.5;
  const dist = Math.hypot(dx, dy);
  let colour = BG;

  const INNER = 0.07;
  const OUTER = 0.38;

  for (const [angleDeg, sparkColour] of SPARKS) {
    const angle = (angleDeg * Math.PI) / 180;
    // Distance along and across this ray, in the ray's own frame.
    const along = -dy * Math.cos(angle) + dx * Math.sin(angle);
    const across = dx * Math.cos(angle) + dy * Math.sin(angle);
    if (along < INNER || along > OUTER) continue;
    const width = 0.008 + along * 0.03;
    const ray = Math.exp(-((across / width) ** 2) * 4) * Math.min(1, (OUTER - along) / 0.1);
    colour = mix(colour, sparkColour, Math.min(1, ray));

    // A bright bead at the tip of each ray.
    const bead = Math.hypot(across, along - (OUTER - 0.04));
    colour = mix(colour, sparkColour, Math.exp(-((bead / 0.05) ** 2)));
  }

  // Glowing core.
  colour = mix(colour, [0xff, 0xff, 0xff], Math.exp(-((dist / 0.05) ** 2)));

  // Rounded-square mask so the icon looks right when the platform does not mask it.
  const r = 0.22;
  const cx = Math.max(Math.abs(u - 0.5) - (0.5 - r), 0);
  const cy = Math.max(Math.abs(v - 0.5) - (0.5 - r), 0);
  if (Math.hypot(cx, cy) > r) return [0, 0, 0];

  return colour;
}

function png(size) {
  const raw = Buffer.alloc(size * (size * 3 + 1));
  let p = 0;
  for (let y = 0; y < size; y++) {
    raw[p++] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const [r, g, b] = pixel(x, y, size);
      raw[p++] = Math.round(r);
      raw[p++] = Math.round(g);
      raw[p++] = Math.round(b);
    }
  }

  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return c ^ 0xffffffff;
}

for (const size of [180, 192, 512]) {
  const out = fileURLToPath(new URL(`../public/icon-${size}.png`, import.meta.url));
  writeFileSync(out, png(size));
  console.log(`wrote ${out}`);
}
