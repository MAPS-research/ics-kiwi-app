import { ArrowLeft, ArrowRight } from "lucide-react";

/** "1–20 of 45" or "0 results". */
export function pageRangeLabel(page: number, total: number, size: number): string {
  if (!total) return "0 results";
  const first = (page - 1) * size + 1;
  return `${first}–${Math.min(page * size, total)} of ${total}`;
}

/** Previous/next pager (moved from v0.5.1 TeacherWork.tsx). */
export function Pager({ page, total, size, onPage }: { page: number; total: number; size: number; onPage: (page: number) => void }) {
  return (
    <div className="pagination">
      <span>{pageRangeLabel(page, total, size)}</span>
      <button className="outline-button" disabled={page <= 1} onClick={() => onPage(page - 1)}>
        <ArrowLeft size={15} />
        Previous
      </button>
      <button className="outline-button" disabled={page * size >= total} onClick={() => onPage(page + 1)}>
        Next
        <ArrowRight size={15} />
      </button>
    </div>
  );
}
