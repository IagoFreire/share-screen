import { describe, expect, it } from "vitest";
import { qualityButtonLabel, qualityMenuItems } from "./qualityMenu.js";

const LAYERS = [
  { layer: 0, height: 1080, framerate: 60 },
  { layer: 1, height: 720, framerate: 30 },
  { layer: 2, height: 480, framerate: 30 },
];

describe("quality menu", () => {
  it("shows what Auto picked", () => {
    expect(qualityButtonLabel(LAYERS, "auto", 1)).toBe("Auto · 720p");
  });

  it("shows a fixed choice", () => {
    expect(qualityButtonLabel(LAYERS, 0, 0)).toBe("1080p60");
  });

  it("lists Auto first, then every layer, marking the current choice", () => {
    expect(qualityMenuItems(LAYERS, "auto", 2)).toEqual([
      { choice: "auto", label: "Automático", detail: "480p30", selected: true },
      { choice: 0, label: "1080p", detail: "60 fps", selected: false },
      { choice: 1, label: "720p", detail: "30 fps", selected: false },
      { choice: 2, label: "480p", detail: "30 fps", selected: false },
    ]);
  });
});
