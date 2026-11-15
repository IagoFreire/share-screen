import { describe, expect, it } from "vitest";
import { systemSoundPath } from "./systemSounds";

describe("systemSoundPath", () => {
  it("finds Windows' device sounds under the system root", () => {
    expect(systemSoundPath("usb-in", "C:\\Windows")).toBe("C:\\Windows\\Media\\Windows Hardware Insert.wav");
    expect(systemSoundPath("usb-out", "D:\\WIN")).toBe("D:\\WIN\\Media\\Windows Hardware Remove.wav");
  });

  it("names no file for anything else, or without a system root", () => {
    expect(systemSoundPath("knock", "C:\\Windows")).toBeNull();
    expect(systemSoundPath("..\\secret", "C:\\Windows")).toBeNull();
    expect(systemSoundPath("usb-in", undefined)).toBeNull();
  });
});
