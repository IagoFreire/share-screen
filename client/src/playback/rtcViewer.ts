import {
  RTC_FIRST_FRAME_DEADLINE_MS,
  RTC_JITTER_BUFFER_TARGET_MS,
  type RtcSignalPayload,
} from "@screenshare-bot/shared";
import { createPeer, iceServers, supportsWebRtc } from "../net/rtc.js";

/**
 * Viewer half of the direct connection (see net/rtc.ts for why it exists).
 *
 * The viewer never offers -- the side holding the media does that -- so everything here
 * starts from an offer arriving over the relay's signalling channel. Until the first
 * frame is genuinely painted, nothing changes: the relay keeps feeding the WebCodecs
 * canvas and this is just a negotiation happening quietly alongside it.
 */

export interface RtcViewerOptions {
  /** Where the direct stream is painted; shown only once it's actually delivering. */
  video: HTMLVideoElement;
  sendSignal: (slot: number, payload: RtcSignalPayload) => void;
  /** Reports to the server whether the relay can stop sending this slot's bytes. */
  sendActive: (slot: number, active: boolean) => void;
  /** Fired when the direct connection takes over (true) or is abandoned (false). */
  onTransportChange: (viaRtc: boolean, slot: number) => void;
}

export interface RtcViewer {
  handleSignal: (slot: number, payload: RtcSignalPayload) => void;
  /** Tears everything down: slot switch, pause, audio-only, disconnect. */
  reset: () => void;
  isActive: () => boolean;
  setVolume: (volume: number) => void;
}

export function createRtcViewer(options: RtcViewerOptions): RtcViewer {
  const { video } = options;
  let pc: RTCPeerConnection | null = null;
  /** Which broadcast the current peer belongs to, or null when there isn't one. */
  let peerSlot: number | null = null;
  let viaRtc = false;
  let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
  let volume = 1;
  /**
   * Bumped by every teardown and every new offer. An offer is handled across two
   * awaits (ICE fetch, then SDP), so a slot switch in the middle would otherwise leave
   * a peer connection running for a broadcast nobody is watching.
   */
  let generation = 0;
  /**
   * ICE candidates that arrived before the remote description was set. Chromium
   * rejects addIceCandidate() until then, and the presenter starts trickling as soon as
   * it has made its offer -- so on a fast connection some always land early.
   */
  let earlyCandidates: RTCIceCandidateInit[] = [];

  video.autoplay = true;
  video.playsInline = true;

  function clearDeadline(): void {
    if (deadlineTimer !== null) clearTimeout(deadlineTimer);
    deadlineTimer = null;
  }

  function reset(): void {
    generation += 1;
    clearDeadline();
    earlyCandidates = [];

    const wasActive = viaRtc;
    const slot = peerSlot;
    viaRtc = false;
    peerSlot = null;

    if (pc) {
      pc.close();
      pc = null;
    }
    video.srcObject = null;

    if (slot !== null) {
      // Reported even when the connection never took over. A negotiation that quietly
      // timed out still left a peer connection open on the presenter's side, and this
      // is what tells it to let go -- waiting for ICE to declare the connection failed
      // takes tens of seconds, during which the presenter would refuse to open a fresh
      // one for this same viewer.
      options.sendActive(slot, false);
      // Only a connection that was actually carrying the picture needs the relay's
      // decoders brought back up.
      if (wasActive) options.onTransportChange(false, slot);
    }
  }

  /** The direct connection is genuinely painting; the relay can stop for this slot. */
  function takeOver(slot: number): void {
    if (viaRtc || peerSlot !== slot) return;
    viaRtc = true;
    clearDeadline();
    video.volume = volume;
    options.sendActive(slot, true);
    options.onTransportChange(true, slot);
  }

  async function handleOffer(slot: number, sdp: string): Promise<void> {
    if (!supportsWebRtc()) return;

    reset();
    const token = ++generation;
    peerSlot = slot;

    try {
      const ice = await iceServers();
      if (token !== generation) return;

      const peer = createPeer({
        ice,
        onIceCandidate: (candidate) => options.sendSignal(slot, { type: "ice", candidate }),
        onDead: () => {
          if (token === generation) reset();
        },
        onTrack: (event) => {
          if (token !== generation) return;
          // Ask the browser for the smallest jitter buffer it will run. The default adapts
          // upward on its own and sits at a few hundred ms on a screen share, which is the
          // delay people notice; a stale frame is better dropped than waited for.
          try {
            event.receiver.jitterBufferTarget = RTC_JITTER_BUFFER_TARGET_MS;
          } catch {
            // Not supported (older Safari/Firefox): the default buffer stays, which is
            // slower but not broken.
          }
          // Both tracks are bundled onto one stream by the presenter, so audio comes
          // along with the video and the element plays the pair in sync by itself --
          // no mediaClock involved on this path.
          video.srcObject = event.streams[0] ?? new MediaStream([event.track]);
          video.volume = volume;
          void video.play().catch(() => {
            // Autoplay policy refused. Picture without sound would be worse than the
            // relay, which is already playing both, so drop the attempt entirely.
            if (token === generation) reset();
          });
        },
      });
      pc = peer;

      await peer.setRemoteDescription({ type: "offer", sdp });
      if (token !== generation) return;

      for (const candidate of earlyCandidates) {
        await peer.addIceCandidate(candidate).catch(() => undefined);
      }
      earlyCandidates = [];

      const answer = await peer.createAnswer();
      await peer.setLocalDescription(answer);
      if (token !== generation) return;

      options.sendSignal(slot, { type: "answer", sdp: peer.localDescription?.sdp ?? answer.sdp ?? "" });

      // The signal that this worked is a frame on screen, not a connection state: a
      // peer that reports "connected" and delivers nothing is indistinguishable from a
      // working one, and cutting the relay on its word would leave a black screen with
      // every status light green.
      video.addEventListener("loadeddata", () => takeOver(slot), { once: true });

      clearDeadline();
      deadlineTimer = setTimeout(() => {
        if (token === generation && !viaRtc) reset();
      }, RTC_FIRST_FRAME_DEADLINE_MS);
    } catch (error) {
      console.warn("[rtc] answer failed:", error);
      if (token === generation) reset();
    }
  }

  return {
    handleSignal: (slot, payload) => {
      if (payload.type === "offer") {
        void handleOffer(slot, payload.sdp);
        return;
      }
      if (payload.type === "ice") {
        if (peerSlot !== slot) return;
        const candidate = payload.candidate as RTCIceCandidateInit;
        if (!pc?.remoteDescription) {
          earlyCandidates.push(candidate);
          return;
        }
        void pc.addIceCandidate(candidate).catch(() => undefined);
        return;
      }
      // An answer is the presenter's job to receive, never the viewer's.
    },
    reset,
    isActive: () => viaRtc,
    setVolume: (next) => {
      volume = next;
      video.volume = next;
    },
  };
}
