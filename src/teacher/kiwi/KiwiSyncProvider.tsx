import { useEffect, useMemo, useSyncExternalStore, type JSX, type ReactNode } from "react";
import { api, hasKiwiIdentity } from "../../lib/api";
import { useTeacher } from "../shell/TeacherContext";
import { KiwiSyncContext, KiwiSyncLoop, type KiwiSyncApi, type KiwiSyncContextValue } from "./useKiwiSync";

/*
 * One Kiwi sync loop per teacher session (TELEMETRY; §7.9 / §15.2). TeacherShell mounts this provider once around every
 * page (Home included), so native activity keeps importing on any teacher page and pages never start their own loops.
 */
const DEFAULT_API: KiwiSyncApi = { status: (classId) => api.kiwiStatus(classId), sync: (classId) => api.syncKiwi(classId) };

export function KiwiSyncProvider({ children }: { children: ReactNode }): JSX.Element {
  const { classId } = useTeacher();
  const loop = useMemo(() => new KiwiSyncLoop(classId, DEFAULT_API, hasKiwiIdentity), [classId]);
  const state = useSyncExternalStore(loop.subscribe, loop.getState, loop.getState);
  useEffect(() => {
    loop.start();
    return () => loop.stop();
  }, [loop]);
  const value = useMemo<KiwiSyncContextValue>(
    () => ({ ...state, acknowledge: loop.acknowledge, refresh: loop.refresh }),
    [state, loop],
  );
  return <KiwiSyncContext.Provider value={value}>{children}</KiwiSyncContext.Provider>;
}
