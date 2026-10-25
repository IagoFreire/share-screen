import type { WebSocket } from "ws";
import type { AudioParams, LayerInfo, StreamInfo } from "@screenshare-bot/shared";
import { MAX_PRESENTERS_PER_ROOM } from "@screenshare-bot/shared";
import type { Audience } from "./audience.js";

interface PresenterSlot {
  ws: WebSocket;
  /** Discord user id, so viewers can recognise their own broadcast. */
  presenterId: string | null;
  /** Opus parameters, relayed so viewers configure a matching decoder. */
  audioParams: AudioParams | null;
  /** Simulcast versions this presenter sends; undefined for single-version senders. */
  layers: LayerInfo[] | undefined;
  /** Last audience told to the presenter; null until the relay first counts it. */
  audience: Audience | null;
}

/**
 * Tracks a single screen-share room: up to MAX_PRESENTERS_PER_ROOM concurrent
 * broadcasts plus a bounded set of viewers. Slot allocation and the viewer cap are
 * enforced here so both concerns live in one place instead of being re-checked ad hoc
 * in relay.ts.
 *
 * Each broadcast owns a frame slot for as long as it runs, and that slot number is what
 * viewers use to say which one they want. Slots are reused once freed, so people
 * cycling through broadcasts never exhaust them.
 */
export class Room {
  readonly id: string;
  /**
   * Guild this room's channel belongs to, learned from the first join that supplies it.
   * Only used to label the admin's cross-server broadcast list -- the relay itself never
   * needs it, since rooms are keyed by channel id, which is already globally unique.
   */
  guildId: string | null = null;
  private readonly presenters = new Map<number, PresenterSlot>();
  private readonly viewers = new Set<WebSocket>();
  private readonly maxViewers: number;

  constructor(id: string, maxViewers: number) {
    this.id = id;
    this.maxViewers = maxViewers;
  }

  get viewerCount(): number {
    return this.viewers.size;
  }

  get hasPresenters(): boolean {
    return this.presenters.size > 0;
  }

  /** Snapshot of every live broadcast, ordered by slot so the viewer UI is stable. */
  get streams(): StreamInfo[] {
    return [...this.presenters.entries()]
      .sort(([a], [b]) => a - b)
      .map(([slot, presenter]) => ({
        slot,
        presenterId: presenter.presenterId,
        audio: presenter.audioParams,
        ...(presenter.layers ? { layers: presenter.layers } : {}),
        ...(this.isPaused(slot) ? { paused: true } : {}),
      }));
  }

  /** True once the broadcast on `slot` is known to send nothing: no sound, no picture. */
  isPaused(slot: number): boolean {
    const audience = this.presenters.get(slot)?.audience;
    return audience?.watchers === 0 && audience.videoWatchers === 0;
  }

  /**
   * Records who receives the broadcast on `slot`. Returns false when that is what was
   * already recorded, so the presenter is only told about actual changes.
   */
  setAudience(slot: number, audience: Audience): boolean {
    const presenter = this.presenters.get(slot);
    if (!presenter) return false;
    const previous = presenter.audience;
    if (previous?.watchers === audience.watchers && previous.videoWatchers === audience.videoWatchers) return false;
    this.presenters.set(slot, { ...presenter, audience });
    return true;
  }

  /** How many simulcast versions the broadcast on `slot` carries (1 if it isn't simulcast). */
  layerCountOf(slot: number): number {
    return this.presenters.get(slot)?.layers?.length || 1;
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

  /**
   * Claims the lowest free slot for `ws`. Returns the slot number, or null when the
   * room is already at MAX_PRESENTERS_PER_ROOM. Re-registering a socket that already
   * holds a slot updates it in place rather than taking a second one, which would
   * strand the first until that socket closed.
   */
  allocateSlot(
    ws: WebSocket,
    presenterId: string | null,
    audioParams: AudioParams | null,
    layers?: LayerInfo[],
  ): number | null {
    // The audience starts unknown either way: a re-registered presenter restarts its
    // encoders, so it has to be told again whether anyone is watching.
    const existing = this.slotOf(ws);
    if (existing !== null) {
      this.presenters.set(existing, { ws, presenterId, audioParams, layers, audience: null });
      return existing;
    }

    for (let slot = 0; slot < MAX_PRESENTERS_PER_ROOM; slot += 1) {
      if (!this.presenters.has(slot)) {
        this.presenters.set(slot, { ws, presenterId, audioParams, layers, audience: null });
        return slot;
      }
    }
    return null;
  }

  getPresenter(slot: number): PresenterSlot | undefined {
    return this.presenters.get(slot);
  }

  /** The slot this socket broadcasts on, or null if it isn't a presenter. */
  slotOf(ws: WebSocket): number | null {
    for (const [slot, presenter] of this.presenters) {
      if (presenter.ws === ws) return slot;
    }
    return null;
  }

  /** Finds the slot belonging to `presenterId`, used to authorise stop requests. */
  slotOfUser(presenterId: string): number | null {
    for (const [slot, presenter] of this.presenters) {
      if (presenter.presenterId === presenterId) return slot;
    }
    return null;
  }

  /** Frees this socket's slot if it holds one. Returns the freed slot, else null. */
  clearSlotFor(ws: WebSocket): number | null {
    const slot = this.slotOf(ws);
    if (slot === null) return null;
    this.presenters.delete(slot);
    return slot;
  }

  isEmpty(): boolean {
    return this.presenters.size === 0 && this.viewers.size === 0;
  }

  forEachViewer(fn: (ws: WebSocket) => void): void {
    for (const viewer of this.viewers) fn(viewer);
  }

  forEachPresenter(fn: (ws: WebSocket) => void): void {
    for (const presenter of this.presenters.values()) fn(presenter.ws);
  }
}
