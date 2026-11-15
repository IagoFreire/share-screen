import { describe, expect, it } from "vitest";
import { ALERT_SOUNDS } from "@screenshare-bot/shared";
import { ALERT_MENU_ITEMS } from "./alertMenu.js";

describe("alert menu", () => {
  it("offers every sound an alert can play, the knock first", () => {
    expect(ALERT_MENU_ITEMS.map((item) => item.sound)).toEqual(["knock", "usb-in", "usb-out"]);
    expect(new Set(ALERT_MENU_ITEMS.map((item) => item.sound))).toEqual(new Set(ALERT_SOUNDS));
  });

  it("names each one in Portuguese", () => {
    expect(ALERT_MENU_ITEMS.map((item) => item.label)).toEqual(["Bater na porta", "USB conectado", "USB desconectado"]);
  });
});
