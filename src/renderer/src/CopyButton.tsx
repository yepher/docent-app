import { useEffect, useState } from "react";

export function CopyButton({
  text,
  label = "Copy",
}: {
  text: string;
  label?: string;
}) {
  const [status, setStatus] = useState<
    "idle" | "copying" | "copied" | "failed"
  >("idle");
  useEffect(() => {
    if (status !== "copied") return;
    const timer = setTimeout(() => setStatus("idle"), 2000);
    return () => clearTimeout(timer);
  }, [status]);
  useEffect(() => setStatus("idle"), [text]);

  const copy = async () => {
    setStatus("copying");
    try {
      await window.api.clipboard.writeText(text);
      setStatus("copied");
    } catch {
      setStatus("failed");
    }
  };
  return (
    <>
      <button
        type="button"
        disabled={status === "copying"}
        onClick={() => void copy()}
      >
        <span aria-live="polite">
          {status === "copied"
            ? "Copied!"
            : status === "copying"
              ? "Copying…"
              : label}
        </span>
      </button>
      {status === "failed" && (
        <small className="warning" role="alert">
          Could not copy to the clipboard. Try again.
        </small>
      )}
    </>
  );
}
