import { describe, expect, it } from "vitest";
import type { AlertSound } from "@screenshare-bot/shared";
import { createAlertPlayer, usbNotes, type AlertPlayerDeps } from "./alertSounds.js";

function setup(systemSound: Uint8Array | null | "throws" = null) {
  const played: string[] = [];
  const synthesized: Array<"usb-in" | "usb-out"> = [];
  const loads: AlertSound[] = [];
  const deps: AlertPlayerDeps = {
    knockUrl: "knock.mp3",
    loadSystemSound: async (sound) => {
      loads.push(sound);
      if (systemSound === "throws") throw new Error("no file");
      return systemSound;
    },
    playUrl: (url) => played.push(url),
    toUrl: (bytes) => `blob:${bytes.length}`,
    synthesize: (sound) => synthesized.push(sound),
  };
  return { play: createAlertPlayer(deps), played, synthesized, loads };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("alert sounds", () => {
  it("plays the knock file", async () => {
    const { play, played } = setup();
    play("knock");
    await flush();

    expect(played).toEqual(["knock.mp3"]);
  });

  it("plays Windows' own device sound when the presenter's PC has it", async () => {
    const { play, played, synthesized } = setup(new Uint8Array(3));
    play("usb-in");
    await flush();

    expect(played).toEqual(["blob:3"]);
    expect(synthesized).toEqual([]);
  });

  it("loads each device sound once", async () => {
    const { play, loads } = setup(new Uint8Array(3));
    play("usb-out");
    await flush();
    play("usb-out");
    await flush();

    expect(loads).toEqual(["usb-out"]);
  });

  it("imitates the device sound when Windows' file isn't there", async () => {
    const missing = setup(null);
    missing.play("usb-in");
    await flush();
    const failing = setup("throws");
    failing.play("usb-out");
    await flush();

    expect(missing.synthesized).toEqual(["usb-in"]);
    expect(failing.synthesized).toEqual(["usb-out"]);
  });

  it("imitates it outside the app, where there is no Windows file to read", async () => {
    const synthesized: string[] = [];
    const browserOnly = createAlertPlayer({
      knockUrl: "knock.mp3",
      playUrl: () => {},
      toUrl: () => "",
      synthesize: (sound) => synthesized.push(sound),
    });
    browserOnly("usb-out");
    await flush();

    expect(synthesized).toEqual(["usb-out"]);
  });

  it("rises for a device plugged in and falls for one pulled out", () => {
    const plugged = usbNotes("usb-in").map((note) => note.hz);
    const pulled = usbNotes("usb-out").map((note) => note.hz);

    expect(plugged[1]!).toBeGreaterThan(plugged[0]!);
    expect(pulled[1]!).toBeLessThan(pulled[0]!);
  });
});
