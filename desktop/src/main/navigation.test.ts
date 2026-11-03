import { describe, expect, it } from "vitest";
import { isAllowedNavigation } from "./navigation.js";

describe("isAllowedNavigation", () => {
  const origin = "https://share.iagofreire.dev";

  it("allows pages on the server's origin", () => {
    expect(isAllowedNavigation("https://share.iagofreire.dev/desktop.html?x=1", origin)).toBe(true);
  });

  it("tells the same host on another port apart", () => {
    const home = "https://share.iagofreire.dev:8443";
    expect(isAllowedNavigation("https://share.iagofreire.dev:8443/desktop.html", home)).toBe(true);
    expect(isAllowedNavigation("https://share.iagofreire.dev/desktop.html", home)).toBe(false);
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
