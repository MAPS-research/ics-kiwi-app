import { useState } from "react";
import { ArrowLeft } from "lucide-react";
import type { KiwiClient } from "./types";

export function KiwiReturn({ kiwi, teacher = false }: { kiwi: KiwiClient | null; teacher?: boolean }) {
  const [error, setError] = useState("");
  const host = (import.meta.env.VITE_KIWI_ORIGIN || "http://localhost:3001").replace(/\/$/, "");
  const back = async () => {
    setError("");
    try {
      if (kiwi?.mode === "live") {
        const result = await kiwi.navigate({ path: teacher ? "/admin/classes" : "/" });
        if (!result.ok) throw new Error(result.error?.message || "Kiwi could not open the course home. Please use the host navigation.");
      } else location.assign(host);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  return <div className="kiwi-return"><button className="text-button" onClick={() => void back()}><ArrowLeft size={16} />{kiwi?.mode === "live" ? "Back to Kiwi" : "Open Kiwi"}</button>{error && <span role="alert" className="error-text">{error}</span>}</div>;
}
