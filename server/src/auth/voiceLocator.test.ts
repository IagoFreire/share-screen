import { describe, expect, it } from "vitest";
import { createVoiceLocator, VoiceLookupError, type VoiceLocatorDeps } from "./voiceLocator.js";

const GUILDS = [
  { id: "100", name: "Servidor A", icon: null },
  { id: "200", name: "Servidor dos Amigos", icon: "abc" },
];

type Route = (path: string) => { status: number; body: unknown };

function setup(route: Route, startMs = 0) {
  let nowMs = startMs;
  const calls: string[] = [];
  const deps: VoiceLocatorDeps = {
    fetchJson: async (path) => {
      calls.push(path);
      return route(path);
    },
    now: () => nowMs,
    resolveChannelName: async (id) => `canal-${id}`,
  };
  return {
    locator: createVoiceLocator(deps),
    calls,
    advance: (ms: number) => {
      nowMs += ms;
    },
  };
}

function inGuild200(path: string) {
  if (path === "/users/@me/guilds") return { status: 200, body: GUILDS };
  if (path === "/guilds/200/voice-states/42") return { status: 200, body: { channel_id: "999" } };
  return { status: 404, body: {} };
}

describe("voice locator", () => {
  it("finds the guild where the user is in voice", async () => {
    const { locator } = setup(inGuild200);

    expect(await locator.locate("42")).toEqual({
      guildId: "200",
      guildName: "Servidor dos Amigos",
      guildIconUrl: "https://cdn.discordapp.com/icons/200/abc.png?size=64",
      channelId: "999",
      channelName: "canal-999",
    });
  });

  it("returns null when every guild answers 404", async () => {
    const { locator } = setup((path) =>
      path === "/users/@me/guilds" ? { status: 200, body: GUILDS } : { status: 404, body: {} },
    );
    expect(await locator.locate("42")).toBeNull();
  });

  it("throws VoiceLookupError on 429 or 403", async () => {
    for (const status of [429, 403]) {
      const { locator } = setup((path) =>
        path === "/users/@me/guilds" ? { status: 200, body: GUILDS } : { status, body: {} },
      );
      await expect(locator.locate("42")).rejects.toBeInstanceOf(VoiceLookupError);
    }
  });

  it("caches bot guilds for 5 minutes", async () => {
    const { locator, calls, advance } = setup(inGuild200);
    const guildFetches = () => calls.filter((path) => path === "/users/@me/guilds").length;

    await locator.locate("42");
    advance(4 * 60 * 1000);
    await locator.locate("42");
    expect(guildFetches()).toBe(1);

    advance(2 * 60 * 1000);
    await locator.locate("42");
    expect(guildFetches()).toBe(2);
  });

  it("caches a user's result for 5 seconds", async () => {
    const { locator, calls, advance } = setup(inGuild200);
    const voiceFetches = () => calls.filter((path) => path.includes("/voice-states/")).length;

    await locator.locate("42");
    const afterFirst = voiceFetches();
    advance(4000);
    await locator.locate("42");
    expect(voiceFetches()).toBe(afterFirst);

    advance(2000);
    await locator.locate("42");
    expect(voiceFetches()).toBeGreaterThan(afterFirst);
  });
});
