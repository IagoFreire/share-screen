import { describe, expect, it } from "vitest";
import type { VoiceLocation } from "@screenshare-bot/shared";
import { createVoicePoller, type VoiceState } from "./voicePoller.js";

const LOCATION: VoiceLocation = {
  guildId: "g1",
  guildName: "Servidor dos Amigos",
  guildIconUrl: null,
  channelId: "c1",
  channelName: "Jogando",
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function setup(responses: Array<Response | Error>) {
  const states: VoiceState[] = [];
  let invalidCalls = 0;
  const poller = createVoicePoller({
    fetchVoice: async () => {
      const next = responses.shift();
      if (!next) throw new Error("no more responses");
      if (next instanceof Error) throw next;
      return next;
    },
    intervalMs: 15000,
    onChange: (state) => states.push(state),
    onSessionInvalid: () => {
      invalidCalls += 1;
    },
  });
  return { poller, states, invalidCalls: () => invalidCalls };
}

describe("voice poller", () => {
  it("reports the channel the user is in", async () => {
    const { poller, states } = setup([jsonResponse(200, { location: LOCATION })]);

    await poller.refresh();

    expect(states).toEqual([{ status: "in-channel", location: LOCATION }]);
  });

  it("switches to not-in-voice when the location is null", async () => {
    const { poller, states } = setup([jsonResponse(200, { location: LOCATION }), jsonResponse(200, { location: null })]);

    await poller.refresh();
    await poller.refresh();

    expect(states.at(-1)).toEqual({ status: "not-in-voice" });
  });

  it("keeps the last location on 503", async () => {
    const { poller, states } = setup([
      jsonResponse(200, { location: LOCATION }),
      jsonResponse(503, { error: "voice-lookup-failed" }),
      new Error("network down"),
    ]);

    await poller.refresh();
    await poller.refresh();
    await poller.refresh();

    expect(states).toEqual([{ status: "in-channel", location: LOCATION }]);
  });

  it("calls onSessionInvalid on 401", async () => {
    const { poller, states, invalidCalls } = setup([jsonResponse(401, { error: "invalid-session" })]);

    await poller.refresh();

    expect(invalidCalls()).toBe(1);
    expect(states).toEqual([]);
  });

  it("does not repeat an unchanged state", async () => {
    const { poller, states } = setup([jsonResponse(200, { location: LOCATION }), jsonResponse(200, { location: LOCATION })]);

    await poller.refresh();
    await poller.refresh();

    expect(states).toHaveLength(1);
  });
});
