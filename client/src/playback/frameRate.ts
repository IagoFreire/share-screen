/** How far back a rate looks: long enough to be steady, short enough to show a drop right away. */
const WINDOW_MS = 1000;

export interface FrameRateMeter {
  /** One more frame, at `now` (performance.now()). */
  tick: (now?: number) => void;
  /** Frames per second over the last WINDOW_MS. */
  rate: (now?: number) => number;
}

export function createFrameRateMeter(): FrameRateMeter {
  /** When each frame of the last WINDOW_MS happened, oldest first. */
  const times: number[] = [];

  const prune = (now: number) => {
    while (times.length > 0 && now - times[0]! >= WINDOW_MS) times.shift();
  };

  return {
    tick: (now = performance.now()) => {
      times.push(now);
      prune(now);
    },
    rate: (now = performance.now()) => {
      prune(now);
      return (times.length * 1000) / WINDOW_MS;
    },
  };
}
