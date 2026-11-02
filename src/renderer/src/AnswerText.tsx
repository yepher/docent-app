import { Fragment, type ReactNode } from "react";
import type { Citation } from "../../shared/types";
import { codeBlocks, inlineCode } from "../../shared/code-text";
import { CopyButton } from "./CopyButton";

/** Render only supported formatting as React elements; source/model HTML always stays text. */
export function AnswerText({
  message,
  onCite,
}: {
  message: { text: string; citations?: Citation[] };
  onCite: (citation: Citation) => void;
}) {
  const inline = (text: string, offset: number, bold = true): ReactNode[] => {
    const codes = inlineCode(text).filter((part) => part.kind === "code");
    const masked = inlineCode(text)
      .map((part) =>
        part.kind === "code" ? " ".repeat(part.raw.length) : part.raw,
      )
      .join("");
    const pattern = bold
      ? /\*\*[^*]+\*\*|\[(\d+(?:\s*,\s*\d+)*)\]/g
      : /\[(\d+(?:\s*,\s*\d+)*)\]/g;
    const tokens = [
      ...codes.map((part) => ({
        start: part.start,
        raw: part.raw,
        node: (
          <code className="inline-code" key={`code-${offset + part.start}`}>
            {part.text}
          </code>
        ),
      })),
      ...[...masked.matchAll(pattern)].map((match) => {
        const start = match.index;
        const raw = text.slice(start, start + match[0].length);
        return {
          start,
          raw,
          node: match[1] ? (
            <span key={`citations-${offset + start}`}>
              {match[1]
                .split(",")
                .map(Number)
                .map((n, i) => {
                  const citation = message.citations?.find((c) => c.n === n);
                  return citation ? (
                    <button
                      key={`${n}-${i}`}
                      className="cite"
                      title={citation.title}
                      onClick={() => onCite(citation)}
                    >
                      {n}
                    </button>
                  ) : (
                    <sup key={`${n}-${i}`}>{n}</sup>
                  );
                })}
            </span>
          ) : (
            <strong key={`bold-${offset + start}`}>
              {inline(raw.slice(2, -2), offset + start + 2, false)}
            </strong>
          ),
        };
      }),
    ].sort((a, b) => a.start - b.start);
    const nodes: ReactNode[] = [];
    let from = 0;
    for (const token of tokens) {
      if (token.start < from) continue; // An enclosing bold span renders its own inline children.
      nodes.push(text.slice(from, token.start), token.node);
      from = token.start + token.raw.length;
    }
    nodes.push(text.slice(from));
    return nodes;
  };

  return (
    <div className="text">
      {codeBlocks(message.text).map((part) =>
        part.kind === "code" ? (
          <section
            className="answer-code"
            key={`block-${part.start}`}
            aria-label={part.language ? `${part.language} code` : "Code block"}
          >
            <div className="answer-code-header">
              <span>{part.language || "Code"}</span>
              {part.text && <CopyButton text={part.text} label="Copy code" />}
            </div>
            <pre tabIndex={0} aria-label="Code snippet">
              <code>{part.text}</code>
            </pre>
          </section>
        ) : (
          <Fragment key={`prose-${part.start}`}>
            {inline(part.text, part.start)}
          </Fragment>
        ),
      )}
    </div>
  );
}
