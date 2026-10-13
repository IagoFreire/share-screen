import { DEFAULT_STUN_URL } from "@screenshare-bot/shared";

/**
 * Direct viewer<->presenter connections, layered on top of the WebSocket relay.
 *
 * The relay is the floor and is never switched off pre-emptively -- this is the
 * shortcut. What matters isn't the number of hops, it's the transport: the relay runs
 * over TCP, which has no way to discard a late frame. When the network tightens it
 * queues and delivers everything in order, later, so the picture doesn't get worse, it
 * gets *behind* -- which is what a stream lurching along in bursts actually is. WebRTC
 * runs over SRTP/UDP: it lowers its own bitrate on detecting loss, repairs with NACK,
 * and at the limit leaves the stale frame behind. It degrades quality rather than time.
 *
 * Nothing here is required. If negotiation doesn't complete -- symmetric NAT with no
 * TURN, a sandbox that blocks it, a corporate network -- the viewer stays on the relay
 * and nobody notices. That's exactly why the WebCodecs path is still in the codebase.
 */

const FALLBACK_ICE: RTCIceServer[] = [{ urls: DEFAULT_STUN_URL }];

let icePromise: Promise<RTCIceServer[]> | null = null;

/**
 * ICE servers, fetched once per page and reused by every peer connection.
 *
 * Comes from the server because TURN credentials are short-lived and can't be baked
 * into the bundle. A network failure here is no reason to give up on WebRTC: falling
 * back to public STUN still serves everyone behind an ordinary home NAT.
 */
export function iceServers(): Promise<RTCIceServer[]> {
  icePromise ??= fetch("/api/ice")
    .then((response) => (response.ok ? response.json() : null))
    .then((body: { iceServers?: RTCIceServer[] } | null) =>
      Array.isArray(body?.iceServers) && body.iceServers.length ? body.iceServers : FALLBACK_ICE,
    )
    .catch(() => FALLBACK_ICE);
  return icePromise;
}

export function supportsWebRtc(): boolean {
  return typeof RTCPeerConnection === "function";
}

/** Connection states there's no coming back from: the attempt is over. */
const DEAD_STATES: ReadonlySet<string> = new Set(["failed", "closed", "disconnected"]);

export function isDeadState(state: string): boolean {
  return DEAD_STATES.has(state);
}

export interface CreatePeerOptions {
  ice: RTCIceServer[];
  onIceCandidate: (candidate: Record<string, unknown>) => void;
  /** Called once the connection reaches a state it can't recover from. */
  onDead: () => void;
  onTrack?: (event: RTCTrackEvent) => void;
}

/**
 * Creates the connection and wires up the notifications. The caller decides what to do
 * with them -- this module knows nothing about rooms, slots or signalling.
 */
export function createPeer(options: CreatePeerOptions): RTCPeerConnection {
  const pc = new RTCPeerConnection({
    iceServers: options.ice,
    // Puts audio and video on one transport. Without it the same connection negotiates
    // ICE twice, doubling the time to the first frame.
    bundlePolicy: "max-bundle",
  });

  pc.addEventListener("icecandidate", (event) => {
    // The null candidate marks the end of the list rather than being one; forwarding it
    // would make the far side call addIceCandidate(null) and throw.
    if (event.candidate) options.onIceCandidate(event.candidate.toJSON() as Record<string, unknown>);
  });

  pc.addEventListener("connectionstatechange", () => {
    if (isDeadState(pc.connectionState)) options.onDead();
  });

  // Not every browser fires connectionstatechange when ICE fails, and the ICE state
  // gets there first anyway -- it's what gives away a negotiation that won't complete.
  pc.addEventListener("iceconnectionstatechange", () => {
    if (pc.iceConnectionState === "failed") options.onDead();
  });

  if (options.onTrack) pc.addEventListener("track", options.onTrack);

  return pc;
}

export interface SenderTuning {
  /** Ceiling in bits per second -- the same one the presenter picked for the relay. */
  bitrateBps: number;
  framerate: number;
}

/**
 * Tells WebRTC's own encoder how to give way when bandwidth runs short.
 *
 * `maintain-resolution` because this is a screen: text at 10 fps is readable, text
 * downscaled into mush is not -- dropping the resolution of a terminal or a HUD
 * destroys the actual information. (Camera video is the opposite case, which is why
 * this isn't the browser's default.)
 *
 * The bitrate ceiling is the one the presenter already chose for the relay. Without it
 * WebRTC starts from a conservative guess and spends tens of seconds ramping up, which
 * looks exactly like the quality problem the direct connection is meant to solve.
 */
export async function tuneVideoSender(pc: RTCPeerConnection, tuning: SenderTuning): Promise<void> {
  for (const sender of pc.getSenders()) {
    if (sender.track?.kind !== "video") continue;

    const params = sender.getParameters();
    if (!params.encodings?.length) params.encodings = [{}];
    params.degradationPreference = "maintain-resolution";
    for (const encoding of params.encodings) {
      encoding.maxBitrate = tuning.bitrateBps;
      encoding.maxFramerate = tuning.framerate;
    }

    try {
      await sender.setParameters(params);
    } catch {
      // A browser that won't accept the tuning transmits with its own defaults. That's
      // worse, not broken, and there's nothing else to do about it.
    }
  }
}
