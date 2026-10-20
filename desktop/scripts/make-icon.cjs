// Writes build/icon.png (256x256) for electron-builder, which turns it into the
// installer's and the executable's .ico. Drawn by the same code as the tray icon
// (src/main/tray.ts, compiled to dist/ by `npm run build`), so there is no binary
// artwork to keep in the repository.
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const { drawTrayIcon } = require("../dist/main/tray.js");

const SIZE = 256;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(body));
  return Buffer.concat([length, body, crc]);
}

const bgra = drawTrayIcon(SIZE, false);
// One filter byte (0 = none) per scanline, then RGBA pixels.
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0;
  for (let x = 0; x < SIZE; x++) {
    const from = (y * SIZE + x) * 4;
    const to = y * (SIZE * 4 + 1) + 1 + x * 4;
    raw[to] = bgra[from + 2];
    raw[to + 1] = bgra[from + 1];
    raw[to + 2] = bgra[from];
    raw[to + 3] = bgra[from + 3];
  }
}

const header = Buffer.alloc(13);
header.writeUInt32BE(SIZE, 0);
header.writeUInt32BE(SIZE, 4);
header[8] = 8; // bit depth
header[9] = 6; // RGBA
const png = Buffer.concat([
  PNG_SIGNATURE,
  chunk("IHDR", header),
  chunk("IDAT", zlib.deflateSync(raw)),
  chunk("IEND", Buffer.alloc(0)),
]);

const out = path.resolve(__dirname, "../build/icon.png");
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, png);
console.log(`wrote ${out}`);
