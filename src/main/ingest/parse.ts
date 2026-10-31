import { readFile, readdir, stat } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import type { Segment } from './chunk';

const TEXT_EXTENSIONS = new Set(
  (
    '.txt .text .md .markdown .rst .adoc .org .tex .csv .tsv .log .json .jsonl .yaml .yml .toml ' +
    '.ini .xml .html .htm .js .jsx .ts .tsx .py .rb .go .rs .java .kt .swift .c .h .cc .cpp .hpp ' +
    '.cs .php .sh .sql'
  ).split(' '),
);
const MARKUP = new Set(['.html', '.htm']);
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const SKIP_DIRS = new Set(['node_modules', '__pycache__', 'venv', 'target', 'dist', 'build']);

export function isSupported(path: string): boolean {
  const ext = extname(path).toLowerCase();
  return ext === '.pdf' || ext === '.docx' || TEXT_EXTENSIONS.has(ext);
}

/** Files under a path. Skips hidden entries, dependency folders and symlinks, so a link cannot pull in files outside what was picked. */
export async function collectFiles(root: string): Promise<string[]> {
  const info = await stat(root);
  if (info.isFile()) return isSupported(root) ? [root] : [];
  const out: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) out.push(...(await collectFiles(path)));
    } else if (entry.isFile() && isSupported(path)) {
      out.push(path);
    }
  }
  return out;
}

function stripMarkup(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(p|div|li|tr|h[1-6]|br)\s*>|<br\s*\/?>/gi, '\n\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

async function parsePdf(bytes: Buffer): Promise<Segment[]> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: true });
  const doc = await task.promise;
  const segments: Segment[] = [];
  try {
    for (let page = 1; page <= doc.numPages; page++) {
      const content = await (await doc.getPage(page)).getTextContent();
      let text = '';
      for (const item of content.items) {
        if ('str' in item) text += item.str + (item.hasEOL ? '\n' : ' ');
      }
      if (text.trim()) segments.push({ text, page });
    }
  } finally {
    await task.destroy();
  }
  return segments;
}

export async function parseFile(path: string): Promise<Segment[]> {
  const info = await stat(path);
  if (info.size > MAX_FILE_BYTES) throw new Error('File is larger than 50 MB');
  const ext = extname(path).toLowerCase();
  const bytes = await readFile(path);
  let segments: Segment[];
  if (ext === '.pdf') {
    segments = await parsePdf(bytes);
    if (segments.length === 0) throw new Error('No text found. Scanned PDFs need OCR first.');
    return segments;
  }
  if (ext === '.docx') {
    const mammoth = (await import('mammoth')).default;
    const { value } = await mammoth.extractRawText({ buffer: bytes });
    segments = [{ text: value, page: null }];
  } else {
    if (bytes.includes(0)) throw new Error('Looks like a binary file');
    const text = bytes.toString('utf8');
    segments = [{ text: MARKUP.has(ext) ? stripMarkup(text) : text, page: null }];
  }
  if (!segments.some((s) => s.text.trim())) throw new Error('File has no text');
  return segments;
}

export const titleOf = (path: string) => basename(path);
