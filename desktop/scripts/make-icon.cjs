// Writes build/icon.png for electron-builder, which turns it into the installer's and
// the executable's .ico. The artwork is static/janja.png (512x512), the same file the
// window and the tray use at runtime; build/ is generated and not kept in git.
const fs = require("node:fs");
const path = require("node:path");

const source = path.resolve(__dirname, "../static/janja.png");
const out = path.resolve(__dirname, "../build/icon.png");
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.copyFileSync(source, out);
console.log(`wrote ${out}`);
