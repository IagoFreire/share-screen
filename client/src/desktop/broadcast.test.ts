import { describe, expect, it } from "vitest";
import { buildQualityPreset, type ControlMessage } from "@screenshare-bot/shared";
import type { WsClientHandlers } from "../net/wsClient.js";
import type { PresenterSession } from "../session/presenterSession.js";
import { audioEncodingFor, startDesktopBroadcast, type BroadcastFactories, type BroadcastOptions } from "./broadcast.js";

describe("audioEncodingFor", () => {
  it("encodes the sound at the quality picked in the transmit dialog", () => {
    expect(audioEncodingFor({ mode: "apps", exclude: [], quality: "light" })).toEqual({ bitrateKbps: 64, complexity: 5 });
    expect(audioEncodingFor({ mode: "system", quality: "normal" })).toEqual({ bitrateKbps: 96, complexity: 10 });
  });

  it("keeps the old quality when none was picked", () => {
    expect(audioEncodingFor({ mode: "system" })).toEqual({ bitrateKbps: 160, complexity: 10 });
  });
});

const QUALITY = buildQualityPreset("720p", 30, "balanced");
const TARGET = { roomId: "c1", guildId: "g1" };

function setup() {
  let handlers: WsClientHandlers | null = null;
  const sentControls: ControlMessage[] = [];
  let wsClosed = 0;
  let sessionStops = 0;
  const interruptions: string[] = [];
  const audiences: number[] = [];

  const session: PresenterSession = {
    isPresenting: true,
    start: async () => ({ hasAudio: true }),
    stop: () => {
      sessionStops += 1;
    },
    handleControl: () => false,
    onEnded: () => {},
  };

  const factories: BroadcastFactories = {
    createWs: (_url, wsHandlers) => {
      handlers = wsHandlers;
      return {
        connect: () => wsHandlers.onOpen?.(),
        close: () => {
          wsClosed += 1;
        },
        sendControl: (message) => sentControls.push(message),
        sendFrame: () => {},
      };
    },
    createSession: () => session,
  };

  const options: BroadcastOptions = {
    wsUrl: "ws://relay/ws",
    userId: "42",
    session: "signed",
    audio: { mode: "system" },
    appAudio: null,
    selectSource: async () => {},
    onAudience: (watchers) => audiences.push(watchers),
    onAlert: () => {},
    onInterrupted: (message) => interruptions.push(message),
  };

  async function goLive() {
    const pending = startDesktopBroadcast("screen:0:0", QUALITY, TARGET, options, factories);
    await Promise.resolve();
    await Promise.resolve();
    handlers!.onControl({ kind: "joined", roomId: "c1", streams: [], viewerCount: 1, isAdmin: false });
    const handle = await pending;
    let endedCalls = 0;
    handle.onEnded(() => {
      endedCalls += 1;
    });
    return { handle, endedCalls: () => endedCalls };
  }

  return {
    goLive,
    handlers: () => handlers!,
    sentControls,
    wsClosed: () => wsClosed,
    sessionStops: () => sessionStops,
    interruptions,
    audiences,
  };
}

describe("desktop broadcast", () => {
  it("joins as a presenter-only connection with the session", async () => {
    const { goLive, sentControls } = setup();
    await goLive();

    expect(sentControls[0]).toMatchObject({ kind: "join", roomId: "c1", session: "signed", presenterOnly: true });
  });

  it("a dropped connection while live ends the broadcast and says why", async () => {
    const { goLive, handlers, wsClosed, sessionStops, interruptions } = setup();
    const { endedCalls } = await goLive();

    handlers().onClose?.();

    expect(endedCalls()).toBe(1);
    expect(sessionStops()).toBe(1);
    expect(wsClosed()).toBeGreaterThan(0);
    expect(interruptions).toEqual(["A conexão com o servidor caiu e a transmissão foi encerrada."]);
  });

  it("an error from the relay after going live ends the broadcast", async () => {
    const { goLive, handlers, interruptions } = setup();
    const { endedCalls } = await goLive();

    handlers().onControl({ kind: "error", message: "Room already has the maximum number of broadcasts." });

    expect(endedCalls()).toBe(1);
    expect(interruptions).toHaveLength(1);
  });

  it("reports how many people watch the broadcast", async () => {
    const { goLive, handlers, audiences } = setup();
    await goLive();

    handlers().onControl({ kind: "audience-changed", watchers: 3, videoWatchers: 2 });
    handlers().onControl({ kind: "audience-changed", watchers: 0, videoWatchers: 0 });

    expect(audiences).toEqual([3, 0]);
  });

  it("stopping on purpose is not reported as an interruption", async () => {
    const { goLive, handlers, interruptions } = setup();
    const { handle, endedCalls } = await goLive();

    handle.stop();
    handlers().onClose?.();

    expect(endedCalls()).toBe(0);
    expect(interruptions).toEqual([]);
  });
});
