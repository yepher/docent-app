export interface CodePart {
  kind: "text" | "code";
  start: number;
  raw: string;
  text: string;
  language?: string;
}

const plain = (raw: string, start: number): CodePart => ({
  kind: "text",
  start,
  raw,
  text: raw,
});

/** Fenced blocks, including an unfinished block while the answer is streaming. No HTML parsing. */
export function codeBlocks(text: string): CodePart[] {
  const parts: CodePart[] = [];
  let from = 0;
  let open: {
    start: number;
    body: number;
    close: RegExp;
    language: string;
  } | null = null;
  for (const line of text.matchAll(/[^\n]*(?:\n|$)/g)) {
    if (!line[0]) break;
    if (open) {
      if (!open.close.test(line[0])) continue;
      const end = line.index + line[0].length;
      parts.push({
        kind: "code",
        start: open.start,
        raw: text.slice(open.start, end),
        text: text.slice(open.body, line.index),
        language: open.language,
      });
      from = end;
      open = null;
    } else {
      const fence = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)\r?(?:\n|$)$/.exec(line[0]);
      if (!fence || (fence[1]![0] === "`" && fence[2]!.includes("`"))) continue;
      if (line.index > from)
        parts.push(plain(text.slice(from, line.index), from));
      open = {
        start: line.index,
        body: line.index + line[0].length,
        close: new RegExp(
          `^ {0,3}${fence[1]![0]}{${fence[1]!.length},}[ \\t]*\\r?\\n?$`,
        ),
        language: fence[2]!.trim().split(/\s+/)[0]!.slice(0, 60),
      };
    }
  }
  if (open)
    parts.push({
      kind: "code",
      start: open.start,
      raw: text.slice(open.start),
      text: text.slice(open.body),
      language: open.language,
    });
  else if (from < text.length) parts.push(plain(text.slice(from), from));
  return parts;
}

/** Inline backtick spans; matching delimiter lengths let a span contain literal backticks. */
export function inlineCode(text: string, offset = 0): CodePart[] {
  const runs = [...text.matchAll(/`+/g)];
  const parts: CodePart[] = [];
  let from = 0;
  for (let i = 0; i < runs.length; i++) {
    const opening = runs[i]!;
    const escapes = /\\+$/.exec(text.slice(0, opening.index))?.[0].length ?? 0;
    if (escapes % 2) continue;
    let j = i + 1;
    while (j < runs.length && runs[j]![0].length !== opening[0].length) j++;
    if (j === runs.length) continue;
    const closing = runs[j]!;
    if (opening.index > from)
      parts.push(plain(text.slice(from, opening.index), offset + from));
    let content = text
      .slice(opening.index + opening[0].length, closing.index)
      .replace(/\r\n?|\n/g, " ");
    if (content.startsWith(" ") && content.endsWith(" ") && /\S/.test(content))
      content = content.slice(1, -1);
    const end = closing.index + closing[0].length;
    parts.push({
      kind: "code",
      start: offset + opening.index,
      raw: text.slice(opening.index, end),
      text: content,
    });
    from = end;
    i = j;
  }
  if (from < text.length) parts.push(plain(text.slice(from), offset + from));
  return parts;
}

/** Change prose without changing any code bytes, even in an unfinished fenced block. */
export function mapProse(
  text: string,
  transform: (prose: string, start: number) => string,
): string {
  return codeBlocks(text)
    .map((block) =>
      block.kind === "code"
        ? block.raw
        : inlineCode(block.raw, block.start)
            .map((part) =>
              part.kind === "code" ? part.raw : transform(part.raw, part.start),
            )
            .join(""),
    )
    .join("");
}

/** Mask code for citation/quotation checks, preserving offsets and paragraph boundaries. */
export function proseOnly(text: string): string {
  return codeBlocks(text)
    .map((block) =>
      block.kind === "code"
        ? block.raw.replace(/[^\r\n]/g, " ")
        : inlineCode(block.raw)
            .map((part) =>
              part.kind === "code"
                ? part.raw.replace(/[^\r\n]/g, " ")
                : part.raw,
            )
            .join(""),
    )
    .join("");
}
