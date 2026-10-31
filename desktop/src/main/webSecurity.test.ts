import { describe, expect, it } from "vitest";
import { buildContentSecurityPolicy, isAllowedPermission } from "./webSecurity.js";

const ORIGIN = "https://share.iagofreire.dev";

function directives(policy: string): Map<string, string> {
  return new Map(
    policy
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const [name, ...values] = part.split(/\s+/);
        return [name, values.join(" ")] as [string, string];
      }),
  );
}

describe("buildContentSecurityPolicy", () => {
  const policy = directives(buildContentSecurityPolicy(ORIGIN));

  it("only runs the server's own scripts, WebAssembly included (noise suppression)", () => {
    expect(policy.get("script-src")).toBe("'self' 'wasm-unsafe-eval'");
    expect(policy.get("object-src")).toBe("'none'");
    expect(policy.get("base-uri")).toBe("'none'");
  });

  it("lets the page reach its own API and relay socket", () => {
    expect(policy.get("connect-src")).toBe("'self' wss://share.iagofreire.dev");
  });

  it("uses ws:// for a plain-http development server", () => {
    expect(directives(buildContentSecurityPolicy("http://localhost:5173")).get("connect-src")).toBe(
      "'self' ws://localhost:5173",
    );
  });

  it("allows Discord avatars and the picker's data-URL thumbnails", () => {
    expect(policy.get("img-src")).toBe("'self' data: https://cdn.discordapp.com");
  });
});

describe("isAllowedPermission", () => {
  it("grants fullscreen to the server's page", () => {
    expect(isAllowedPermission("fullscreen", `${ORIGIN}/desktop.html`, ORIGIN)).toBe(true);
  });

  it("grants screen capture, which the display-media handler then narrows to the picked source", () => {
    // getDisplayMedia() reaches the request handler as "media" with no device types.
    expect(isAllowedPermission("media", `${ORIGIN}/desktop.html`, ORIGIN, [])).toBe(true);
    expect(isAllowedPermission("display-capture", `${ORIGIN}/desktop.html`, ORIGIN)).toBe(true);
  });

  it("grants the microphone and the choice of speakers, for voice rooms", () => {
    expect(isAllowedPermission("media", `${ORIGIN}/desktop.html`, ORIGIN, ["audio"])).toBe(true);
    expect(isAllowedPermission("speaker-selection", `${ORIGIN}/desktop.html`, ORIGIN)).toBe(true);
  });

  it("denies the camera, microphone elsewhere, and everything else", () => {
    expect(isAllowedPermission("media", "https://evil.example/", ORIGIN, ["audio"])).toBe(false);
    expect(isAllowedPermission("media", `${ORIGIN}/desktop.html`, ORIGIN, ["video"])).toBe(false);
    expect(isAllowedPermission("media", `${ORIGIN}/desktop.html`, ORIGIN, ["audio", "video"])).toBe(false);
    expect(isAllowedPermission("media", `${ORIGIN}/desktop.html`, ORIGIN)).toBe(false);
    expect(isAllowedPermission("geolocation", `${ORIGIN}/desktop.html`, ORIGIN)).toBe(false);
    expect(isAllowedPermission("notifications", `${ORIGIN}/desktop.html`, ORIGIN)).toBe(false);
  });

  it("denies even fullscreen to any other origin", () => {
    expect(isAllowedPermission("fullscreen", "https://evil.example/", ORIGIN)).toBe(false);
  });
});
