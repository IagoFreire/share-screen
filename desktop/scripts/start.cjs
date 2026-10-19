// Launches the app for development. Terminals opened by VS Code (and other Electron
// hosts) export ELECTRON_RUN_AS_NODE=1, which makes electron.exe behave as plain Node:
// `require("electron")` then returns undefined and the main process crashes on start.
const { spawn } = require("node:child_process");
const path = require("node:path");
const electronBinary = require("electron");

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

spawn(electronBinary, [".", ...process.argv.slice(2)], {
  cwd: path.resolve(__dirname, ".."),
  env,
  stdio: "inherit",
}).on("exit", (code) => process.exit(code ?? 0));
