import { describe, expect, it } from "vitest";
import { countAudience, type ViewerSelection } from "./audience.js";

function viewer(overrides: Partial<ViewerSelection> = {}): ViewerSelection {
  return { userId: "7", selectedSlot: 0, isPaused: false, videoDisabled: false, ownPreview: false, ...overrides };
}

describe("countAudience", () => {
  it("counts the viewers receiving that broadcast", () => {
    const viewers = [viewer({ userId: "1" }), viewer({ userId: "2" }), viewer({ userId: "3", selectedSlot: 1 })];

    expect(countAudience(viewers, 0, "42")).toEqual({ watchers: 2, videoWatchers: 2 });
    expect(countAudience(viewers, 1, "43")).toEqual({ watchers: 1, videoWatchers: 1 });
  });

  it("leaves out viewers who chose to watch nothing", () => {
    expect(countAudience([viewer({ selectedSlot: null })], 0, "42")).toEqual({ watchers: 0, videoWatchers: 0 });
  });

  it("leaves out connections paused because the same user watches elsewhere", () => {
    expect(countAudience([viewer({ isPaused: true })], 0, "42")).toEqual({ watchers: 0, videoWatchers: 0 });
  });

  it("does not let the presenter's own preview keep the broadcast running", () => {
    expect(countAudience([viewer({ userId: "42" })], 0, "42")).toEqual({ watchers: 0, videoWatchers: 0 });
  });

  it("sends the picture to a presenter who opened their own live on purpose", () => {
    // Not an audience (nobody else hears it), but the preview needs the video.
    expect(countAudience([viewer({ userId: "42", ownPreview: true })], 0, "42")).toEqual({
      watchers: 0,
      videoWatchers: 1,
    });
  });

  it("still counts anonymous viewers when the presenter is anonymous too", () => {
    expect(countAudience([viewer({ userId: null })], 0, null)).toEqual({ watchers: 1, videoWatchers: 1 });
  });

  it("counts audio-only listeners as watchers that want no video", () => {
    const viewers = [viewer({ userId: "1", videoDisabled: true }), viewer({ userId: "2" })];

    expect(countAudience(viewers, 0, "42")).toEqual({ watchers: 2, videoWatchers: 1 });
  });
});
