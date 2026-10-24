import path from "node:path";
import { describe, expect, it } from "vitest";
import { APP_NAME, userDataPath } from "./appIdentity.js";

describe("app identity", () => {
  it("is called Janja", () => {
    expect(APP_NAME).toBe("Janja");
  });

  it("keeps logins and settings in the folder from before the rename", () => {
    expect(userDataPath("C:\\Users\\x\\AppData\\Roaming")).toBe(path.join("C:\\Users\\x\\AppData\\Roaming", "ScreenShare"));
  });
});
