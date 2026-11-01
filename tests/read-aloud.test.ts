import { describe, expect, it } from "vitest";
import { readAloud } from "../src/main/read-aloud";
import { applyPronunciations } from "../src/main/pronunciation";

describe("read an existing answer aloud", () => {
  it("streams cleaned sentences with current pronunciations, without generating an answer", async () => {
    const spoken: string[] = [],
      audio: ArrayBuffer[] = [];
    await readAloud(
      {
        async *speak(text) {
          spoken.push(text);
          yield { samples: new ArrayBuffer(4), sampleRate: 24000 };
        },
      },
      "**Shapr3D** uses sketches [1, 2]. Another sentence.\nSources\n[1] Manual.pdf",
      new AbortController().signal,
      (t) => applyPronunciations(t, [{ word: "Shapr3D", spoken: "Shaper 3D" }]),
      (chunk) => audio.push(chunk.samples),
    );
    expect(spoken).toEqual(["Shaper 3D uses sketches.", "Another sentence."]);
    expect(audio).toHaveLength(2);
  });

  it("keeps long answers intact while bounding individual voice requests", async () => {
    const text = "Long words without punctuation ".repeat(100).trim();
    const spoken: string[] = [];
    await readAloud(
      {
        async *speak(t) {
          spoken.push(t);
        },
      },
      text,
      new AbortController().signal,
      (t) => t,
      () => {},
    );
    expect(spoken.length).toBeGreaterThan(1);
    expect(spoken.every((t) => t.length <= 600)).toBe(true);
    expect(spoken.join(" ")).toBe(text);
  });

  it("stops generation and drops late audio when cancelled", async () => {
    const controller = new AbortController();
    const spoken: string[] = [],
      audio: ArrayBuffer[] = [];
    await expect(
      readAloud(
        {
          async *speak(text, signal) {
            spoken.push(text);
            expect(signal).toBe(controller.signal);
            yield { samples: new ArrayBuffer(4), sampleRate: 24000 };
            controller.abort();
            yield { samples: new ArrayBuffer(4), sampleRate: 24000 };
          },
        },
        "First sentence. Second sentence.",
        controller.signal,
        (t) => t,
        (chunk) => audio.push(chunk.samples),
      ),
    ).rejects.toThrow();
    expect(spoken).toEqual(["First sentence."]);
    expect(audio).toHaveLength(1);
  });
});
