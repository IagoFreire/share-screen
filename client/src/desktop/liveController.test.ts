import { describe, expect, it } from "vitest";
import { buildQualityPreset, type VoiceLocation } from "@screenshare-bot/shared";
import { createLiveController, type BroadcastHandle, type LiveControllerDeps } from "./liveController.js";
import type { VoiceState } from "./voicePoller.js";

const QUALITY = buildQualityPreset("1080p", 60, "balanced");
const TARGET = { roomId: "c1", guildId: "g1" };

function location(channelId: string): VoiceLocation {
  return { guildId: "g1", guildName: "Servidor", guildIconUrl: null, channelId, channelName: "Jogando" };
}

const inChannel = (channelId: string): VoiceState => ({ status: "in-channel", location: location(channelId) });

function setup(answers: boolean[] = []) {
  const calls: string[] = [];
  const liveStates: boolean[] = [];
  let endedListener: (() => void) | null = null;
  let confirms = 0;

  const handle: BroadcastHandle = {
    stop: () => calls.push("stop"),
    onEnded: (listener) => {
      endedListener = listener;
    },
  };
  const deps: LiveControllerDeps = {
    startBroadcast: async (sourceId, quality, target) => {
      calls.push(`start ${sourceId} ${quality.height}p ${target.roomId}`);
      return handle;
    },
    setLive: (live) => liveStates.push(live),
    confirmLeave: async () => {
      confirms += 1;
      return answers.shift() ?? false;
    },
  };

  return {
    controller: createLiveController(deps),
    calls,
    liveStates,
    confirms: () => confirms,
    endFromOutside: () => endedListener?.(),
  };
}

describe("live controller", () => {
  it("goLive starts the broadcast in the target channel and marks the app live", async () => {
    const { controller, calls, liveStates } = setup();

    await controller.goLive("screen:0:0", QUALITY, TARGET);

    expect(calls).toEqual(["start screen:0:0 1080p c1"]);
    expect(controller.isLive).toBe(true);
    expect(liveStates).toEqual([true]);
  });

  it("end stops the broadcast and clears live", async () => {
    const { controller, calls, liveStates } = setup();
    await controller.goLive("screen:0:0", QUALITY, TARGET);

    controller.end();

    expect(calls.at(-1)).toBe("stop");
    expect(controller.isLive).toBe(false);
    expect(liveStates).toEqual([true, false]);
  });

  it("end is idempotent", async () => {
    const { controller, calls, liveStates } = setup();
    await controller.goLive("screen:0:0", QUALITY, TARGET);

    controller.end();
    controller.end();

    expect(calls.filter((call) => call === "stop")).toHaveLength(1);
    expect(liveStates).toEqual([true, false]);
  });

  it("a broadcast that ends on its own resets the live state", async () => {
    const { controller, liveStates, endFromOutside } = setup();
    await controller.goLive("screen:0:0", QUALITY, TARGET);

    endFromOutside();

    expect(controller.isLive).toBe(false);
    expect(liveStates).toEqual([true, false]);
  });

  it('leaving the voice channel while live asks once and keeps streaming on "no"', async () => {
    const { controller, calls, confirms } = setup([false]);
    await controller.goLive("screen:0:0", QUALITY, TARGET);

    await controller.onVoiceState({ status: "not-in-voice" });
    await controller.onVoiceState({ status: "not-in-voice" });

    expect(confirms()).toBe(1);
    expect(controller.isLive).toBe(true);
    expect(calls).not.toContain("stop");
  });

  it('"yes" ends the live', async () => {
    const { controller, calls } = setup([true]);
    await controller.goLive("screen:0:0", QUALITY, TARGET);

    await controller.onVoiceState(inChannel("another-channel"));

    expect(controller.isLive).toBe(false);
    expect(calls.at(-1)).toBe("stop");
  });

  it("asks again after coming back and leaving a second time", async () => {
    const { controller, confirms } = setup([false, false]);
    await controller.goLive("screen:0:0", QUALITY, TARGET);

    await controller.onVoiceState({ status: "not-in-voice" });
    await controller.onVoiceState(inChannel("c1"));
    await controller.onVoiceState({ status: "not-in-voice" });

    expect(confirms()).toBe(2);
  });

  it("voice changes while not live never ask", async () => {
    const { controller, confirms } = setup();

    await controller.onVoiceState({ status: "not-in-voice" });
    await controller.onVoiceState(inChannel("c2"));

    expect(confirms()).toBe(0);
  });
});
