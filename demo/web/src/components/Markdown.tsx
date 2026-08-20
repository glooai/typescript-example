import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Assistant output is markdown. Rendering it incrementally as it streams is
 * the same approach the `chatbot/` package takes; react-markdown tolerates
 * half-finished syntax between frames.
 */
export function Markdown({ children }: { children: string }) {
  return (
    <div className="md text-[0.9375rem] leading-relaxed text-ink-100">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{children}</ReactMarkdown>
    </div>
  );
}
