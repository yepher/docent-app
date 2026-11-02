import { useEffect, useState } from "react";
import type { Citation } from "../../shared/types";
import {
  visualKey,
  type VisualSelection,
  type VisualSource,
} from "../../shared/vision";

export function visualCitation(selection: VisualSelection): Citation {
  const s = selection.source;
  return {
    n: 0,
    documentId: "documentId" in s ? s.documentId : 0,
    title: selection.title,
    path: "",
    setName: "Attached visual source",
    page: "documentId" in s ? (s.page ?? null) : null,
    line: null,
    version: "documentId" in s ? s.version : s.attachmentId,
    excerpt: "Visual source attached to this question.",
    visual: s,
    cited: false,
  };
}

export function VisualImage({
  source,
  title,
}: {
  source: VisualSource;
  title: string;
}) {
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState(false);
  const key = visualKey([source]);
  useEffect(() => {
    let disposed = false;
    setUrl("");
    setError("");
    void window.api.vision.preview(source).then(
      (url) => {
        if (!disposed) setUrl(url);
      },
      (e) => {
        if (!disposed) setError(String(e));
      },
    );
    return () => {
      disposed = true;
    };
  }, [key]);
  return (
    <div className={`visual-image${expanded ? " expanded" : ""}`}>
      {error ? (
        <p role="alert" className="warning">
          {error}
        </p>
      ) : url ? (
        <>
          <button onClick={() => setExpanded(!expanded)}>
            {expanded ? "Fit image" : "View full size"}
          </button>
          <div className="visual-image-frame">
            <img src={url} alt={title} />
          </div>
        </>
      ) : (
        <p role="status">Opening image…</p>
      )}
    </div>
  );
}
