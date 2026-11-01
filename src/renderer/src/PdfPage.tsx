import type { PDFDocumentProxy, RenderTask, TextLayer } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { useEffect, useRef, useState } from "react";
import type { Citation } from "../../shared/types";

/** The data pdf.js loads on demand. electron.vite.config.ts copies it here. */
const asset = (dir: string) => new URL(`pdfjs/${dir}/`, document.baseURI).href;

/** Shows the cited page as it looks in the PDF. Reports failure so the caller can show the passage instead. */
export function PdfPage({
  citation,
  onFailed,
}: {
  citation: Citation;
  onFailed: () => void;
}) {
  const { documentId } = citation;
  const canvas = useRef<HTMLCanvasElement>(null);
  const textLayer = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const failed = useRef(onFailed);
  failed.current = onFailed;
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [page, setPage] = useState(citation.page ?? 1);
  const [zoom, setZoom] = useState(1);
  const [width, setWidth] = useState(0);

  useEffect(() => setPage(citation.page ?? 1), [citation]);

  useEffect(() => {
    const target = frame.current;
    if (!target) return;
    const observer = new ResizeObserver(([entry]) =>
      setWidth(Math.round(entry?.contentRect.width ?? 0)),
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let closed = false;
    let destroy = () => {};
    setPdf(null);
    void (async () => {
      try {
        const [pdfjs, bytes] = await Promise.all([
          import("pdfjs-dist"),
          window.api.docs.pdf(documentId, citation.version),
        ]);
        if (closed) return;
        pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
        const task = pdfjs.getDocument({
          data: new Uint8Array(bytes),
          cMapUrl: asset("cmaps"),
          standardFontDataUrl: asset("standard_fonts"),
          wasmUrl: asset("wasm"),
          iccUrl: asset("iccs"),
        });
        destroy = () => void task.destroy();
        const loaded = await task.promise;
        if (!closed) setPdf(loaded);
      } catch (err) {
        if (closed) return;
        console.error("Could not open PDF", err);
        failed.current();
      }
    })();
    return () => {
      closed = true;
      destroy();
    };
  }, [documentId, citation.version]);

  const shown = pdf ? Math.min(page, pdf.numPages) : page;

  useEffect(() => {
    const target = canvas.current;
    if (!pdf || !target || width === 0) return;
    let cancelled = false;
    let task: RenderTask | null = null;
    let layer: TextLayer | null = null;
    void (async () => {
      try {
        const current = await pdf.getPage(shown);
        if (cancelled) return;
        const scale =
          ((width * zoom) / current.getViewport({ scale: 1 }).width) *
          window.devicePixelRatio;
        const viewport = current.getViewport({ scale });
        target.width = Math.floor(viewport.width);
        target.height = Math.floor(viewport.height);
        task = current.render({ canvas: target, viewport });
        await task.promise;
        if (!cancelled && textLayer.current) {
          const { TextLayer } = await import("pdfjs-dist");
          textLayer.current.replaceChildren();
          const cssViewport = current.getViewport({
            scale: (width * zoom) / current.getViewport({ scale: 1 }).width,
          });
          textLayer.current.style.setProperty(
            "--total-scale-factor",
            String(cssViewport.scale),
          );
          layer = new TextLayer({
            textContentSource: await current.getTextContent(),
            container: textLayer.current,
            viewport: cssViewport,
          });
          await layer.render();
        }
      } catch (err) {
        if (cancelled) return;
        console.error("Could not draw PDF page", err);
        failed.current();
      }
    })();
    return () => {
      cancelled = true;
      task?.cancel();
      layer?.cancel();
    };
  }, [pdf, shown, width, zoom]);

  return (
    <div className="pdf-page">
      <div className="pdf-nav">
        <button
          aria-label="Zoom out"
          onClick={() => setZoom((z) => Math.max(0.5, z - 0.25))}
        >
          −
        </button>
        <span>{Math.round(zoom * 100)}%</span>
        <button
          aria-label="Zoom in"
          onClick={() => setZoom((z) => Math.min(3, z + 0.25))}
        >
          +
        </button>
        <button
          aria-label="Previous page"
          disabled={shown <= 1}
          onClick={() => setPage(shown - 1)}
        >
          ‹
        </button>
        <span className="fine">
          {pdf ? `Page ${shown} of ${pdf.numPages}` : "Opening…"}
        </span>
        <button
          aria-label="Next page"
          disabled={!pdf || shown >= pdf.numPages}
          onClick={() => setPage(shown + 1)}
        >
          ›
        </button>
      </div>
      <div className="pdf-frame" ref={frame}>
        <div style={{ position: "relative", width: `${zoom * 100}%` }}>
          <div className="pdf-text-layer" ref={textLayer} />
          <canvas
            ref={canvas}
            role="img"
            aria-label={`Page ${shown} of ${citation.title}`}
          />
        </div>
      </div>
    </div>
  );
}
