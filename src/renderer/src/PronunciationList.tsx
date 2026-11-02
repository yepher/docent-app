import { useEffect, useRef, useState } from "react";
import type { Pronunciation } from "../../shared/types";
import { Player } from "./audio";

export function PronunciationList({
  entries,
  onChanged,
}: {
  entries: Pronunciation[];
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [spoken, setSpoken] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<{ word: string; text: string } | null>(
    null,
  );
  const player = useRef(new Player());
  const previewId = useRef(0);
  useEffect(
    () => () => {
      previewId.current++;
      player.current.stop();
    },
    [],
  );

  const attempt = async (word: string, action: () => Promise<void>) => {
    setBusy(word);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError({ word, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
    }
  };
  const test = (p: Pronunciation) =>
    attempt(p.word, async () => {
      const id = ++previewId.current;
      player.current.stop();
      const audio = await window.api.pronunciations.preview(
        editing === p.word ? spoken.trim() : p.spoken,
      );
      if (id === previewId.current)
        player.current.enqueue(audio.samples, audio.sampleRate);
    });
  const cancel = () => {
    previewId.current++;
    player.current.stop();
    setEditing(null);
    setError(null);
  };

  return (
    <details className="pronunciations">
      <summary>Pronunciations ({entries.length})</summary>
      <ul>
        {entries.map((p) => (
          <li key={p.word}>
            <div className="pronunciation-row">
              <strong
                className="pronunciation-word"
                title={`${p.word} sounds like ${p.spoken}`}
              >
                {p.word}
              </strong>
              <button
                type="button"
                className="pronunciation-icon"
                title="Listen"
                aria-label={`Listen to pronunciation for ${p.word}`}
                disabled={
                  Boolean(busy) || (editing === p.word && !spoken.trim())
                }
                onClick={() => void test(p)}
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="currentColor"
                  aria-hidden="true"
                >
                  <path d="M8 5.5a1 1 0 0 1 1.5-.86l10 6.5a1 1 0 0 1 0 1.72l-10 6.5A1 1 0 0 1 8 18.5z" />
                </svg>
              </button>
              <button
                type="button"
                className="pronunciation-icon"
                title="Edit"
                aria-label={`Edit pronunciation for ${p.word}`}
                aria-expanded={editing === p.word}
                disabled={Boolean(busy)}
                onClick={() => {
                  const close = editing === p.word;
                  cancel();
                  if (!close) {
                    setEditing(p.word);
                    setSpoken(p.spoken);
                  }
                }}
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="m15 5 4 4M4 20l4.5-1 11-11a2.8 2.8 0 0 0-4-4l-11 11z" />
                </svg>
              </button>
            </div>
            {editing === p.word && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void attempt(p.word, async () => {
                    await window.api.pronunciations.set(p.word, spoken.trim());
                    cancel();
                    onChanged();
                  });
                }}
              >
                <label>
                  Sounds like
                  <input
                    autoFocus
                    aria-label={`Pronunciation for ${p.word}`}
                    value={spoken}
                    maxLength={200}
                    onChange={(e) => setSpoken(e.target.value)}
                    disabled={Boolean(busy)}
                  />
                </label>
                <div className="actions">
                  <button
                    className="primary"
                    disabled={Boolean(busy) || !spoken.trim()}
                  >
                    Save
                  </button>
                  <button
                    type="button"
                    disabled={Boolean(busy)}
                    onClick={cancel}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="danger"
                    aria-label={`Remove pronunciation for ${p.word}`}
                    disabled={Boolean(busy)}
                    onClick={() =>
                      void attempt(p.word, async () => {
                        await window.api.pronunciations.remove(p.word);
                        cancel();
                        onChanged();
                      })
                    }
                  >
                    Remove
                  </button>
                </div>
              </form>
            )}
            {busy === p.word && <small role="status">Working…</small>}
            {error?.word === p.word && (
              <p role="alert" className="warning">
                {error.text}
              </p>
            )}
          </li>
        ))}
      </ul>
    </details>
  );
}
