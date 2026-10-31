import { describe, expect, it } from "vitest";
import { createAutoLayer } from "./autoLayer.js";

describe("auto layer", () => {
  it("starts on the best layer", () => {
    expect(createAutoLayer(3, 0).layer).toBe(0);
  });

  it("steps down when frames keep getting dropped", () => {
    const auto = createAutoLayer(3, 0);
    let changed: number | null = null;
    for (let i = 0; i < 5; i++) changed = auto.report("dropped", 1000 + i * 100) ?? changed;

    expect(changed).toBe(1);
    expect(auto.layer).toBe(1);
  });

  it("ignores an occasional drop", () => {
    const auto = createAutoLayer(3, 0);
    auto.report("dropped", 1000);
    auto.report("dropped", 4000);
    auto.report("sent", 4100);

    expect(auto.layer).toBe(0);
  });

  it("never goes below the lightest layer", () => {
    const auto = createAutoLayer(2, 0);
    for (let i = 0; i < 20; i++) auto.report("stalled", 1000 + i * 100);

    expect(auto.layer).toBe(1);
  });

  it("steps back up after a quiet stretch", () => {
    const auto = createAutoLayer(3, 0);
    for (let i = 0; i < 5; i++) auto.report("dropped", 1000 + i * 100);

    expect(auto.report("sent", 10_000)).toBeNull();
    expect(auto.report("sent", 17_000)).toBe(0);
  });

  it("a new drop restarts the quiet stretch", () => {
    const auto = createAutoLayer(3, 0);
    for (let i = 0; i < 5; i++) auto.report("dropped", 1000 + i * 100);
    auto.report("dropped", 12_000);

    expect(auto.report("sent", 17_000)).toBeNull();
    expect(auto.layer).toBe(1);
  });

  it("steps down at once when the viewer reports congestion", () => {
    const auto = createAutoLayer(3, 0);

    expect(auto.congested(1000)).toBe(1);
    expect(auto.layer).toBe(1);
  });

  it("gives a step down time to drain before taking another", () => {
    const auto = createAutoLayer(3, 0);
    auto.congested(1000);

    // The old layer's backlog is still arriving: the report says nothing new yet.
    expect(auto.congested(2000)).toBeNull();
    expect(auto.congested(5000)).toBe(2);
  });

  it("a congestion report restarts the quiet stretch before stepping up", () => {
    const auto = createAutoLayer(3, 0);
    auto.congested(1000);
    auto.congested(10_000); // down to the lightest, and the clean stretch starts over

    expect(auto.report("sent", 17_000)).toBeNull();
    expect(auto.report("sent", 25_500)).toBe(1);
  });
});
