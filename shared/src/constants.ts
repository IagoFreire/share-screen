export const MAX_CONCURRENT_ROOMS_DEFAULT = 2;
export const MAX_VIEWERS_PER_ROOM_DEFAULT = 10;

export const TARGET_VIDEO_BITRATE_KBPS_DEFAULT = 6000;
/**
 * Opus stereo. 96k is fine for speech but audibly lossy on music and game audio; 160k
 * is close to transparent for this content. Even at 10 viewers this is ~1.6 Mbps of the
 * egress budget against ~60 Mbps of video, so the quality is essentially free.
 */
export const TARGET_AUDIO_BITRATE_KBPS_DEFAULT = 160;

export const VIDEO_WIDTH_DEFAULT = 1920;
export const VIDEO_HEIGHT_DEFAULT = 1080;
export const VIDEO_FRAMERATE_DEFAULT = 60;

export type ResolutionKey = "480p" | "720p" | "1080p";
export type FramerateKey = 30 | 60;

export const RESOLUTIONS: Record<ResolutionKey, { width: number; height: number }> = {
  "480p": { width: 854, height: 480 },
  "720p": { width: 1280, height: 720 },
  "1080p": { width: 1920, height: 1080 },
};

/**
 * Bitrate targets per resolution/framerate, in kbps. Screen and game content is far
 * more compressible than camera footage, so these sit below generic video-encoding
 * tables. 1080p60 stays at the 6 Mbps figure the deploy doc's egress budget is
 * calculated against (see docs/DEPLOY.md) -- changing it invalidates that math.
 */
export const BITRATE_KBPS: Record<ResolutionKey, Record<FramerateKey, number>> = {
  "480p": { 30: 1200, 60: 1800 },
  "720p": { 30: 2500, 60: 3500 },
  "1080p": { 30: 4000, 60: 6000 },
};

export type BitrateLevelKey = "balanced" | "high" | "max";

/**
 * Multipliers applied on top of the table above.
 *
 * The table's figures suit typical screen and game content, which compresses well. They
 * are not enough for the genuinely hard cases -- a hack-and-slash throwing particles
 * across the whole frame has far less frame-to-frame redundancy for the encoder to
 * exploit, and at a fixed bitrate that shortfall can only come out as softness and
 * blocking exactly during the busiest moments.
 *
 * "balanced" keeps the documented default that docs/DEPLOY.md's egress budget is
 * calculated against; the higher levels cost proportionally more upload and egress, so
 * they're the presenter's call rather than a silent default (1080p60 at "max" lands at
 * 12 Mbps per viewer, the figure YouTube recommends for that format).
 */
export const BITRATE_LEVEL_MULTIPLIERS: Record<BitrateLevelKey, number> = {
  balanced: 1,
  high: 1.5,
  max: 2,
};

export interface QualityPreset {
  width: number;
  height: number;
  framerate: number;
  bitrateKbps: number;
}

export function buildQualityPreset(
  resolution: ResolutionKey,
  framerate: FramerateKey,
  bitrateLevel: BitrateLevelKey = "balanced",
): QualityPreset {
  const { width, height } = RESOLUTIONS[resolution];
  const bitrateKbps = Math.round(BITRATE_KBPS[resolution][framerate] * BITRATE_LEVEL_MULTIPLIERS[bitrateLevel]);
  return { width, height, framerate, bitrateKbps };
}

/** Drop frames for a viewer socket once its outgoing buffer exceeds this many bytes. */
export const BACKPRESSURE_BUFFERED_BYTES_THRESHOLD = 2 * 1024 * 1024; // 2MB

/**
 * Audio bypasses the video threshold above (see backpressure.ts) and only gets dropped
 * at this much higher hard limit, which exists purely to stop a dead socket from growing
 * memory without bound. At ~96 kbps it takes minutes of a completely stalled connection
 * to reach this, so in practice audio always gets through while video is being thinned.
 */
export const BACKPRESSURE_AUDIO_HARD_LIMIT_BYTES = 8 * 1024 * 1024; // 8MB

/** Consecutive over-threshold frames before a stalled viewer socket is force-disconnected. */
export const BACKPRESSURE_STALL_FRAME_COUNT = 30;

/**
 * How far ahead of real time the viewer schedules decoded audio. Without this lead,
 * every late packet lands after the playback cursor and turns into an audible gap;
 * buffering trades a little latency for tolerance of network jitter.
 */
export const AUDIO_JITTER_BUFFER_SECONDS = 0.3;

/**
 * If playback ever falls this far behind the live buffer lead (a burst of packets
 * arriving after a network hiccup, decoded faster than real time), the backlog is
 * dropped and playback jumps back to live instead of accumulating delay forever --
 * the jitter buffer's underrun handling only corrects the opposite direction (buffer
 * running dry), so without this a bad enough hiccup would drift audio further and
 * further behind with no way back.
 */
export const AUDIO_MAX_DRIFT_SECONDS = AUDIO_JITTER_BUFFER_SECONDS + 0.5;

/**
 * Consecutive audio packets are placed by their own capture timestamps so that a lost
 * packet leaves a hole instead of dragging everything after it earlier. Timestamps that
 * land this close to where the previous packet ended are snapped flush against it
 * anyway: the discrepancy at that scale is float rounding from the millisecond wire
 * format, and honouring it literally would open sub-millisecond gaps that click.
 */
export const AUDIO_CONTINUITY_TOLERANCE_SECONDS = 0.005;

/**
 * Same idea for video: decoded frames are held briefly and rendered on a clock instead
 * of being drawn the instant they decode, so uneven arrival stops showing up as stutter.
 * Only used when a broadcast carries no audio -- with audio present, video is presented
 * against the audio clock instead (see playback/mediaClock.ts) and inherits its lead.
 * Keep this equal to AUDIO_JITTER_BUFFER_SECONDS so the two paths behave alike.
 */
export const VIDEO_JITTER_BUFFER_SECONDS = 0.3;

/**
 * How far outside the buffered range of video timestamps the audio clock may sit before
 * video stops trusting it and self-clocks instead. Audio and video timestamps come off
 * the same capture clock, so in practice the difference is milliseconds; this only
 * catches the pathological case of the two tracks reporting on unrelated timebases,
 * where every frame would otherwise look either permanently future-dated (nothing ever
 * renders) or long overdue (the queue flushes every tick).
 */
export const AV_SYNC_PLAUSIBILITY_WINDOW_US = 5_000_000;

/**
 * Hard cap on buffered decoded frames. VideoFrames hold GPU/system memory and must be
 * closed, so an unbounded queue on a stalled connection would balloon memory; past this
 * the oldest frames are dropped.
 *
 * Must stay comfortably above VIDEO_JITTER_BUFFER_SECONDS x 60fps, which is the queue
 * depth normal playback sustains -- too low and the cap fires during healthy playback,
 * dropping frames and resetting the clock instead of only catching runaway growth.
 */
export const VIDEO_JITTER_BUFFER_MAX_FRAMES = Math.ceil(VIDEO_JITTER_BUFFER_SECONDS * 60) + 30;

/**
 * Force a fresh keyframe at least this often (ms) regardless of viewer joins.
 *
 * Keyframes are expensive -- one costs roughly 5-15x a delta frame, and at a fixed
 * bitrate every bit spent on one is taken straight out of the frames that follow it.
 * At a 2s interval that was a recurring quality dip twice as often as most streaming
 * setups use, and worst exactly where it hurts most: a busy scene makes the keyframe
 * itself expensive *and* leaves the deltas around it starved.
 *
 * This is only a safety net. Everything that actually needs a keyframe already asks for
 * one on demand: a viewer joining (relay gates on hasReceivedKeyframe), a decoder error,
 * a tab returning to the foreground, and a mid-stream resolution change. Those on-demand
 * paths are what make a long interval safe -- shortening it again would trade real,
 * continuous picture quality for a redundancy nothing depends on.
 */
export const KEYFRAME_INTERVAL_MS = 10_000;

/**
 * Drop captured frames once the encoder's internal queue backs up past this depth.
 *
 * A busy scene takes longer to encode, so a hard cap of 2 meant the first complexity
 * spike started dropping frames -- visible as judder right when the action picks up. A
 * slightly deeper queue rides out those spikes; at 60fps each extra slot is ~17ms of
 * added latency, which is not perceptible here, while a dropped frame very much is.
 */
export const ENCODER_QUEUE_DROP_THRESHOLD = 4;
