import { describe, expect, it } from "vitest";
import { appAudioButtonLabel, appAudioRows } from "./appAudioControl.js";

describe("app audio control", () => {
  it("lists each app the presenter's helper reports, with whether an admin took it out", () => {
    const rows = appAudioRows({
      apps: [
        { exe: "Spotify.exe", state: "disabled" },
        { exe: "League of Legends.exe", state: "ok" },
        { exe: "chrome.exe", state: "quiet" },
      ],
    });

    expect(rows).toEqual([
      { exe: "chrome.exe", name: "chrome", disabled: false },
      { exe: "League of Legends.exe", name: "League of Legends", disabled: false },
      { exe: "Spotify.exe", name: "Spotify", disabled: true },
    ]);
  });

  it("has nothing to list before the presenter reports", () => {
    expect(appAudioRows(null)).toEqual([]);
  });

  it("labels the button with how many apps are out", () => {
    expect(appAudioButtonLabel([{ exe: "a.exe", name: "a", disabled: false }])).toBe("Apps");
    expect(
      appAudioButtonLabel([
        { exe: "a.exe", name: "a", disabled: true },
        { exe: "b.exe", name: "b", disabled: true },
      ]),
    ).toBe("Apps · 2 off");
  });
});
