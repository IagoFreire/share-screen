// Builds native/audio-helper (Rust) in release mode. Finds the toolchain on its own so
// nobody has to edit PATH: cargo from rustup's default location, and a MinGW-w64
// "bin" folder (dlltool + as, which the windows-gnu target needs) from WinLibs as
// installed by winget -- or from MINGW_BIN when it lives elsewhere.
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function findCargo() {
  const rustup = path.join(os.homedir(), ".cargo", "bin", "cargo.exe");
  return fs.existsSync(rustup) ? rustup : "cargo";
}

function findMingwBin() {
  if (process.env.MINGW_BIN) return process.env.MINGW_BIN;
  const packages = path.join(process.env.LOCALAPPDATA ?? "", "Microsoft", "WinGet", "Packages");
  if (!fs.existsSync(packages)) return null;
  const winlibs = fs.readdirSync(packages).find((name) => name.startsWith("BrechtSanders.WinLibs"));
  const bin = winlibs ? path.join(packages, winlibs, "mingw64", "bin") : null;
  return bin && fs.existsSync(bin) ? bin : null;
}

const crate = path.resolve(__dirname, "../native/audio-helper");
const mingw = findMingwBin();
const env = { ...process.env };
if (mingw) env.PATH = `${mingw}${path.delimiter}${env.PATH}`;
else console.warn("MinGW-w64 not found (set MINGW_BIN); the build may fail on dlltool.");

for (const args of [["test"], ["build", "--release"]]) {
  const result = spawnSync(findCargo(), args, { cwd: crate, env, stdio: "inherit" });
  if (result.status !== 0) {
    console.error(`cargo ${args.join(" ")} failed`);
    process.exit(result.status ?? 1);
  }
}
console.log(`built ${path.join(crate, "target", "release", "audio-helper.exe")}`);
