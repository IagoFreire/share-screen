import { describe, expect, it } from "vitest";
import { pickServerOrigin, serverOriginCandidates } from "./serverOrigin.js";

describe("serverOriginCandidates", () => {
  it("tries the home server's port first, then the plain address (the tunnel)", () => {
    expect(serverOriginCandidates({})).toEqual(["https://share.iagofreire.dev:8443", "https://share.iagofreire.dev"]);
  });

  it("uses only SCREENSHARE_SERVER when set", () => {
    expect(serverOriginCandidates({ SCREENSHARE_SERVER: "http://localhost:5173" })).toEqual(["http://localhost:5173"]);
  });

  it("drops a trailing slash", () => {
    expect(serverOriginCandidates({ SCREENSHARE_SERVER: "http://localhost:5173/" })).toEqual(["http://localhost:5173"]);
  });
});

describe("pickServerOrigin", () => {
  const candidates = ["https://a:8443", "https://a"];

  it("takes the first candidate that answers", async () => {
    expect(await pickServerOrigin(candidates, async (origin) => origin === "https://a")).toBe("https://a");
    expect(await pickServerOrigin(candidates, async () => true)).toBe("https://a:8443");
  });

  it("doesn't wait on a later candidate once an earlier one answered", async () => {
    const never = new Promise<boolean>(() => {});
    const picked = await pickServerOrigin(candidates, (origin) => (origin === "https://a:8443" ? Promise.resolve(true) : never));

    expect(picked).toBe("https://a:8443");
  });

  it("falls back to the first candidate when none answers (the server is down)", async () => {
    expect(await pickServerOrigin(candidates, async () => false)).toBe("https://a:8443");
  });

  it("counts a probe that throws as down", async () => {
    const probe = async (origin: string) => {
      if (origin === "https://a:8443") throw new Error("ECONNREFUSED");
      return true;
    };

    expect(await pickServerOrigin(candidates, probe)).toBe("https://a");
  });
});
