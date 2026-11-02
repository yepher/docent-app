import { useEffect, useState } from "react";
import type { RerankerState } from "../../shared/types";

export function SearchQuality({ ready }: { ready: boolean }) {
  const [state, setState] = useState<RerankerState | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let changed = false,
      disposed = false;
    const unsubscribe = window.api.reranker.onState((s) => {
      changed = true;
      setState(s);
    });
    void window.api.reranker.state().then((s) => {
      if (!disposed && !changed) setState(s);
    });
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, []);
  const run = async (work: Promise<void>) => {
    setError("");
    try {
      await work;
    } catch (e) {
      setError(String(e));
    }
  };
  return (
    <details className="search-quality">
      <summary>
        Search quality · {state?.phase === "ready" ? "Enhanced" : "Standard"}
      </summary>
      <p className="fine">
        Enhanced retrieval checks which passages best answer your question
        before writing the answer. It runs entirely on this computer.
      </p>
      {!ready ? (
        <p className="fine">Start the local models to change search quality.</p>
      ) : (
        <>
          {state?.phase === "not-installed" && (
            <>
              <p className="fine">
                Standard search is available now. Download the relevance model
                once to improve document answers.
              </p>
              <button onClick={() => void run(window.api.reranker.install())}>
                Download relevance model (
                {Math.round(state.downloadBytes / 1e6)} MB)
              </button>
            </>
          )}
          {state?.phase === "downloading" && (
            <div role="status">
              <p>Downloading relevance model…</p>
              <progress value={state.loaded} max={state.total} />
              <small>
                {Math.round(state.loaded / 1e6)} of{" "}
                {Math.round(state.total / 1e6)} MB · Standard search remains
                available
              </small>
            </div>
          )}
          {state && ["ready", "starting", "disabled"].includes(state.phase) && (
            <label>
              <input
                type="checkbox"
                checked={state.phase !== "disabled"}
                onChange={(e) =>
                  void run(window.api.reranker.enable(e.target.checked))
                }
              />{" "}
              Use enhanced retrieval
            </label>
          )}
          {state?.phase === "starting" && (
            <p className="fine" role="status">
              Loading relevance model. Standard search is available.
            </p>
          )}
          {state?.phase === "disabled" && (
            <p className="fine">
              Standard search uses less memory and skips the extra relevance
              check.
            </p>
          )}
          {state?.phase === "failed" && (
            <>
              <p className="fine">
                Using standard search. The relevance model is unavailable.
              </p>
              <details>
                <summary>Details</summary>
                <p className="fine">{state.message}</p>
              </details>
              <button onClick={() => void run(window.api.reranker.install())}>
                Retry enhanced retrieval
              </button>
              <button
                onClick={() => void run(window.api.reranker.enable(false))}
              >
                Use standard search
              </button>
            </>
          )}
        </>
      )}
      {error && (
        <p role="alert" className="warning">
          {error}
        </p>
      )}
    </details>
  );
}
