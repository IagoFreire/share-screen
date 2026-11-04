/**
 * Which H.264 encoder setups to try, in order; the first one the browser supports wins.
 *
 * Viewers always open their decoder as High 5.1 (see playback/videoDecodePipeline.ts).
 * That still plays Constrained Baseline: it is a subset of High, and the inline SPS in
 * every Annex B keyframe tells the decoder the real profile.
 */

/** H.264 High, Level 5.1 -- supports 1080p60 and compresses best. */
export const VIDEO_CODEC_HIGH = "avc1.640033";
/**
 * H.264 Constrained Baseline, Level 5.1: no CABAC and no B-frames, so a software encoder
 * spends noticeably less CPU per frame, for ~10% more bits at the same picture.
 */
export const VIDEO_CODEC_BASELINE = "avc1.42e033";

export interface EncoderAttempt {
  codec: string;
  hardwareAcceleration: HardwareAcceleration;
}

export interface EncoderNeeds {
  /** Potato: spend as little CPU as possible (see POTATO_PRESET). */
  lowPower: boolean;
  /** The hardware encoder kept failing; stay on software from now on. */
  softwareOnly: boolean;
}

export function encoderAttempts({ lowPower, softwareOnly }: EncoderNeeds): EncoderAttempt[] {
  if (!lowPower) {
    return [{ codec: VIDEO_CODEC_HIGH, hardwareAcceleration: softwareOnly ? "prefer-software" : "no-preference" }];
  }
  // The GPU encoder costs almost no CPU, and on it High is free; without one, Baseline
  // is the cheapest thing the CPU can encode.
  const software: EncoderAttempt = { codec: VIDEO_CODEC_BASELINE, hardwareAcceleration: "prefer-software" };
  return softwareOnly ? [software] : [{ codec: VIDEO_CODEC_HIGH, hardwareAcceleration: "prefer-hardware" }, software];
}
