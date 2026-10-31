/** AudioContext.setSinkId, which TypeScript's DOM types don't have yet. */
type SinkableContext = AudioContext & { setSinkId?(sinkId: string): Promise<void> };

/** Plays a context through the picked output; null or "default" is the system default (""). */
export async function routeToOutput(context: AudioContext, deviceId: string | null): Promise<void> {
  await (context as SinkableContext).setSinkId?.(deviceId && deviceId !== "default" ? deviceId : "");
}
