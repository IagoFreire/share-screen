import { describe, expect, it } from "vitest";
import { isAllowedNavigation } from "./navigation.js";
import { resolveServerOrigin } from "./serverOrigin.js";

describe("resolveServerOrigin", () => {
  it("defaults to the production server", () => {
    expect(resolveServerOrigin({})).toBe("https://share.iagofreire.dev");
  });

  it("uses SCREENSHARE_SERVER when set", () => {
    expect(resolveServerOrigin({ SCREENSHARE_SERVER: "http://localhost:5173" })).toBe("http://localhost:5173");
  });

  it("drops a trailing slash", () => {
    expect(resolveServerOrigin({ SCREENSHARE_SERVER: "http://localhost:5173/" })).toBe("http://localhost:5173");
  });
});

describe("isAllowedNavigation", () => {
  const origin = "https://share.iagofreire.dev";

  it("allows pages on the server's origin", () => {
    expect(isAllowedNavigation("https://share.iagofreire.dev/desktop.html?x=1", origin)).toBe(true);
  });

  it("rejects another host", () => {
    expect(isAllowedNavigation("https://evil.example/desktop.html", origin)).toBe(false);
  });

  it("rejects the same host over plain http", () => {
    expect(isAllowedNavigation("http://share.iagofreire.dev/desktop.html", origin)).toBe(false);
  });

  it("rejects a lookalike subdomain", () => {
    expect(isAllowedNavigation("https://share.iagofreire.dev.evil.example/", origin)).toBe(false);
  });

  it("rejects invalid URLs", () => {
    expect(isAllowedNavigation("not a url", origin)).toBe(false);
    expect(isAllowedNavigation("", origin)).toBe(false);
  });
});
