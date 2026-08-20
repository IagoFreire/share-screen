/**
 * Ambient declarations for browser APIs not yet in TypeScript's bundled lib.dom.d.ts:
 * MediaStreamTrackProcessor / MediaStreamTrackGenerator (insertable streams for
 * MediaStreamTrack). Chrome/Chromium-only as of writing, which is acceptable since
 * both the presenter's browser and Discord's embedded Chromium client are Chromium-based.
 */

interface MediaStreamTrackProcessorInit {
  track: MediaStreamTrack;
}

declare class MediaStreamTrackProcessor<T = VideoFrame> {
  constructor(init: MediaStreamTrackProcessorInit);
  readonly readable: ReadableStream<T>;
}

interface MediaStreamTrackGeneratorInit {
  kind: "video" | "audio";
}

declare class MediaStreamTrackGenerator extends MediaStreamTrack {
  constructor(init: MediaStreamTrackGeneratorInit);
  readonly writable: WritableStream<VideoFrame>;
}
