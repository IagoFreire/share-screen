import { ADMIN_LOBBY_ROOM_ID, voiceLiveRoomId } from "@screenshare-bot/shared";
import type { VoiceState } from "./voicePoller.js";

/**
 * Which relay room the desktop app is in: the voice room you sit in inside the app
 * (when voice rooms are on), else your Discord voice channel, else -- for an admin --
 * the lobby, from which every live can be opened. A voice room wins over a Discord
 * channel: sitting in one is something you just did in this app.
 */

export type PlaceKind = "voice-room" | "discord" | "lobby";

export interface LivePlace {
  kind: PlaceKind;
  /** The relay room. */
  roomId: string;
  guildId: string | null;
  name: string;
}

export interface PlaceInput {
  /** Your Discord voice channel, from voicePoller.ts. */
  discord: VoiceState;
  /** The app's voice room you sit in, if any. */
  voiceRoom: { id: string; name: string } | null;
  /** The voice socket can't say yet where you sit: connecting, or getting back into a room. */
  voiceRoomUnsettled: boolean;
  isAdmin: boolean;
}

const FALLBACK_CHANNEL_NAME = "canal de voz";
const LOBBY_NAME = "Lives ativas";

/** Where "Transmitir" sends a live; the lobby never takes one. */
export function transmitPlace(input: PlaceInput): LivePlace | null {
  if (input.voiceRoom) {
    return { kind: "voice-room", roomId: voiceLiveRoomId(input.voiceRoom.id), guildId: null, name: input.voiceRoom.name };
  }
  if (input.discord.status === "in-channel") {
    const { location } = input.discord;
    return { kind: "discord", roomId: location.channelId, guildId: location.guildId, name: location.channelName ?? FALLBACK_CHANNEL_NAME };
  }
  return null;
}

/**
 * Where the player connects. `current` is where it is now: it stays in a voice room
 * while the voice socket reconnects instead of bouncing out and back in.
 */
export function playerPlace(input: PlaceInput, current: LivePlace | null): LivePlace | null {
  if (input.voiceRoomUnsettled && current?.kind === "voice-room") return current;
  const place = transmitPlace(input);
  if (place) return place;
  // Not knowing your Discord channel yet isn't being in none: wait rather than flash the lobby.
  if (input.discord.status === "unknown" || !input.isAdmin) return null;
  return { kind: "lobby", roomId: ADMIN_LOBBY_ROOM_ID, guildId: null, name: LOBBY_NAME };
}

/** Every relay room you are in right now, for noticing that you left the one you broadcast to. */
export interface Whereabouts {
  /** False while either side can't tell yet; leaving is only judged once both can. */
  known: boolean;
  roomIds: string[];
}

export function whereabouts(input: PlaceInput): Whereabouts {
  const roomIds = [
    ...(input.voiceRoom ? [voiceLiveRoomId(input.voiceRoom.id)] : []),
    ...(input.discord.status === "in-channel" ? [input.discord.location.channelId] : []),
  ];
  return { known: input.discord.status !== "unknown" && !input.voiceRoomUnsettled, roomIds };
}
