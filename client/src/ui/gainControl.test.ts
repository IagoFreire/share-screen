import { describe, expect, it } from "vitest";
import { gainButtonLabel, gainFromPercent, percentFromGain } from "./gainControl.js";

describe("gain control", () => {
  it("shows the gain as a percentage of the broadcast as sent", () => {
    expect(percentFromGain(1)).toBe(100);
    expect(percentFromGain(3.5)).toBe(350);
    expect(percentFromGain(undefined)).toBe(100);
  });

  it("turns the slider's percentage back into a gain, within 0-1000%", () => {
    expect(gainFromPercent(250)).toBe(2.5);
    expect(gainFromPercent(5000)).toBe(10);
    expect(gainFromPercent(-20)).toBe(0);
    expect(gainFromPercent(Number.NaN)).toBe(1);
  });

  it("labels the button with the gain everyone hears", () => {
    expect(gainButtonLabel(1)).toBe("Ganho 100%");
    expect(gainButtonLabel(10)).toBe("Ganho 1000%");
  });
});
