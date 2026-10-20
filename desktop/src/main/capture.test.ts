import { describe, expect, it } from "vitest";
import { createSourceSelection, isSourceId, pickDisplayMedia, toDesktopSource, type CapturerSourceLike } from "./capture.js";

function image(dataUrl: string) {
  return { toDataURL: () => dataUrl, isEmpty: () => dataUrl === "" };
}

const SCREEN: CapturerSourceLike = { id: "screen:0:0", name: "Tela 1", thumbnail: image("data:thumb-screen"), appIcon: null };
const WINDOW: CapturerSourceLike = {
  id: "window:1234:0",
  name: "Valorant",
  thumbnail: image("data:thumb-window"),
  appIcon: image("data:icon"),
};

describe("toDesktopSource", () => {
  it("maps screen and window sources", () => {
    expect(toDesktopSource(SCREEN)).toEqual({
      id: "screen:0:0",
      name: "Tela 1",
      kind: "screen",
      thumbnailDataUrl: "data:thumb-screen",
      iconDataUrl: null,
    });
    expect(toDesktopSource(WINDOW)).toEqual({
      id: "window:1234:0",
      name: "Valorant",
      kind: "window",
      thumbnailDataUrl: "data:thumb-window",
      iconDataUrl: "data:icon",
    });
  });

  it("treats an empty app icon as no icon", () => {
    expect(toDesktopSource({ ...WINDOW, appIcon: image("") }).iconDataUrl).toBeNull();
  });
});

describe("source selection", () => {
  it("a selection is used once", () => {
    const selection = createSourceSelection();
    selection.set({ id: "screen:0:0", audio: true });

    expect(selection.take()).toEqual({ id: "screen:0:0", audio: true });
    expect(selection.take()).toBeNull();
  });

  it("only accepts capturer ids", () => {
    expect(isSourceId("screen:0:0")).toBe(true);
    expect(isSourceId("window:1234:0")).toBe(true);
    expect(isSourceId("file:///etc/passwd")).toBe(false);
    expect(isSourceId(42)).toBe(false);
  });
});

describe("pickDisplayMedia", () => {
  it("no selection denies the request", () => {
    expect(pickDisplayMedia(null, [SCREEN, WINDOW])).toBeNull();
  });

  it("a selection that no longer exists denies the request", () => {
    expect(pickDisplayMedia({ id: "window:9999:0", audio: true }, [SCREEN, WINDOW])).toBeNull();
  });

  it("grants the selected source with system audio", () => {
    expect(pickDisplayMedia({ id: "window:1234:0", audio: true }, [SCREEN, WINDOW])).toEqual({
      video: WINDOW,
      audio: "loopback",
    });
  });

  it("grants video only when the user chose to broadcast without sound", () => {
    expect(pickDisplayMedia({ id: "window:1234:0", audio: false }, [SCREEN, WINDOW])).toEqual({ video: WINDOW });
  });
});
