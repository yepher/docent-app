export interface Segment {
  text: string;
  page: number | null;
}

export interface Chunk {
  text: string;
  page: number | null;
  line: number | null;
}

export const CHUNK_CHARS = 1000;
export const OVERLAP_CHARS = 150;

interface Paragraph {
  text: string;
  line: number;
}

function paragraphs(text: string): Paragraph[] {
  const out: Paragraph[] = [];
  let buf: string[] = [];
  let start = 1;
  const lines = text.split(/\r\n|\r|\n/);
  const flush = () => {
    if (buf.length > 0) out.push({ text: buf.join('\n'), line: start });
    buf = [];
  };
  lines.forEach((line, i) => {
    if (line.trim() === '') return flush();
    if (buf.length === 0) start = i + 1;
    buf.push(line);
  });
  flush();
  return out;
}

/** Cuts an over-long paragraph at sentence or word ends so no piece exceeds the limit. */
function hardSplit(text: string, limit: number): string[] {
  const pieces: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    const sentence = Math.max(window.lastIndexOf('. '), window.lastIndexOf('\n'));
    const space = window.lastIndexOf(' ');
    const cut = sentence > limit / 2 ? sentence + 1 : space > limit / 2 ? space : limit;
    pieces.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) pieces.push(rest);
  return pieces;
}

function overlapTail(text: string): string {
  if (text.length <= OVERLAP_CHARS) return '';
  const tail = text.slice(-OVERLAP_CHARS);
  const space = tail.indexOf(' ');
  return space >= 0 ? tail.slice(space + 1) : tail;
}

/**
 * Splits parsed text into overlapping chunks. Page and line point at where a chunk's own
 * content begins, not its overlap, so a citation lands on the passage it names.
 * Line numbers apply only to page-less text; a PDF citation is page-level.
 */
export function chunkSegments(segments: Segment[]): Chunk[] {
  const chunks: Chunk[] = [];
  for (const segment of segments) {
    let text = '';
    let line: number | null = null;
    const emit = () => {
      if (text.trim()) {
        chunks.push({
          text: text.trim(),
          page: segment.page,
          line: segment.page === null ? line : null,
        });
      }
    };
    for (const para of paragraphs(segment.text)) {
      for (const piece of hardSplit(para.text, CHUNK_CHARS - OVERLAP_CHARS - 2)) {
        if (text && text.length + piece.length + 2 > CHUNK_CHARS) {
          emit();
          const tail = overlapTail(text);
          text = tail ? `${tail}\n\n${piece}` : piece;
          line = para.line;
        } else {
          if (!text) line = para.line;
          text = text ? `${text}\n\n${piece}` : piece;
        }
      }
    }
    emit();
  }
  return chunks;
}
