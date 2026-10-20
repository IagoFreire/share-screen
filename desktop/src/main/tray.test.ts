import { describe, expect, it } from "vitest";
import { decideCloseAction, drawTrayIcon, isNotification } from "./tray.js";

/** BGRA pixel at (x, y) of a square bitmap. */
function pixel(bitmap: Buffer, size: number, x: number, y: number): [number, number, number, number] {
  const offset = (y * size + x) * 4;
  return [bitmap[offset], bitmap[offset + 1], bitmap[offset + 2], bitmap[offset + 3]];
}

describe("drawTrayIcon", () => {
  it("is a BGRA bitmap of the requested size with transparent corners", () => {
    const bitmap = drawTrayIcon(32, false);
    expect(bitmap.length).toBe(32 * 32 * 4);
    expect(pixel(bitmap, 32, 0, 0)[3]).toBe(0);
  });

  it("paints the blurple tile behind the screen glyph", () => {
    const [blue, green, red, alpha] = pixel(drawTrayIcon(32, false), 32, 4, 16);
    expect([red, green, blue, alpha]).toEqual([0x58, 0x65, 0xf2, 255]);
  });

  it("adds a red live badge in the corner when live", () => {
    const [blue, green, red] = pixel(drawTrayIcon(32, true), 32, 26, 26);
    expect([red, green, blue]).toEqual([0xf2, 0x3f, 0x43]);
    const [idleBlue, , idleRed] = pixel(drawTrayIcon(32, false), 32, 26, 26);
    expect([idleRed, idleBlue]).not.toEqual([0xf2, 0x43]);
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
    expect(isNotification("Alguém bateu na porta", "Abra o ScreenShare para ver.")).toBe(true);
  });

  it("rejects non-strings and oversized text", () => {
    expect(isNotification(42, "x")).toBe(false);
    expect(isNotification("x", "y".repeat(500))).toBe(false);
  });
});
