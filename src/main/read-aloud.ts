import { SentenceSplitter } from "./citations";
import type { Llm, SpeechChunk } from "./llm";

/** Read an existing answer without asking the model to generate another answer. */
export async function readAloud(
  llm: Pick<Llm, "speak">,
  text: string,
  signal: AbortSignal,
  pronounce: (text: string) => string,
  audio: (chunk: SpeechChunk) => void,
) {
  if (typeof text !== "string" || !text.trim() || text.length > 200000)
    throw new Error("Choose a nonempty answer of at most 200,000 characters.");
  const splitter = new SentenceSplitter();
  const parts = [...splitter.push(text), ...splitter.flush()];
  for (const part of parts) {
    // Bound long sentences too, so a long answer does not become one huge TTS request.
    let rest = pronounce(part.spoken).trim();
    while (rest) {
      signal.throwIfAborted();
      const space = rest.lastIndexOf(" ", 600);
      const end = rest.length <= 600 ? rest.length : space > 0 ? space : 600;
      const sentence = rest.slice(0, end);
      rest = rest.slice(end).trim();
      for await (const chunk of llm.speak(sentence, signal)) {
        signal.throwIfAborted();
        audio(chunk);
      }
    }
  }
}
