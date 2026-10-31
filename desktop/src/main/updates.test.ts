import { describe, expect, it } from "vitest";
import type { UpdateStatus } from "@screenshare-bot/shared";
import { createUpdateTracker } from "./updates.js";

function tracked() {
  const seen: UpdateStatus[] = [];
  const tracker = createUpdateTracker((status) => seen.push(status));
  return { tracker, seen };
}

describe("createUpdateTracker", () => {
  it("walks a found update from checking to ready to install", () => {
    const { tracker, seen } = tracked();
    tracker.checking();
    tracker.available("0.6.0");
    tracker.progress(41.6);
    tracker.downloaded("0.6.0");

    expect(seen).toEqual([
      { state: "checking" },
      { state: "downloading", version: "0.6.0", percent: 0 },
      { state: "downloading", version: "0.6.0", percent: 42 },
      { state: "ready", version: "0.6.0" },
    ]);
    expect(tracker.isBusy()).toBe(false);
  });

  it("says up to date when nothing newer was found", () => {
    const { tracker } = tracked();
    tracker.checking();
    expect(tracker.isBusy()).toBe(true);
    tracker.notAvailable();
    expect(tracker.status()).toEqual({ state: "up-to-date" });
  });

  it("keeps a downloaded update ready whatever a later check says", () => {
    const { tracker } = tracked();
    tracker.downloaded("0.6.0");
    tracker.checking();
    tracker.notAvailable();
    tracker.failed();
    expect(tracker.status()).toEqual({ state: "ready", version: "0.6.0" });
  });

  it("keeps showing the download when a check runs during it", () => {
    const { tracker } = tracked();
    tracker.available("0.6.0");
    tracker.checking();
    expect(tracker.status()).toEqual({ state: "downloading", version: "0.6.0", percent: 0 });
  });

  it("explains a failed check in Portuguese", () => {
    const { tracker } = tracked();
    tracker.checking();
    tracker.failed();
    const status = tracker.status();
    expect(status.state).toBe("error");
    expect(status.state === "error" && status.message).toMatch(/internet/);
  });

  it("ignores progress outside a download and repeats nothing", () => {
    const { tracker, seen } = tracked();
    tracker.progress(50);
    tracker.available("0.6.0");
    tracker.progress(0.2);
    tracker.progress(140);
    expect(seen).toEqual([
      { state: "downloading", version: "0.6.0", percent: 0 },
      { state: "downloading", version: "0.6.0", percent: 100 },
    ]);
  });
});
