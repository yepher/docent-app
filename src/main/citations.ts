const MARKER = /\[(\d+(?:\s*,\s*\d+)*)\]/g;

/**
 * Finds the sources an answer really cites. Models sometimes invent a number, so a marker
 * for a source that was never supplied is removed instead of being shown as a citation.
 */
export function resolveCitations(text: string, sourceCount: number): { text: string; cited: Set<number> } {
  const cited = new Set<number>();
  const cleaned = text.replace(MARKER, (_, list: string) => {
    const valid = list
      .split(',')
      .map((n) => Number(n.trim()))
      .filter((n) => n >= 1 && n <= sourceCount);
    valid.forEach((n) => cited.add(n));
    return valid.length > 0 ? `[${valid.join(', ')}]` : '';
  });
  return { text: cleaned.replace(/ +([.,;:!?])/g, '$1').replace(/ {2,}/g, ' ').trim(), cited };
}

export interface SpeechPart {
  /** The text as written, citations included, for display. */
  raw: string;
  /** The same text with citations and markdown removed. Empty when nothing is speakable. */
  spoken: string;
}

const SENTENCE_END = /[.!?。！？]["')\]]*(?:\s*\[\d+(?:\s*,\s*\d+)*\])*\s+|\n+/;

/** Cuts streamed answer text into sentences that can be shown and spoken together. */
export class SentenceSplitter {
  private buffer = '';

  push(delta: string): SpeechPart[] {
    this.buffer += delta;
    const parts: SpeechPart[] = [];
    for (;;) {
      const match = SENTENCE_END.exec(this.buffer);
      if (!match) return parts;
      const end = match.index + match[0].length;
      parts.push(part(this.buffer.slice(0, end)));
      this.buffer = this.buffer.slice(end);
    }
  }

  flush(): SpeechPart[] {
    const rest = this.buffer;
    this.buffer = '';
    return rest ? [part(rest)] : [];
  }
}

function part(raw: string): SpeechPart {
  return { raw, spoken: speakable(raw.replace(MARKER, '')) };
}

function speakable(text: string): string {
  return text
    .replace(/[*_`#>]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/ +([.,;:!?])/g, '$1')
    .trim();
}
