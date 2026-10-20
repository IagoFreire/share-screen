import { describe, expect, it } from "vitest";
import { AUDIO_BLOCK_BYTES, createBlockSplitter, isExeName, parseAudioApps } from "./audioHelper.js";

describe("parseAudioApps", () => {
  it("groups sessions by app, keeping the loudest peak", () => {
    const json = JSON.stringify([
      { pid: 1, exe: "Discord.exe", peak: 0.1 },
      { pid: 2, exe: "Discord.exe", peak: 0.4 },
      { pid: 3, exe: "brave.exe", peak: 0.2 },
    ]);

    expect(parseAudioApps(json)).toEqual([
      { exe: "brave.exe", name: "brave", peak: 0.2 },
      { exe: "Discord.exe", name: "Discord", peak: 0.4 },
    ]);
  });

  it("drops sessions without an executable name", () => {
    expect(parseAudioApps(JSON.stringify([{ pid: 9, exe: "", peak: 0 }]))).toEqual([]);
  });
});

describe("isExeName", () => {
  it("accepts plain executable names", () => {
    expect(isExeName("Discord.exe")).toBe(true);
    expect(isExeName("Spotify Launcher.exe")).toBe(true);
  });

  it("rejects paths, lists and non-strings", () => {
    expect(isExeName("C:\\x\\a.exe")).toBe(false);
    expect(isExeName("a.exe,b.exe")).toBe(false);
    expect(isExeName("notes.txt")).toBe(false);
    expect(isExeName(42)).toBe(false);
  });
});

describe("createBlockSplitter", () => {
  it("emits whole 10 ms blocks no matter how stdout chunks the stream", () => {
    const blocks: number[] = [];
    const push = createBlockSplitter((block) => blocks.push(block.length));

    push(Buffer.alloc(AUDIO_BLOCK_BYTES - 100));
    push(Buffer.alloc(AUDIO_BLOCK_BYTES + 200));
    push(Buffer.alloc(AUDIO_BLOCK_BYTES - 100));

    expect(blocks).toEqual([AUDIO_BLOCK_BYTES, AUDIO_BLOCK_BYTES, AUDIO_BLOCK_BYTES]);
  });
});
