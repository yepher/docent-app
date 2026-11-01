import { useEffect, useRef, useState } from "react";
import type { DocSet } from "../../shared/types";
import type { PendingImport } from "../../shared/imports";

export function DropImport({
  sets,
  ready,
  onImported,
}: {
  sets: DocSet[];
  ready: boolean;
  onImported: () => void;
}) {
  const [pending, setPending] = useState<PendingImport[]>([]);
  const [dragging, setDragging] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    let changed = false,
      disposed = false;
    const unsubscribe = window.api.imports.onPending((requests) => {
      changed = true;
      setPending(requests);
    });
    void window.api.imports
      .pending()
      .then((requests) => {
        if (!disposed && !changed) setPending(requests);
      })
      .catch((e) => {
        if (!disposed) setError(String(e));
      });
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, []);
  useEffect(() => {
    let depth = 0;
    const hasFiles = (event: DragEvent) =>
      Array.from(event.dataTransfer?.types ?? []).includes("Files");
    const enter = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      depth++;
      setDragging(true);
    };
    const over = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      event.dataTransfer!.dropEffect = "copy";
    };
    const leave = () => {
      depth = Math.max(0, depth - 1);
      if (!depth) setDragging(false);
    };
    const reset = () => {
      depth = 0;
      setDragging(false);
    };
    const drop = (event: DragEvent) => {
      reset();
      if (!hasFiles(event)) return;
      event.preventDefault();
      setError("");
      setNotice("");
      try {
        void window.api.imports
          .drop(Array.from(event.dataTransfer!.files))
          .catch((e) => setError(e instanceof Error ? e.message : String(e)));
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragover", over);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", drop);
    window.addEventListener("dragend", reset);
    window.addEventListener("blur", reset);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragover", over);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", drop);
      window.removeEventListener("dragend", reset);
      window.removeEventListener("blur", reset);
    };
  }, []);
  const request = pending[0];
  return (
    <>
      {dragging && (
        <div className="drop-overlay">
          <div>
            <strong>Drop to add to Docent</strong>
            <span>Choose a document set next, or create a new one.</span>
          </div>
        </div>
      )}
      {(notice || error) && (
        <div className="import-notice" role={error ? "alert" : "status"}>
          <span>{error || notice}</span>
          <button
            aria-label="Dismiss import message"
            onClick={() => {
              setNotice("");
              setError("");
            }}
          >
            ×
          </button>
        </div>
      )}
      {request && !ready && (
        <div className="import-notice" role="status">
          <span>
            {pending.length} {pending.length === 1 ? "drop is" : "drops are"}{" "}
            waiting. Start the local models to choose an import destination.
          </span>
          <button
            onClick={() =>
              void window.api.imports
                .dismiss(request.id)
                .catch((e) => setError(String(e)))
            }
          >
            Cancel import
          </button>
        </div>
      )}
      {request && ready && (
        <ImportChooser
          key={request.id}
          request={request}
          sets={sets}
          ready={ready}
          remaining={pending.length - 1}
          onImported={(name) => {
            onImported();
            setNotice(
              `Added to ${name}. Indexing will start when the current library work finishes.`,
            );
          }}
        />
      )}
    </>
  );
}

function ImportChooser({
  request,
  sets,
  ready,
  remaining,
  onImported,
}: {
  request: PendingImport;
  sets: DocSet[];
  ready: boolean;
  remaining: number;
  onImported: (name: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const selected = sets.filter((s) => s.selected);
  const [destination, setDestination] = useState(
    selected.length === 1 ? String(selected[0]!.id) : "new",
  );
  const first = request.items[0]!;
  const [name, setName] = useState(
    (request.items.length === 1
      ? first.kind === "folder"
        ? first.name
        : first.name.replace(/\.[^.]+$/, "")
      : "Imported documents"
    ).slice(0, 100),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const target = dialog.current!;
    target.showModal();
    return () => target.close();
  }, []);
  const cancel = async () => {
    if (busy) return;
    try {
      await window.api.imports.dismiss(request.id);
    } catch (e) {
      setError(String(e));
    }
  };
  const submit = async () => {
    setBusy(true);
    setError("");
    try {
      const set = await window.api.imports.confirm(
        request.id,
        destination === "new"
          ? { newSetName: name }
          : { setId: Number(destination) },
      );
      onImported(set.name);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };
  return (
    <dialog
      className="import-dialog"
      ref={dialog}
      aria-labelledby="import-title"
      onCancel={(e) => {
        e.preventDefault();
        void cancel();
      }}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <h2 id="import-title">Add to Docent</h2>
        <p>
          Choose where to import{" "}
          {request.items.length === 1
            ? "this item"
            : `these ${request.items.length} items`}
          .
        </p>
        <ul className="import-items">
          {request.items.map((item) => (
            <li key={item.path}>
              <strong>{item.name}</strong>
              <small>
                {item.kind === "folder"
                  ? "Folder · includes supported documents in subfolders"
                  : "Document"}
              </small>
              <small title={item.path}>{item.path}</small>
            </li>
          ))}
        </ul>
        <label>
          Document set
          <select
            autoFocus
            aria-label="Import destination"
            value={destination}
            disabled={busy}
            onChange={(e) => setDestination(e.target.value)}
          >
            <option value="new">Create a new document set</option>
            {sets.map((set) => (
              <option key={set.id} value={set.id}>
                {set.name}
              </option>
            ))}
          </select>
        </label>
        {destination === "new" && (
          <label>
            New set name
            <input
              aria-label="Import set name"
              value={name}
              maxLength={100}
              disabled={busy}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
        )}
        <p className="fine">
          Original files stay where they are. Docent stores an offline copy of
          each imported document.
        </p>
        {!ready && (
          <p role="status">
            Start the local models to import. Your dropped items are waiting
            here.
          </p>
        )}
        {remaining > 0 && (
          <p className="fine">
            {remaining} more {remaining === 1 ? "drop is" : "drops are"} waiting
            after this one.
          </p>
        )}
        {error && (
          <p className="warning" role="alert">
            {error}
          </p>
        )}
        <div className="actions">
          <button type="button" disabled={busy} onClick={() => void cancel()}>
            Cancel
          </button>
          <button
            className="primary"
            disabled={
              busy ||
              !ready ||
              (destination === "new"
                ? !name.trim()
                : !sets.some((s) => s.id === Number(destination)))
            }
          >
            {busy ? "Adding…" : "Import"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
