import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import type { Citation } from "../../shared/types";
import {
  citationExtraction,
  extractionLabel,
  isImagePath,
  type VisualSource,
} from "../../shared/vision";
import {
  textMatches,
  documentTextBlocks,
  type TextMatch,
} from "../../shared/text-search";
import { PdfPage } from "./PdfPage";
import { VisualImage } from "./VisualImage";

const where = (c: Citation) =>
  c.page !== null
    ? `page ${c.page}`
    : c.line !== null
      ? `line ${c.line}`
      : c.setName;

export function SourceDetail({
  citation,
  revealLabel,
  onClose,
  onAsk,
}: {
  citation: Citation;
  revealLabel: string;
  onClose: () => void;
  onAsk?: (source: VisualSource, title: string) => void;
}) {
  const [pageFailed, setPageFailed] = useState(false);
  const [passages, setPassages] = useState<Citation[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [scope, setScope] = useState("passage");
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [navigation, setNavigation] = useState(0);
  const panel = useRef<HTMLElement>(null);
  const toolbar = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const evidence = useRef<HTMLDetailsElement>(null);
  const imageSource: VisualSource | null =
    citation.page === null && (citation.visual || isImagePath(citation.path))
      ? (citation.visual ?? {
          documentId: citation.documentId,
          version: citation.version,
        })
      : null;
  const showPage = citation.page !== null && !pageFailed;
  const extraction = useMemo(() => citationExtraction(citation), [citation]);

  useEffect(() => {
    // Reset find when opening another citation, while preserving the loaded PDF/image.
    setQuery("");
    setActive(0);
    setScope("passage");
    setPageFailed(false);
    if (panel.current) panel.current.scrollTop = 0;
  }, [citation]);

  useEffect(() => {
    if (scope !== "document" || passages !== null || loadError) return;
    let closed = false;
    void window.api.docs.passages(citation.documentId).then(
      (value) => {
        if (!closed) setPassages(documentTextBlocks(value));
      },
      () => {
        if (!closed) setLoadError(true);
      },
    );
    return () => {
      closed = true;
    };
  }, [scope, passages, loadError, citation.documentId]);

  const blocks = useMemo(
    () =>
      scope === "document"
        ? (passages ?? [])
        : [{ ...citation, excerpt: extraction?.text ?? citation.excerpt }],
    [scope, passages, citation, extraction],
  );
  const found = useMemo(() => {
    let count = 0;
    const blocksWithMatches = blocks.map((block) => {
      const matches = textMatches(block.excerpt, query);
      const start = count;
      count += matches.length;
      return { block, matches, start };
    });
    return { blocks: blocksWithMatches, count };
  }, [blocks, query]);
  const current = found.count ? Math.min(active, found.count - 1) : 0;
  const move = (direction: number) => {
    if (found.count) {
      setActive((current + direction + found.count) % found.count);
      // Reopen/reveal even when there is only one match or navigation wraps to it.
      setNavigation((n) => n + 1);
    }
  };
  const changeQuery = (value: string) => {
    setQuery(value);
    setActive(0);
  };

  useEffect(() => {
    if (!found.count) return;
    if (evidence.current) evidence.current.open = true;
    const frame = requestAnimationFrame(() => {
      const target = panel.current?.querySelector<HTMLElement>(
        `[data-source-match="${current}"]`,
      );
      if (!target || !panel.current || !toolbar.current) return;
      const match = target.getBoundingClientRect();
      const bounds = panel.current.getBoundingClientRect();
      // Scroll only the citation panel, leaving the conversation and keyboard focus intact.
      const top =
        Math.max(bounds.top, toolbar.current.getBoundingClientRect().bottom) +
        12;
      const bottom = bounds.bottom - 12;
      if (match.top < top || match.bottom > bottom)
        panel.current.scrollTop += match.top - top;
    });
    return () => cancelAnimationFrame(frame);
  }, [found, current, navigation]);

  useEffect(() => {
    const focusFind = (event: KeyboardEvent) => {
      if (
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        event.key.toLowerCase() === "f" &&
        input.current
      ) {
        event.preventDefault();
        input.current.focus({ preventScroll: true });
        input.current.select();
      }
    };
    window.addEventListener("keydown", focusFind);
    return () => window.removeEventListener("keydown", focusFind);
  }, []);

  const loading = scope === "document" && passages === null && !loadError;
  const count = loading
    ? "Loading…"
    : query.trim()
      ? found.count
        ? `${current + 1} of ${found.count}`
        : "No matches"
      : "";
  const text = (index: number) => {
    const item = found.blocks[index];
    return (
      item && (
        <Highlighted
          text={item.block.excerpt}
          matches={item.matches}
          start={item.start}
          active={current}
        />
      )
    );
  };

  return (
    <aside
      ref={panel}
      className={`source-detail${showPage ? " pdf" : ""}`}
      aria-label="Citation"
    >
      <button className="close" aria-label="Close" onClick={onClose}>
        ×
      </button>
      <h3>{citation.title}</h3>
      <p className="fine">
        {citation.setName}, {imageSource ? "image" : where(citation)}
      </p>
      {!imageSource && (
        <div
          className="source-find"
          ref={toolbar}
          role="search"
          aria-label="Search citation"
        >
          <div className="source-find-input">
            <input
              ref={input}
              type="search"
              aria-label="Find in source"
              placeholder="Find a word or phrase…"
              value={query}
              onChange={(event) => changeQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing) return;
                if (event.key === "Enter") {
                  event.preventDefault();
                  move(event.shiftKey ? -1 : 1);
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                  changeQuery("");
                }
              }}
            />
            <button
              title="Clear search (Esc)"
              aria-label="Clear search"
              disabled={!query}
              onClick={() => {
                changeQuery("");
                input.current?.focus({ preventScroll: true });
              }}
            >
              ×
            </button>
          </div>
          <div className="source-find-controls">
            <select
              aria-label="Search within"
              value={scope}
              onChange={(event) => {
                setScope(event.target.value);
                setActive(0);
              }}
            >
              <option value="passage">Cited passage</option>
              {citation.documentId > 0 && (
                <option value="document">Document text</option>
              )}
            </select>
            <span
              className="source-find-count"
              role="status"
              aria-live="polite"
              aria-atomic="true"
            >
              {count}
            </span>
            <div className="source-find-navigation">
              <button
                title="Previous match (Shift+Enter)"
                aria-label="Previous match"
                disabled={!found.count}
                onClick={() => move(-1)}
              >
                ↑
              </button>
              <button
                title="Next match (Enter)"
                aria-label="Next match"
                disabled={!found.count}
                onClick={() => move(1)}
              >
                ↓
              </button>
            </div>
          </div>
        </div>
      )}
      {citation.indexedAt && (
        <p className="fine">
          Indexed {new Date(citation.indexedAt).toLocaleString()} · Version{" "}
          {citation.version?.slice(0, 10) ?? "legacy"}
        </p>
      )}
      {citation.warning && <p className="warning">{citation.warning}</p>}
      {citation.readingWarning && (
        <p className="evidence-warning">{citation.readingWarning}</p>
      )}
      {scope === "document" ? (
        <section
          className="source-document-text"
          aria-label="Indexed document text"
        >
          <h4>Indexed document text</h4>
          {loading && <p className="fine">Loading document text…</p>}
          {loadError && (
            <p role="alert">
              Document text could not be loaded.{" "}
              <button onClick={() => setLoadError(false)}>Try again</button>
            </p>
          )}
          {passages?.length === 0 && (
            <p className="fine">
              No indexed text is available. The saved cited passage is still
              available above under Cited passage.
            </p>
          )}
          {passages?.some(
            (p) => citation.version && p.version !== citation.version,
          ) && (
            <p className="fine">
              This is the current indexed document. The cited passage was saved
              from an earlier version.
            </p>
          )}
          {found.blocks.map(({ block }, i) => (
            <p className="indexed-passage" key={block.passageId ?? i}>
              <small>{where(block)}</small>
              {text(i)}
            </p>
          ))}
        </section>
      ) : (
        <>
          {imageSource && (
            <section className="original-image" aria-label="Original image">
              <h4>Original image</h4>
              {citation.n > 0 && (
                <p className="fine">
                  {citation.visual
                    ? "The model received this image as well as any extracted text shown below."
                    : "This answer used extracted text. The original image is shown here for comparison."}
                </p>
              )}
              {onAsk && (
                <button
                  className="ask-visual"
                  onClick={() => onAsk(imageSource, citation.title)}
                >
                  Ask about this image
                </button>
              )}
              <VisualImage source={imageSource} title={citation.title} />
            </section>
          )}
          <details open className="evidence" ref={evidence}>
            <summary>
              {extraction
                ? extractionLabel(extraction.kind)
                : citation.visual
                  ? "Visual evidence"
                  : "Passage used for this answer"}
            </summary>
            {extraction && (
              <p className="fine">
                {extraction.kind === "ocr"
                  ? "OCR is an automatic transcription and can misread handwriting, words, or digits. It may differ from the model’s visual reading. Compare it with the original image."
                  : "Text extracted from this page may contain errors or omissions. Compare it with the original page."}
              </p>
            )}
            <blockquote>{text(0)}</blockquote>
          </details>
          {showPage ? (
            <PdfPage
              citation={citation}
              onFailed={() => setPageFailed(true)}
              onAsk={
                onAsk
                  ? (page) =>
                      onAsk(
                        {
                          documentId: citation.documentId,
                          version: citation.version,
                          page,
                        },
                        citation.title,
                      )
                  : undefined
              }
            />
          ) : (
            pageFailed && (
              <p className="fine">
                The page could not be shown, so this is the text that was read
                from it.
              </p>
            )
          )}
        </>
      )}
      {citation.documentId > 0 && (
        <div className="actions">
          <button
            onClick={() => void window.api.docs.open(citation.documentId)}
          >
            Open file
          </button>
          <button
            onClick={() => void window.api.docs.reveal(citation.documentId)}
          >
            {revealLabel}
          </button>
        </div>
      )}
    </aside>
  );
}

function Highlighted({
  text,
  matches,
  start,
  active,
}: {
  text: string;
  matches: TextMatch[];
  start: number;
  active: number;
}) {
  const parts: ReactNode[] = [];
  let from = 0;
  matches.forEach((match, i) => {
    parts.push(
      text.slice(from, match.start),
      <mark
        key={match.start}
        data-source-match={start + i}
        className={start + i === active ? "source-match-active" : undefined}
      >
        {text.slice(match.start, match.end)}
      </mark>,
    );
    from = match.end;
  });
  parts.push(text.slice(from));
  return <>{parts}</>;
}
