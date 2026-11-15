import { describe, expect, it } from "vitest";
import {
  buildQualityPreset,
  POTATO_PRESET,
  type ControlMessage,
  type DesktopAppAudio,
  type QualityPreset,
} from "@screenshare-bot/shared";
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

function setup(quality: QualityPreset = QUALITY, overrides: Partial<BroadcastOptions> = {}) {
  let handlers: WsClientHandlers | null = null;
  const sentControls: ControlMessage[] = [];
  const startedLayers: Array<QualityPreset[] | undefined> = [];
  let wsClosed = 0;
  let sessionStops = 0;
  const interruptions: string[] = [];
  const audiences: Array<{ watchers: number; videoWatchers: number }> = [];

  const session: PresenterSession = {
    isPresenting: true,
    start: async (_quality, layers) => {
      startedLayers.push(layers);
      return { hasAudio: true };
    },
    stop: () => {
      sessionStops += 1;
    },
    reannounce: () => {},
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
    onAudience: (audience) => audiences.push(audience),
    onAlert: () => {},
    onInterrupted: (message) => interruptions.push(message),
    ...overrides,
  };

  async function goLive() {
    const pending = startDesktopBroadcast("screen:0:0", quality, TARGET, options, factories);
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
    startedLayers,
    wsClosed: () => wsClosed,
    sessionStops: () => sessionStops,
    interruptions,
    audiences,
  };
}

/** A per-app audio bridge that records what the helper was told to leave out. */
function fakeAppAudio(): { appAudio: DesktopAppAudio; disabledCalls: string[][] } {
  const disabledCalls: string[][] = [];
  const appAudio: DesktopAppAudio = {
    listApps: async () => [],
    start: async () => {},
    stop: () => {},
    onBlock: () => () => {},
    onEnded: () => {},
    onStatus: () => () => {},
    setDisabled: (exes) => disabledCalls.push([...exes]),
  };
  return { appAudio, disabledCalls };
}

describe("desktop broadcast: apps an admin takes out", () => {
  const APPS_AUDIO = { mode: "apps", exclude: ["Discord.exe"] } as const;

  it("hands the helper the whole list each time an admin changes it", async () => {
    const { appAudio, disabledCalls } = fakeAppAudio();
    const { goLive, handlers } = setup(QUALITY, { audio: { ...APPS_AUDIO, exclude: [...APPS_AUDIO.exclude] }, appAudio });
    await goLive();

    handlers().onControl({ kind: "set-app-audio-disabled", exe: "Spotify.exe", disabled: true });
    handlers().onControl({ kind: "set-app-audio-disabled", exe: "chrome.exe", disabled: true });
    handlers().onControl({ kind: "set-app-audio-disabled", exe: "spotify.exe", disabled: false });

    expect(disabledCalls).toEqual([["Spotify.exe"], ["Spotify.exe", "chrome.exe"], ["chrome.exe"]]);
  });

  it("ignores it when the live doesn't use per-app audio", async () => {
    const { appAudio, disabledCalls } = fakeAppAudio();
    const { goLive, handlers } = setup(QUALITY, { audio: { mode: "system" }, appAudio });
    await goLive();

    handlers().onControl({ kind: "set-app-audio-disabled", exe: "Spotify.exe", disabled: true });

    expect(disabledCalls).toEqual([]);
  });

  it("ignores a name that isn't an app", async () => {
    const { appAudio, disabledCalls } = fakeAppAudio();
    const { goLive, handlers } = setup(QUALITY, { audio: { ...APPS_AUDIO, exclude: [] }, appAudio });
    await goLive();

    handlers().onControl({ kind: "set-app-audio-disabled", exe: "a.exe,b.exe", disabled: true });

    expect(disabledCalls).toEqual([]);
  });
});

describe("desktop broadcast", () => {
  it("joins as a presenter-only connection with the session", async () => {
    const { goLive, sentControls } = setup();
    await goLive();

    expect(sentControls[0]).toMatchObject({ kind: "join", roomId: "c1", session: "signed", presenterOnly: true });
  });

  it("sends simulcast layers under a normal quality", async () => {
    const { goLive, startedLayers } = setup(buildQualityPreset("1080p", 60, "balanced"));
    await goLive();

    expect(startedLayers[0]?.map((layer) => layer.height)).toEqual([1080, 720, 480]);
  });

  it("Potato goes live as a single 720p version", async () => {
    const { goLive, startedLayers } = setup(POTATO_PRESET);
    await goLive();

    expect(startedLayers[0]).toEqual([POTATO_PRESET]);
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

    handlers().onControl({ kind: "audience-changed", watchers: 3, videoWatchers: 2, shownWatchers: 3, shownVideoWatchers: 2 });
    handlers().onControl({ kind: "audience-changed", watchers: 0, videoWatchers: 0, shownWatchers: 0, shownVideoWatchers: 0 });

    expect(audiences).toEqual([
      { watchers: 3, videoWatchers: 2 },
      { watchers: 0, videoWatchers: 0 },
    ]);
  });

  it("never counts an admin watching hidden", async () => {
    const { goLive, handlers, audiences } = setup();
    await goLive();

    handlers().onControl({ kind: "audience-changed", watchers: 2, videoWatchers: 2, shownWatchers: 1, shownVideoWatchers: 1 });

    expect(audiences).toEqual([{ watchers: 1, videoWatchers: 1 }]);
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
