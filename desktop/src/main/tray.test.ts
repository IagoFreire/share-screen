import { describe, expect, it } from "vitest";
import { decideCloseAction, isNotification, withLiveBadge } from "./tray.js";

/** BGRA pixel at (x, y) of a square bitmap. */
function pixel(bitmap: Buffer, size: number, x: number, y: number): [number, number, number, number] {
  const offset = (y * size + x) * 4;
  return [bitmap[offset], bitmap[offset + 1], bitmap[offset + 2], bitmap[offset + 3]];
}

/** An opaque mid-grey square, standing in for the app icon. */
function opaqueGrey(size: number): Buffer {
  const bitmap = Buffer.alloc(size * size * 4);
  for (let offset = 0; offset < bitmap.length; offset += 4) bitmap.set([0x80, 0x80, 0x80, 255], offset);
  return bitmap;
}

describe("withLiveBadge", () => {
  it("leaves the icon as it is when not live", () => {
    const icon = opaqueGrey(32);
    expect(withLiveBadge(icon, 32, false).equals(icon)).toBe(true);
  });

  it("paints a red badge in the corner when live", () => {
    const [blue, green, red, alpha] = pixel(withLiveBadge(opaqueGrey(32), 32, true), 32, 26, 26);
    expect([red, green, blue, alpha]).toEqual([0xf2, 0x3f, 0x43, 255]);
  });

  it("cuts a transparent ring around the badge so it reads against the icon", () => {
    // 6.5 units from the badge centre (25, 25): past the badge, inside its gap.
    expect(pixel(withLiveBadge(opaqueGrey(32), 32, true), 32, 31, 25)[3]).toBe(0);
  });

  it("keeps the rest of the icon untouched", () => {
    expect(pixel(withLiveBadge(opaqueGrey(32), 32, true), 32, 4, 4)).toEqual([0x80, 0x80, 0x80, 255]);
  });

  it("never changes the bitmap it was given", () => {
    const icon = opaqueGrey(32);
    withLiveBadge(icon, 32, true);
    expect(pixel(icon, 32, 26, 26)).toEqual([0x80, 0x80, 0x80, 255]);
  });
});

describe("decideCloseAction", () => {
  it("hides to the tray while live", () => {
    expect(decideCloseAction({ live: true, quitting: false })).toBe("hide-to-tray");
  });

  it("closes when not live", () => {
    expect(decideCloseAction({ live: false, quitting: false })).toBe("close");
  });

  it("closes when quitting, even while live", () => {
    expect(decideCloseAction({ live: true, quitting: true })).toBe("close");
    expect(decideCloseAction({ live: false, quitting: true })).toBe("close");
  });
});

describe("isNotification", () => {
  it("accepts short title and body strings", () => {
    expect(isNotification("Alguém bateu na porta", "Abra a Janja para ver.")).toBe(true);
  });

  it("rejects non-strings and oversized text", () => {
    expect(isNotification(42, "x")).toBe(false);
    expect(isNotification("x", "y".repeat(500))).toBe(false);
  });
});
