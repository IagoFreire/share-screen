import {
  decodeControlMessage,
  decodeFrame,
  encodeControlMessage,
  encodeFrame,
  FrameType,
  type ControlMessage,
  type EncodedFrame,
  type FrameHeader,
} from "@screenshare-bot/shared";

export interface WsClientHandlers {
  onControl: (message: ControlMessage) => void;
  onFrame: (frame: EncodedFrame) => void;
  onOpen?: () => void;
  onClose?: () => void;
}

const RECONNECT_DELAY_MS = 1500;

/** Thin binary WS wrapper around shared/protocol.ts with basic auto-reconnect. */
export class WsClient {
  private socket: WebSocket | null = null;
  private shouldReconnect = true;

  constructor(
    private readonly url: string,
    private readonly handlers: WsClientHandlers,
  ) {}

  connect(): void {
    this.shouldReconnect = true;
    this.open();
  }

  private open(): void {
    const socket = new WebSocket(this.url);
    socket.binaryType = "arraybuffer";

    socket.addEventListener("open", () => this.handlers.onOpen?.());

    socket.addEventListener("message", (event) => {
      const frame = decodeFrame(event.data as ArrayBuffer);
      if (frame.type === FrameType.Control) {
        this.handlers.onControl(decodeControlMessage(frame));
      } else {
        this.handlers.onFrame(frame);
      }
    });

    socket.addEventListener("close", () => {
      this.handlers.onClose?.();
      if (this.shouldReconnect) {
        setTimeout(() => this.open(), RECONNECT_DELAY_MS);
      }
    });

    socket.addEventListener("error", () => socket.close());

    this.socket = socket;
  }

  sendControl(message: ControlMessage): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(encodeControlMessage(0, message));
  }

  sendFrame(header: FrameHeader, payload: Uint8Array): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(encodeFrame(header, payload));
  }

  close(): void {
    this.shouldReconnect = false;
    this.socket?.close();
  }
}
