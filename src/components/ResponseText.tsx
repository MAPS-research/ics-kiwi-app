/**
 * Renders AI replies with fenced code, inline code, bold and headings (moved from v0.5.1 LearningTools.tsx). Also used
 * for AI-generated question prompts and explanations (RV6-M05), so fenced R code is a code block, not literal ```.
 */
export function ResponseText({ text, className }: { text: string; className?: string }) {
  const inline = (value: string) =>
    value.split(/(`[^`]+`|\*\*[^*]+\*\*)/g).map((s, i) =>
      s.startsWith("`") ? <code key={i}>{s.slice(1, -1)}</code> : s.startsWith("**") ? <strong key={i}>{s.slice(2, -2)}</strong> : s,
    );
  return (
    <div className={className ? `response-text ${className}` : "response-text"}>
      {text.split(/(```[\s\S]*?```)/g).map((block, i) =>
        block.startsWith("```") ? (
          <pre key={i}>
            <code>{block.replace(/^```[^\n]*\n?/, "").replace(/```$/, "")}</code>
          </pre>
        ) : (
          <div key={i}>
            {block
              .split("\n")
              .filter(Boolean)
              .map((line, j) => (/^#{1,6} /.test(line) ? <h3 key={j}>{inline(line.replace(/^#{1,6} /, ""))}</h3> : <p key={j}>{inline(line)}</p>))}
          </div>
        ),
      )}
    </div>
  );
}
