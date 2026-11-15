import { describe, expect, it } from "vitest";
import { encodeSizeFor, LEVEL_51_MAX_MACROBLOCKS_PER_SECOND } from "./encodeSize.js";

const macroblocks = (width: number, height: number) => Math.ceil(width / 16) * Math.ceil(height / 16);

describe("encodeSizeFor", () => {
  it("keeps a source already within the chosen quality", () => {
    expect(encodeSizeFor(1920, 1080, 1080, 60)).toEqual({ width: 1920, height: 1080 });
  });

  it("never scales a small source up", () => {
    expect(encodeSizeFor(1280, 720, 1080, 60)).toEqual({ width: 1280, height: 720 });
  });

  it("brings a fullscreen 4K game down to the chosen height", () => {
    expect(encodeSizeFor(3840, 2160, 1080, 60)).toEqual({ width: 1920, height: 1080 });
  });

  it("keeps an ultrawide's aspect ratio", () => {
    const { width, height } = encodeSizeFor(3440, 1440, 1080, 60);
    expect(height).toBe(1080);
    expect(width / height).toBeCloseTo(3440 / 1440, 2);
  });

  it("keeps a stretched 4:3 mode's aspect ratio", () => {
    expect(encodeSizeFor(1440, 1080, 1080, 60)).toEqual({ width: 1440, height: 1080 });
  });

  it("stays within Level 5.1 even when the chosen height would allow more", () => {
    const { width, height } = encodeSizeFor(3840, 2160, 2160, 60);
    expect(macroblocks(width, height) * 60).toBeLessThanOrEqual(LEVEL_51_MAX_MACROBLOCKS_PER_SECOND);
    expect(width / height).toBeCloseTo(16 / 9, 1);
  });

  it("always gives even dimensions", () => {
    const { width, height } = encodeSizeFor(1365, 767, 720, 30);
    expect(width % 2).toBe(0);
    expect(height % 2).toBe(0);
  });
});
