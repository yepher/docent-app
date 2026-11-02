/**
 * Types safe to hand to the system's default app. A script or program would be run, not viewed,
 * so anything else can only be shown in its folder.
 */
const VIEWABLE = new Set(
  '.pdf .png .jpg .jpeg .docx .md .markdown .txt .text .rst .csv .tsv .log .json .jsonl .yaml .yml .toml .xml'.split(' '),
);

export function isViewable(path: string): boolean {
  const dot = path.lastIndexOf('.');
  return dot >= 0 && VIEWABLE.has(path.slice(dot).toLowerCase());
}
