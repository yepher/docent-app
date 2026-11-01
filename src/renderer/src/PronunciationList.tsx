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
            <span>
              <strong>{p.word}</strong> <small>sounds like {p.spoken}</small>
            </span>
            {editing === p.word ? (
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
                    type="button"
                    aria-label={`Test pronunciation for ${p.word}`}
                    disabled={Boolean(busy) || !spoken.trim()}
                    onClick={() => void test(p)}
                  >
                    Test
                  </button>
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
                </div>
              </form>
            ) : (
              <div className="actions">
                <button
                  aria-label={`Edit pronunciation for ${p.word}`}
                  disabled={Boolean(busy)}
                  onClick={() => {
                    cancel();
                    setEditing(p.word);
                    setSpoken(p.spoken);
                  }}
                >
                  Edit
                </button>
                <button
                  aria-label={`Test pronunciation for ${p.word}`}
                  disabled={Boolean(busy)}
                  onClick={() => void test(p)}
                >
                  Test
                </button>
                <button
                  aria-label={`Remove pronunciation for ${p.word}`}
                  disabled={Boolean(busy)}
                  onClick={() =>
                    void attempt(p.word, async () => {
                      await window.api.pronunciations.remove(p.word);
                      player.current.stop();
                      onChanged();
                    })
                  }
                >
                  ×
                </button>
              </div>
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
