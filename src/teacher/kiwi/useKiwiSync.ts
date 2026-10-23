import { createContext, useContext } from "react";
import type { KiwiSyncState, KiwiSyncStatus } from "../../types";

/*
 * Kiwi sync context and the single sync loop (TELEMETRY; signatures frozen, §7.9 / §15.2 [AU-D4-18, AU-D4-23]).
 * TeacherShell mounts one <KiwiSyncProvider> around every page, which owns one `KiwiSyncLoop`; pages only read the
 * context, so three mounted pages still issue one POST /api/teacher/kiwi/sync per interval. `newActivity` turns true
 * only when a sync reports `imported > 0`; `revision` increases when the teacher acknowledges it (pages reload once,
 * instead of the v0.5.1 behavior where every 30 s sync cleared loaded pages).
 */
export interface KiwiSyncContextValue extends KiwiSyncState {
  revision: number;
}

const DISCONNECTED: KiwiSyncContextValue = {
  status: null,
  newActivity: false,
  acknowledge: () => undefined,
  refresh: () => undefined,
  error: "",
  revision: 0,
};

export const KiwiSyncContext = createContext<KiwiSyncContextValue>(DISCONNECTED);

export function useKiwiSync(): KiwiSyncState {
  return useContext(KiwiSyncContext);
}
/** Increments after "New activity · Refresh"; pages that show Kiwi data reload when it changes. */
export function useKiwiRefreshRevision(): number {
  return useContext(KiwiSyncContext).revision;
}

export const SYNC_INTERVAL_MS = 30_000;
export const SYNC_CONTINUE_MS = 1_200;

export interface KiwiSyncApi {
  status(classId: string): Promise<KiwiSyncStatus>;
  sync(classId: string): Promise<KiwiSyncStatus>;
}
export interface KiwiSyncLoopState {
  status: KiwiSyncStatus | null;
  newActivity: boolean;
  error: string;
  revision: number;
}

/** One sync loop for one course; framework-free so it can be tested with fake timers. */
export class KiwiSyncLoop {
  private state: KiwiSyncLoopState = { status: null, newActivity: false, error: "", revision: 0 };
  private readonly listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private generation = 0;

  constructor(
    readonly classId: string,
    private readonly api: KiwiSyncApi,
    private readonly canSync: () => boolean,
  ) {}

  getState = (): KiwiSyncLoopState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private set(patch: Partial<KiwiSyncLoopState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const generation = ++this.generation;
    this.api
      .status(this.classId)
      .then((status) => {
        if (!this.active(generation)) return;
        this.set({ status, error: "" });
        if (this.canSync() && status.connected) void this.sync(generation);
      })
      .catch((e: unknown) => {
        if (this.active(generation)) this.set({ error: e instanceof Error ? e.message : String(e) });
      });
  }

  stop(): void {
    this.running = false;
    this.generation += 1;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private active(generation: number): boolean {
    return this.running && generation === this.generation;
  }

  private schedule(generation: number, delay: number): void {
    if (!this.active(generation)) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.sync(generation);
    }, delay);
  }

  private async sync(generation: number): Promise<void> {
    if (!this.active(generation)) return;
    try {
      const status = await this.api.sync(this.classId);
      if (!this.active(generation)) return;
      const imported = status.imported ?? 0;
      this.set({ status, error: "", newActivity: this.state.newActivity || imported > 0 });
      this.schedule(generation, status.hasMore || status.busy ? SYNC_CONTINUE_MS : SYNC_INTERVAL_MS);
    } catch (e) {
      if (!this.active(generation)) return;
      this.set({ error: e instanceof Error ? e.message : String(e) });
      this.schedule(generation, SYNC_INTERVAL_MS);
    }
  }

  /** "New activity · Refresh": clear the notice and let pages reload once. */
  acknowledge = (): void => {
    this.set({ newActivity: false, revision: this.state.revision + 1 });
  };

  /** Sync now (the "Refresh Kiwi activity" button). */
  refresh = (): void => {
    this.stop();
    this.start();
  };
}
