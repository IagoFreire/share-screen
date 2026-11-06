import { describe, expect, it } from "vitest";
import { createJoinChime, JOIN_CHIME_MIN_INTERVAL_MS } from "./joinChime.js";

function setup() {
  let now = 0;
  let plays = 0;
  const chime = createJoinChime({ now: () => now, play: () => (plays += 1) });
  return {
    chime,
    plays: () => plays,
    advance: (ms: number) => (now += ms),
    report: (watchers: number) => chime.onAudience({ watchers, videoWatchers: watchers }),
  };
}

describe("join chime", () => {
  it("chimes when someone starts watching", () => {
    const { report, plays } = setup();

    report(0);
    report(1);

    expect(plays()).toBe(1);
  });

  it("stays quiet when someone leaves or nothing changes", () => {
    const { report, plays, advance } = setup();
    report(2);
    advance(JOIN_CHIME_MIN_INTERVAL_MS);

    report(1);
    report(1);

    expect(plays()).toBe(1); // only the first report, which went from nobody to two
  });

  it("chimes once for a burst of people joining", () => {
    const { report, plays, advance } = setup();

    report(1);
    advance(200);
    report(2);
    advance(200);
    report(3);

    expect(plays()).toBe(1);
  });

  it("chimes again for someone joining after the burst", () => {
    const { report, plays, advance } = setup();

    report(1);
    advance(JOIN_CHIME_MIN_INTERVAL_MS);
    report(2);

    expect(plays()).toBe(2);
  });

  it("someone leaving and coming back chimes again", () => {
    const { report, plays, advance } = setup();

    report(1);
    report(0);
    advance(JOIN_CHIME_MIN_INTERVAL_MS);
    report(1);

    expect(plays()).toBe(2);
  });

  it("a new live counts from nobody", () => {
    const { chime, report, plays, advance } = setup();
    report(2);
    advance(JOIN_CHIME_MIN_INTERVAL_MS);

    chime.reset();
    report(2);

    expect(plays()).toBe(2);
  });
});
