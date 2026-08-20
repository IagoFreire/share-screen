import type { WebSocket } from "ws";
import type { AudioParams } from "@screenshare-bot/shared";

/**
 * Tracks a single screen-share room: at most one presenter slot plus a bounded
 * set of viewers. Presenter exclusivity and the viewer cap are enforced here so
 * both concerns live in one place instead of being re-checked ad hoc in relay.ts.
 */
export class Room {
  readonly id: string;
  presenter: WebSocket | null = null;
  /** Discord user id of the current presenter, so viewers can recognise their own broadcast. */
  presenterId: string | null = null;
  /** Opus parameters of the current broadcast, relayed so viewers configure a matching decoder. */
  audioParams: AudioParams | null = null;
  private readonly viewers = new Set<WebSocket>();
  private readonly maxViewers: number;

  constructor(id: string, maxViewers: number) {
    this.id = id;
    this.maxViewers = maxViewers;
  }

  get viewerCount(): number {
    return this.viewers.size;
  }

  get hasPresenter(): boolean {
    return this.presenter !== null;
  }

  canAddViewer(): boolean {
    return this.viewers.size < this.maxViewers;
  }

  addViewer(ws: WebSocket): void {
    this.viewers.add(ws);
  }

  removeViewer(ws: WebSocket): void {
    this.viewers.delete(ws);
  }

  /** Returns false if the room already has a different presenter. */
  setPresenter(ws: WebSocket, presenterId: string | null, audioParams: AudioParams | null): boolean {
    if (this.presenter && this.presenter !== ws) return false;
    this.presenter = ws;
    this.presenterId = presenterId;
    this.audioParams = audioParams;
    return true;
  }

  clearPresenterIfMatches(ws: WebSocket): void {
    if (this.presenter === ws) {
      this.presenter = null;
      this.presenterId = null;
      this.audioParams = null;
    }
  }

  isEmpty(): boolean {
    return this.presenter === null && this.viewers.size === 0;
  }

  forEachViewer(fn: (ws: WebSocket) => void): void {
    for (const viewer of this.viewers) fn(viewer);
  }
}
