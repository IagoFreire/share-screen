import {
  decodeVoiceControl,
  decodeVoiceFrame,
  encodeFrame,
  encodeVoiceControl,
  FrameType,
  type VoiceClientMessage,
  type VoiceRoomInfo,
  type VoiceServerMessage,
} from "@screenshare-bot/shared";
import { startMicCapture, type MicCapture } from "./micCapture.js";
import { startVoicePlayback, type VoicePlayback } from "./voicePlayback.js";
import {
  saveDevice,
  savedDevice,
  savedNoiseSuppression,
  saveNoiseSuppression,
  type DeviceKind,
} from "./voiceDevices.js";

/**
 * The desktop app's voice rooms (shared/src/voice.ts) as one observable object: the
 * /voice socket, the room list, and -- while in a room -- the microphone and the mix of
 * everyone else. The UI renders from state() and calls the actions; levels are read
 * every frame for the speaking rings.
 */

export interface VoiceState {
  connected: boolean;
  userId: string | null;
  rooms: VoiceRoomInfo[];
  /** The room this app is in, and its seat there. */
  roomId: string | null;
  slot: number | null;
  muted: boolean;
  deafened: boolean;
  /** RNNoise wanted by the user; `noiseActive` says whether it is really running. */
  noiseSuppression: boolean;
  noiseActive: boolean;
  /** The microphone couldn't be opened (denied, none plugged in). */
  micError: string | null;
  /** Last thing the server refused, for the UI to show once. */
  error: string | null;
}

export interface VoiceSession {
  state(): VoiceState;
  onChange(listener: () => void): void;
  createRoom(name: string): void;
  joinRoom(roomId: string): void;
  leaveRoom(): void;
  toggleMute(): void;
  toggleDeafen(): void;
  setNoiseSuppression(on: boolean): void;
  setDevice(kind: DeviceKind, deviceId: string): void;
  /** Loudness 0-1 of a seat in the current room; the user's own seat reads the microphone. */
  levelOf(slot: number): number;
  close(): void;
}

export interface VoiceSessionOptions {
  url: string;
  session: string;
  name: string;
  avatarUrl: string | null;
  onSessionInvalid(): void;
}

const RECONNECT_DELAY_MS = 1500;

export function startVoiceSession(options: VoiceSessionOptions): VoiceSession {
  let state: VoiceState = {
    connected: false,
    userId: null,
    rooms: [],
    roomId: null,
    slot: null,
    muted: false,
    deafened: false,
    noiseSuppression: savedNoiseSuppression(),
    noiseActive: false,
    micError: null,
    error: null,
  };
  const listeners: Array<() => void> = [];
  let socket: WebSocket | null = null;
  let closed = false;
  /** The room to get back into after the socket drops. */
  let rejoinRoomId: string | null = null;
  let mic: MicCapture | null = null;
  let micStarting = false;
  let playback: VoicePlayback | null = null;
  let packetClock = 0;
  /** Mute as the user left it, restored when they undeafen (deafening mutes, as in Discord). */
  let mutedBeforeDeafen = false;

  function update(patch: Partial<VoiceState>): void {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  }

  function send(message: VoiceClientMessage): void {
    if (socket?.readyState === WebSocket.OPEN) socket.send(encodeVoiceControl(message));
  }

  function sendState(): void {
    send({ kind: "set-state", muted: state.muted || state.deafened, deafened: state.deafened });
  }

  function sendPacket(chunk: EncodedAudioChunk): void {
    if (socket?.readyState !== WebSocket.OPEN || state.muted || state.deafened) return;
    const payload = new Uint8Array(chunk.byteLength);
    chunk.copyTo(payload);
    packetClock += 1;
    socket.send(encodeFrame({ slot: 0, type: FrameType.Audio, timestamp: chunk.timestamp / 1000, clock: packetClock }, payload));
  }

  async function startMic(): Promise<void> {
    if (mic || micStarting) return;
    micStarting = true;
    try {
      const started = await startMicCapture({
        deviceId: savedDevice("input"),
        noiseSuppression: state.noiseSuppression,
        onPacket: sendPacket,
      });
      micStarting = false;
      if (state.roomId === null) {
        started.stop(); // left while the microphone was opening
        return;
      }
      mic = started;
      mic.setMuted(state.muted || state.deafened);
      update({ noiseActive: mic.noiseSuppressed, micError: null });
    } catch (error) {
      micStarting = false;
      console.error("Failed to open the microphone:", error);
      update({ micError: "Não foi possível abrir o microfone." });
    }
  }

  function stopMic(): void {
    mic?.stop();
    mic = null;
  }

  function restartMic(): void {
    if (!mic) return;
    stopMic();
    void startMic();
  }

  function enterRoom(): void {
    if (!playback) {
      playback = startVoicePlayback();
      playback.setDeafened(state.deafened);
      void playback.setOutputDevice(savedDevice("output")).catch((error) => console.error("Output device:", error));
    }
    void startMic();
  }

  function exitRoom(): void {
    stopMic();
    playback?.stop();
    playback = null;
  }

  function handleControl(message: VoiceServerMessage): void {
    switch (message.kind) {
      case "welcome":
        update({ userId: message.userId });
        return;
      case "rooms": {
        update({ rooms: message.rooms });
        const here = message.rooms.find((room) => room.id === state.roomId);
        if (here) playback?.keepOnly(here.members.map((member) => member.slot));
        if (rejoinRoomId) {
          const target = rejoinRoomId;
          rejoinRoomId = null;
          if (message.rooms.some((room) => room.id === target)) send({ kind: "join-room", roomId: target });
        }
        return;
      }
      case "in-room":
        update({ roomId: message.roomId, slot: message.slot });
        if (message.roomId) {
          enterRoom();
          sendState();
        } else {
          exitRoom();
        }
        return;
      case "error":
        if (message.code === "invalid-session") {
          close();
          options.onSessionInvalid();
          return;
        }
        update({ error: message.message });
        return;
      default:
        return;
    }
  }

  function connect(): void {
    const ws = new WebSocket(options.url);
    ws.binaryType = "arraybuffer";
    socket = ws;
    ws.addEventListener("open", () => {
      update({ connected: true });
      send({ kind: "hello", session: options.session, name: options.name, avatarUrl: options.avatarUrl });
    });
    ws.addEventListener("message", (event) => {
      try {
        const frame = decodeVoiceFrame(event.data as ArrayBuffer);
        if (frame.type === FrameType.Control) handleControl(decodeVoiceControl(frame) as VoiceServerMessage);
        else if (frame.type === FrameType.Audio) playback?.push(frame.slot, frame.timestamp * 1000, frame.payload);
      } catch (error) {
        console.error("Bad voice message:", error);
      }
    });
    ws.addEventListener("close", () => {
      if (socket !== ws) return;
      socket = null;
      // The server forgot this connection's seat; get back in once reconnected.
      rejoinRoomId = state.roomId;
      exitRoom();
      update({ connected: false, roomId: null, slot: null });
      if (!closed) setTimeout(connect, RECONNECT_DELAY_MS);
    });
    ws.addEventListener("error", () => ws.close());
  }

  function close(): void {
    closed = true;
    exitRoom();
    socket?.close();
    socket = null;
  }

  connect();

  return {
    state: () => state,
    onChange: (listener) => listeners.push(listener),
    createRoom: (name) => {
      update({ error: null });
      send({ kind: "create-room", name });
    },
    joinRoom: (roomId) => {
      update({ error: null });
      send({ kind: "join-room", roomId });
    },
    leaveRoom: () => send({ kind: "leave-room" }),
    toggleMute() {
      if (state.deafened) {
        // Unmuting while deafened undeafens too, as in Discord.
        update({ deafened: false, muted: false });
        playback?.setDeafened(false);
      } else {
        update({ muted: !state.muted });
      }
      mic?.setMuted(state.muted || state.deafened);
      sendState();
    },
    toggleDeafen() {
      if (state.deafened) {
        update({ deafened: false, muted: mutedBeforeDeafen });
      } else {
        mutedBeforeDeafen = state.muted;
        update({ deafened: true });
      }
      playback?.setDeafened(state.deafened);
      mic?.setMuted(state.muted || state.deafened);
      sendState();
    },
    setNoiseSuppression(on) {
      saveNoiseSuppression(on);
      update({ noiseSuppression: on });
      restartMic();
    },
    setDevice(kind, deviceId) {
      saveDevice(kind, deviceId);
      if (kind === "input") restartMic();
      else void playback?.setOutputDevice(deviceId).catch((error) => console.error("Output device:", error));
      update({});
    },
    levelOf(slot) {
      if (slot === state.slot) return mic && !state.muted && !state.deafened ? mic.level() : 0;
      return playback?.levelOf(slot) ?? 0;
    },
    close,
  };
}
