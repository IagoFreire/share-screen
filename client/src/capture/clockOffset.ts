/**
 * Puts a capture's audio on the same clock as its video.
 *
 * Viewers present video against the audio timestamps, which only works when both
 * tracks are stamped on one clock. In Electron they are not: screen-capture frames carry
 * the time since boot, while Chromium's system-audio loopback is stamped on the page's
 * performance.now() clock -- hours apart, so viewers can't lock the two at all and the
 * picture runs free of the sound. The desktop's per-app audio is already rebased (see
 * desktop/appAudio.ts), and tracks that share a clock measure milliseconds apart; for
 * those this changes nothing.
 */

/** Beyond this, the tracks run on different clocks rather than differ by delivery delay. */
const CLOCK_MISMATCH_US = 1_000_000;
const VIDEO_SAMPLES = 3;
const AUDIO_SAMPLES = 5;
/** Stop waiting for samples after this; a still screen can deliver frames slowly. */
const SAMPLE_TIMEOUT_MS = 1_500;
/** An AudioContext reports its output latency only once it has been running briefly. */
const OUTPUT_LATENCY_SETTLE_MS = 300;

export interface ClockSample {
  timestampUs: number;
  /** performance.now() when the sample was read, in µs. */
  readAtUs: number;
}

/**
 * How far a track's stamps run from performance.now(). Delivery delay only ever makes a
 * sample look older, so the largest offset is the closest to the truth.
 */
export function estimateClockOffsetUs(samples: readonly ClockSample[]): number | null {
  if (samples.length === 0) return null;
  return Math.max(...samples.map((sample) => sample.timestampUs - sample.readAtUs));
}

/** What to add to audio timestamps to put them on the video's clock. */
export function audioRebaseUs(videoOffsetUs: number | null, audioOffsetUs: number | null): number {
  if (videoOffsetUs === null || audioOffsetUs === null) return 0;
  const difference = videoOffsetUs - audioOffsetUs;
  return Math.abs(difference) > CLOCK_MISMATCH_US ? difference : 0;
}

async function sampleClock(track: MediaStreamTrack, count: number): Promise<ClockSample[]> {
  const probe = track.clone();
  const reader = new MediaStreamTrackProcessor<VideoFrame | AudioData>({ track: probe }).readable.getReader();
  const samples: ClockSample[] = [];
  const read = (async () => {
    while (samples.length < count) {
      const { value, done } = await reader.read();
      if (done || !value) return;
      samples.push({ timestampUs: value.timestamp, readAtUs: performance.now() * 1000 });
      value.close();
    }
  })();
  const timeout = new Promise<void>((resolve) => setTimeout(resolve, SAMPLE_TIMEOUT_MS));
  try {
    await Promise.race([read, timeout]);
    return [...samples];
  } finally {
    reader.cancel().catch(() => undefined);
    probe.stop();
  }
}

/**
 * How long this computer's sound takes from the mix to the speakers. System-audio
 * loopback taps the mix before that, so its stamps run early by this much against what
 * the presenter hears and sees (measured: ~66 ms here, and viewers heard loopback audio
 * ~75 ms ahead of the picture). 0 when it can't be read.
 */
async function measureOutputLatencyUs(): Promise<number> {
  const context = new AudioContext();
  try {
    await context.resume();
    await new Promise((resolve) => setTimeout(resolve, OUTPUT_LATENCY_SETTLE_MS));
    return Math.round(((context.outputLatency || 0) + context.baseLatency) * 1_000_000);
  } catch (error) {
    console.error("Couldn't read the audio output latency:", error);
    return 0;
  } finally {
    context.close().catch(() => undefined);
  }
}

/** measureAudioRebaseUs for system-audio loopback: also delays it to when it was heard. */
export async function measureLoopbackAudioRebaseUs(
  videoTrack: MediaStreamTrack,
  audioTrack: MediaStreamTrack,
): Promise<number> {
  const [rebaseUs, latencyUs] = await Promise.all([
    measureAudioRebaseUs(videoTrack, audioTrack),
    measureOutputLatencyUs(),
  ]);
  return rebaseUs + latencyUs;
}

/** The shift for this capture's audio; 0 when the clocks agree or can't be compared. */
export async function measureAudioRebaseUs(videoTrack: MediaStreamTrack, audioTrack: MediaStreamTrack): Promise<number> {
  try {
    const [video, audio] = await Promise.all([
      sampleClock(videoTrack, VIDEO_SAMPLES),
      sampleClock(audioTrack, AUDIO_SAMPLES),
    ]);
    return audioRebaseUs(estimateClockOffsetUs(video), estimateClockOffsetUs(audio));
  } catch (error) {
    console.error("Couldn't compare the audio and video clocks:", error);
    return 0;
  }
}
