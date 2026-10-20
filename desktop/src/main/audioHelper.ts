import { spawn } from "node:child_process";
import type { AudioApp } from "@screenshare-bot/shared";

/**
 * Talks to native/audio-helper (Rust): lists which apps are playing sound, and streams
 * a mix of every app except the excluded ones. Chromium's own loopback can only take
 * the whole system mix, Discord call included -- the echo this exists to avoid.
 */

/** 10 ms of 48 kHz stereo float32, the helper's block size. */
export const AUDIO_BLOCK_BYTES = 480 * 2 * 4;

const EXE_NAME_PATTERN = /^[^\\/:*?"<>|,]{1,100}\.exe$/i;
const LIST_TIMEOUT_MS = 5000;

export function isExeName(value: unknown): value is string {
  return typeof value === "string" && EXE_NAME_PATTERN.test(value);
}

/** One entry per app (several processes of the same app share a row), loudest peak wins. */
export function parseAudioApps(json: string): AudioApp[] {
  const sessions = JSON.parse(json) as Array<{ exe?: unknown; peak?: unknown }>;
  const byExe = new Map<string, AudioApp>();
  for (const session of sessions) {
    if (typeof session.exe !== "string" || !session.exe) continue;
    const key = session.exe.toLowerCase();
    const peak = typeof session.peak === "number" ? session.peak : 0;
    const existing = byExe.get(key);
    byExe.set(key, {
      exe: existing?.exe ?? session.exe,
      name: session.exe.replace(/\.exe$/i, ""),
      peak: Math.max(existing?.peak ?? 0, peak),
    });
  }
  return [...byExe.values()].sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
}

/** Re-cuts stdout's arbitrary chunks into whole 10 ms blocks. */
export function createBlockSplitter(onBlock: (block: Buffer) => void): (chunk: Buffer) => void {
  let pending: Buffer = Buffer.alloc(0);
  return (chunk) => {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    while (pending.length >= AUDIO_BLOCK_BYTES) {
      onBlock(pending.subarray(0, AUDIO_BLOCK_BYTES));
      pending = pending.subarray(AUDIO_BLOCK_BYTES);
    }
  };
}

export function listAudioApps(helperPath: string, ownPid: number): Promise<AudioApp[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(helperPath, ["sessions", "--exclude-pid", String(ownPid)], { windowsHide: true });
    let output = "";
    const timer = setTimeout(() => child.kill(), LIST_TIMEOUT_MS);
    child.stdout.on("data", (data: Buffer) => {
      output += data.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`audio-helper sessions exited with ${code}`));
        return;
      }
      try {
        resolve(parseAudioApps(output));
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
}

export interface AppAudioCapture {
  stop(): void;
}

/**
 * Starts the mix. The helper excludes this app's own process tree (ownPid) on top of
 * `exclude`, so watching someone while live never echoes. `onEnded` fires if the helper
 * dies on its own (not after stop()).
 */
export function startAppAudio(
  helperPath: string,
  ownPid: number,
  exclude: string[],
  onBlock: (block: Buffer) => void,
  onEnded: () => void,
): AppAudioCapture {
  const args = ["capture", "--exclude-pid", String(ownPid)];
  if (exclude.length > 0) args.push("--exclude", exclude.join(","));
  const child = spawn(helperPath, args, { windowsHide: true });
  let stopped = false;

  child.stdout.on("data", createBlockSplitter(onBlock));
  child.stderr.on("data", (data: Buffer) => console.warn(`audio-helper: ${data.toString("utf8").trim()}`));
  child.on("error", (error) => console.error("audio-helper failed:", error));
  child.on("close", () => {
    if (!stopped) onEnded();
  });

  return {
    stop() {
      stopped = true;
      // Closing stdin is the helper's cue to exit; kill() covers a helper that hung.
      child.stdin.end();
      setTimeout(() => {
        if (child.exitCode === null) child.kill();
      }, 1000);
    },
  };
}
