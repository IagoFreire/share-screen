import type { DesktopAppAudio } from "@screenshare-bot/shared";

/**
 * Turns the audio helper's PCM (every app except the excluded ones, see
 * desktop/native/audio-helper) into an ordinary audio MediaStreamTrack, so the existing
 * Opus pipeline encodes it exactly like a captured track.
 *
 * Timestamps matter: viewers schedule video against the audio clock. Electron's screen
 * capture stamps video frames on a different clock (time since boot) than
 * performance.now(), so the offset between the two is measured from a real video frame
 * and applied to every audio block -- otherwise viewers lose lip sync.
 */

const SAMPLE_RATE = 48_000;
const CHANNELS = 2;
const BLOCK_US = 10_000;
/** The helper holds ~30 ms before mixing, plus a pipe and an IPC hop. */
const HELPER_LATENCY_US = 40_000;
/** Arrival time and the block count disagreeing by more than this is "off". */
const RESYNC_THRESHOLD_US = 50_000;
/**
 * How long blocks must keep arriving off the count before the clock wins. A page that
 * stalls (a slow CPU busy with the video encoders) hands over its backlog in one burst
 * that ends back in step, so it never lasts this long; a gap that does is real -- the
 * helper skipped part of its schedule, or the first block was itself delayed.
 */
const RESYNC_AFTER_US = 300_000;

/**
 * Stamps blocks at an even 10 ms pace: the helper sends one continuous stream, so the
 * block count is the true timeline and arrival times only add delivery delay. Stamping
 * a stalled page's burst by its arrival left a hole before it and stacked the rest on
 * top of each other -- audio that stuttered for viewers. The real clock takes over only
 * once the two have disagreed for RESYNC_AFTER_US.
 */
export function createAudioTimeline(blockUs: number): { stamp(estimatedCaptureUs: number): number } {
  let next: number | null = null;
  /** Arrival of the first block of the current off-count run, and which way it is off. */
  let off: { sinceUs: number; late: boolean } | null = null;
  return {
    stamp(estimatedCaptureUs) {
      let stamped = next ?? estimatedCaptureUs;
      if (next !== null) {
        const offByUs = estimatedCaptureUs - next;
        const late = offByUs > 0;
        if (Math.abs(offByUs) <= RESYNC_THRESHOLD_US) {
          off = null;
        } else if (off === null || off.late !== late) {
          off = { sinceUs: estimatedCaptureUs, late };
        } else if (estimatedCaptureUs - off.sinceUs >= RESYNC_AFTER_US) {
          stamped = estimatedCaptureUs;
          off = null;
        }
      }
      next = stamped + blockUs;
      return stamped;
    },
  };
}

/** How far the video track's timestamps are from performance.now(), in µs. */
async function measureVideoClockOffsetUs(videoTrack: MediaStreamTrack): Promise<number> {
  const probe = videoTrack.clone();
  const reader = new MediaStreamTrackProcessor({ track: probe }).readable.getReader();
  try {
    const { value: frame } = await reader.read();
    if (!frame) return 0;
    const offset = frame.timestamp - performance.now() * 1000;
    frame.close();
    return offset;
  } finally {
    void reader.cancel();
    probe.stop();
  }
}

export interface AppAudioTrack {
  track: MediaStreamTrack;
  stop(): void;
}

export async function startAppAudioTrack(
  appAudio: DesktopAppAudio,
  exclude: string[],
  videoTrack: MediaStreamTrack,
): Promise<AppAudioTrack> {
  const offsetUs = await measureVideoClockOffsetUs(videoTrack);
  const generator = new MediaStreamTrackGenerator({ kind: "audio" });
  // The shared declaration types `writable` for video; an audio generator takes AudioData.
  const writer = (generator.writable as unknown as WritableStream<AudioData>).getWriter();
  const timeline = createAudioTimeline(BLOCK_US);

  const unsubscribe = appAudio.onBlock((pcm) => {
    const timestamp = timeline.stamp(performance.now() * 1000 + offsetUs - HELPER_LATENCY_US);
    const data = new AudioData({
      format: "f32",
      sampleRate: SAMPLE_RATE,
      numberOfChannels: CHANNELS,
      numberOfFrames: pcm.length / CHANNELS,
      timestamp,
      data: pcm as Float32Array<ArrayBuffer>,
    });
    writer.write(data).catch(() => data.close());
  });

  try {
    await appAudio.start(exclude);
  } catch (error) {
    unsubscribe();
    generator.stop();
    throw error;
  }

  return {
    track: generator,
    stop() {
      unsubscribe();
      appAudio.stop();
      writer.close().catch(() => {});
      generator.stop();
    },
  };
}
