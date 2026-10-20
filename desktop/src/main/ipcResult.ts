/**
 * ipcRenderer.invoke() rewrites a rejected handler's error into "Error invoking remote
 * method '<channel>': Error: <message>", which is no message to show anyone. Handlers
 * whose errors are meant for the user resolve to this instead, and the preload turns a
 * failure back into an Error carrying just the original message.
 */
export type IpcResult<T> = { ok: true; value: T } | { ok: false; message: string };

const GENERIC_MESSAGE = "Algo deu errado. Tente de novo.";

export async function toIpcResult<T>(work: Promise<T>): Promise<IpcResult<T>> {
  try {
    return { ok: true, value: await work };
  } catch (error) {
    return { ok: false, message: error instanceof Error && error.message ? error.message : GENERIC_MESSAGE };
  }
}
