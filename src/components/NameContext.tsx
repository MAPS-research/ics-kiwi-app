import { createContext, useCallback, useContext, type ReactNode } from "react";
import type { NameMode } from "../types";

/*
 * Presentation mode on the client (§14.1). The server already relabels names (X-Name-Mode); this context keeps the
 * client from falling back to raw ids or emails while pseudonyms are shown.
 */
const NameModeContext = createContext<NameMode>("names");

export function NameModeProvider({ mode, children }: { mode: NameMode; children: ReactNode }) {
  return <NameModeContext.Provider value={mode}>{children}</NameModeContext.Provider>;
}
export function useNameMode(): NameMode {
  return useContext(NameModeContext);
}

export interface StudentLabelInput { studentId: string; studentName?: string | null; pseudonym?: string | null }

/** names: display name, else "Student " + the first 6 id characters; pseudonyms: pseudonym, never the id. */
export function studentLabel(row: StudentLabelInput, mode: NameMode): string {
  const name = row.studentName?.trim() ?? "";
  if (mode === "pseudonyms") return row.pseudonym?.trim() || name || "Student";
  return name || `Student ${row.studentId.slice(0, 6)}`;
}

export function useStudentLabel(): (row: StudentLabelInput) => string {
  const mode = useNameMode();
  return useCallback((row: StudentLabelInput) => studentLabel(row, mode), [mode]);
}
