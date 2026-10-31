import { routeToOutput } from "./audioOutput.js";
import { openMicInput, type MicInputOptions } from "./micInput.js";
import { createVoiceGate, levelOfDb } from "./voiceLevel.js";

/**
 * "Testar áudio" in the device panel. The microphone test plays the user back to
 * themselves exactly as the room would hear them -- same device, RNNoise, gain and
 * sensitivity gate -- on the picked output. The output test plays a short chime there.
 */

export interface MicTestOptions extends MicInputOptions {
  sensitivityDb: number;
  outputDeviceId: string | null;
}

export interface MicTest {
  readonly noiseSuppressed: boolean;
  setGain(gain: number): void;
  setSensitivity(db: number): void;
  /** Loudness 0-1, gated or not: the sensitivity meter. */
  inputLevel(): number;
  /** Whether the gate is letting the voice through right now. */
  transmitting(): boolean;
  stop(): void;
}

/** How often the gate re-reads the level; one Opus packet's worth. */
const GATE_TICK_MS = 20;
const GATE_FADE_SECONDS = 0.01;

export async function startMicTest(options: MicTestOptions): Promise<MicTest> {
  const input = await openMicInput(options);
  const gateGain = input.context.createGain();
  gateGain.gain.value = 0;
  input.output.connect(gateGain);
  gateGain.connect(input.context.destination);
  await routeToOutput(input.context, options.outputDeviceId).catch((error) => console.error("Output device:", error));

  const gate = createVoiceGate();
  let sensitivityDb = options.sensitivityDb;
  let open = false;
  const timer = setInterval(() => {
    open = gate.pass(input.db(), sensitivityDb, performance.now());
    gateGain.gain.setTargetAtTime(open ? 1 : 0, input.context.currentTime, GATE_FADE_SECONDS);
  }, GATE_TICK_MS);

  return {
    noiseSuppressed: input.noiseSuppressed,
    setGain: (gain) => input.setGain(gain),
    setSensitivity(db) {
      sensitivityDb = db;
    },
    inputLevel: () => levelOfDb(input.db()),
    transmitting: () => open,
    stop() {
      clearInterval(timer);
      input.close();
    },
  };
}

/** Two soft notes, rising: enough to tell which speaker or headset is playing. */
const CHIME = [
  { at: 0.05, hz: 660 },
  { at: 0.27, hz: 880 },
];
const CHIME_PEAK = 0.25;
const CHIME_NOTE_SECONDS = 0.6;
const CHIME_TOTAL_MS = 1100;

export async function playOutputTest(outputDeviceId: string | null): Promise<void> {
  const context = new AudioContext();
  try {
    await routeToOutput(context, outputDeviceId);
    const start = context.currentTime;
    for (const note of CHIME) {
      const time = start + note.at;
      const oscillator = context.createOscillator();
      oscillator.frequency.value = note.hz;
      const envelope = context.createGain();
      envelope.gain.setValueAtTime(0, time);
      envelope.gain.linearRampToValueAtTime(CHIME_PEAK, time + 0.02);
      envelope.gain.exponentialRampToValueAtTime(0.001, time + CHIME_NOTE_SECONDS);
      oscillator.connect(envelope).connect(context.destination);
      oscillator.start(time);
      oscillator.stop(time + CHIME_NOTE_SECONDS);
    }
    await new Promise((resolve) => setTimeout(resolve, CHIME_TOTAL_MS));
  } finally {
    await context.close().catch(() => undefined);
  }
}
