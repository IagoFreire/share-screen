import { describe, expect, it } from "vitest";
import { mainWindowWebPreferences } from "./windowOptions.js";

describe("mainWindowWebPreferences", () => {
  const prefs = mainWindowWebPreferences("C:/app/preload/index.js");

  it("keeps the player running while the window is minimized or covered", () => {
    expect(prefs.backgroundThrottling).toBe(false);
  });

  it("keeps the renderer locked down", () => {
    expect(prefs).toMatchObject({
      preload: "C:/app/preload/index.js",
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    });
  });
});
