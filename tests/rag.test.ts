import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { NO_MATCH, runTurn } from '../src/main/agent';
import { SentenceSplitter, type SpeechPart, resolveCitations } from '../src/main/citations';
import { CHUNK_CHARS, chunkSegments } from '../src/main/ingest/chunk';
import { indexSet } from '../src/main/ingest';
import { collectFiles, parseFile } from '../src/main/ingest/parse';
import type { ChatDelta, Embedder, Llm, ToolCall } from '../src/main/llm';
import { applyPronunciations } from '../src/main/pronunciation';
import { Retriever, normalize } from '../src/main/retrieval';
import { Store } from '../src/main/store';

const DIM = 128;
function embed(text: string): Float32Array {
  const v = new Float32Array(DIM);
  for (const word of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    let h = 7;
    for (const c of word) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    v[h % DIM]! += 1;
  }
  return v;
}
const embedder: Embedder = {
  embedDocuments: async (texts) => texts.map(embed),
  embedQuery: async (text) => embed(text),
};

function scriptedLlm(rounds: (string | ToolCall[])[], spoken: string[] = []) {
  const seen: { messages: unknown[]; tools: unknown[] }[] = [];
  const llm: Llm = {
    async *chat(messages, tools) {
      seen.push({ messages: structuredClone(messages), tools });
      const round = rounds[seen.length - 1] ?? 'done';
      if (typeof round === 'string') {
        for (const word of round.split(/(?<= )/)) yield { type: 'text', text: word } satisfies ChatDelta;
      } else {
        yield { type: 'tool_calls', calls: round };
      }
    },
    transcribe: async () => '',
    async *speak(text) {
      spoken.push(text);
      yield { samples: new ArrayBuffer(4), sampleRate: 24000 };
      yield { samples: new ArrayBuffer(4), sampleRate: 24000 };
    },
  };
  return { llm, seen };
}

const events = () => {
  const log: string[] = [];
  const paced: string[] = [];
  return {
    log,
    paced,
    status: () => {},
    delta: (t: string) => log.push(t),
    audio: (_s: ArrayBuffer, _r: number, text: string | null) => {
      if (text !== null) paced.push(text);
    },
  };
};
const opts = (speak = false) => ({ speak, signal: new AbortController().signal });

/** Builds a real, minimal PDF with one line of text per page. */
function tinyPdf(pages: string[]): Buffer {
  const objects: string[] = [];
  const kids = pages.map((_, i) => `${4 + i * 2} 0 R`).join(' ');
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`;
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  pages.forEach((text, i) => {
    const stream = text ? `BT /F1 12 Tf 72 720 Td (${text}) Tj ET` : '';
    objects[4 + i * 2] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${5 + i * 2} 0 R ` +
      '/Resources << /Font << /F1 3 0 R >> >> >>';
    objects[5 + i * 2] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  });
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let n = 1; n < objects.length; n++) {
    offsets[n] = pdf.length;
    pdf += `${n} 0 obj\n${objects[n]}\nendobj\n`;
  }
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let n = 1; n < objects.length; n++) pdf += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

describe('chunkSegments', () => {
  it('keeps chunks under the limit and overlaps neighbors', () => {
    const para = 'word '.repeat(150).trim();
    const chunks = chunkSegments([{ text: Array(6).fill(para).join('\n\n'), page: null }]);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(CHUNK_CHARS);
  });

  it('records the starting line for text and only the page for PDFs', () => {
    const [first, second] = chunkSegments([{ text: `\n\nalpha\n\n${'x'.repeat(1900)}`, page: null }]);
    expect(first?.line).toBe(3);
    expect(second?.line).toBe(5);
    expect(chunkSegments([{ text: 'hello', page: 4 }])[0]).toMatchObject({ page: 4, line: null });
  });

  it('splits a single huge paragraph', () => {
    const chunks = chunkSegments([{ text: 'a'.repeat(5000), page: null }]);
    expect(chunks.length).toBeGreaterThan(4);
    expect(chunks.every((c) => c.text.length <= CHUNK_CHARS)).toBe(true);
  });
});

describe('resolveCitations', () => {
  it('keeps real sources and removes invented ones', () => {
    const { text, cited } = resolveCitations('Fact [1]. Other [2, 9]. Fake [7].', 2);
    expect([...cited].sort()).toEqual([1, 2]);
    expect(text).toBe('Fact [1]. Other [2]. Fake.');
  });
});

describe('SentenceSplitter', () => {
  it('drops citations even when split across deltas', () => {
    const s = new SentenceSplitter();
    const out = [...s.push('First fact ['), ...s.push('1'), ...s.push(']. Second '), ...s.push('fact [2].'), ...s.flush()];
    expect(out.map((p) => p.spoken)).toEqual(['First fact.', 'Second fact.']);
    expect(out.map((p) => p.raw).join('')).toBe('First fact [1]. Second fact [2].');
  });

  it('does not break inside decimals', () => {
    const s = new SentenceSplitter();
    expect(s.push('It grew 3.5 percent ')).toEqual([]);
    expect(s.flush().map((p) => p.spoken)).toEqual(['It grew 3.5 percent']);
  });

  it('keeps a citation after the period with its sentence, and never loses text', () => {
    const s = new SentenceSplitter();
    const text = 'One. [1] Two.\n- item\n[2]';
    const out = [...s.push(text), ...s.flush()];
    expect(out.map((p) => p.raw).join('')).toBe(text);
    expect(out[0]?.raw).toBe('One. [1] ');
    expect(out.map((p) => p.spoken)).toEqual(['One.', 'Two.', '- item', '']);
  });

  const spokenFrom = (text: string, size = text.length) => {
    const s = new SentenceSplitter();
    const out: SpeechPart[] = [];
    for (let i = 0; i < text.length; i += size) out.push(...s.push(text.slice(i, i + size)));
    out.push(...s.flush());
    expect(out.map((p) => p.raw).join('')).toBe(text);
    return out.map((p) => p.spoken).filter(Boolean);
  };

  it.each([1, 3, 1000])('shows but never speaks a source list, in deltas of %i', (size) => {
    const text = 'It covers attention.\n\n[1] 1706.03762v7.pdf, page 15\n[2] 1706.03762v7.pdf, page 14';
    expect(spokenFrom(text, size)).toEqual(['It covers attention.']);
  });

  it('skips source headings, bullets and full stops inside a reference', () => {
    const text = 'Answer.\n\n**Sources:**\n- [1] Smith et al. Attention, page 3.\n- [2] notes.md, line 4\n';
    expect(spokenFrom(text)).toEqual(['Answer.']);
  });

  it('still speaks a sentence that follows a citation on the same line', () => {
    expect(spokenFrom('One. [1] Two.', 1)).toEqual(['One.', 'Two.']);
  });

  it('still speaks a line that merely mentions sources', () => {
    expect(spokenFrom('Answer.\nThe sources disagree.')).toEqual(['Answer.', 'The sources disagree.']);
  });
});

describe('search and indexing', () => {
  let store: Store;
  let retriever: Retriever;
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'docent-'));
    store = new Store(join(dir, 'test.db'));
    retriever = new Retriever(store, embedder.embedQuery);
  });

  async function setWith(name: string, file: string, text: string) {
    const set = store.createSet(name);
    const path = join(dir, file);
    writeFileSync(path, text);
    store.addSource(set.id, path);
    await indexSet(store, embedder, set.id, () => {});
    return { set, path };
  }

  it('searches only the sets asked for', async () => {
    const a = await setWith('A', 'a.md', 'The zebra migration happens in spring.');
    const b = await setWith('B', 'b.md', 'The zebra budget was approved in March.');
    const hits = await retriever.search([b.set.id], 'zebra');
    expect(hits.map((h) => h.path)).toEqual([b.path]);
    expect(await retriever.search([a.set.id, b.set.id], 'zebra')).toHaveLength(2);
    expect(await retriever.search([], 'zebra')).toEqual([]);
  });

  it('survives query text that would be FTS syntax', async () => {
    const { set } = await setWith('A', 'a.md', 'Hello world');
    await expect(retriever.search([set.id], 'hello" OR NEAR(* AND -x')).resolves.toBeDefined();
  });

  it('refreshes results after a document is removed', async () => {
    const { set } = await setWith('A', 'a.md', 'zebra facts');
    expect(await retriever.search([set.id], 'zebra')).toHaveLength(1);
    store.removeDocument(store.documents(set.id)[0]!.id);
    expect(await retriever.search([set.id], 'zebra')).toEqual([]);
  });

  it('reindexes changed files, skips unchanged ones, and drops deleted ones', async () => {
    const { set, path } = await setWith('A', 'a.md', 'old zebra text');
    const firstId = store.documents(set.id)[0]!.id;
    await indexSet(store, embedder, set.id, () => {});
    expect(store.documents(set.id)[0]!.id).toBe(firstId);

    writeFileSync(path, 'new giraffe text, and longer');
    await indexSet(store, embedder, set.id, () => {});
    expect(await retriever.search([set.id], 'zebra')).toEqual([]);
    expect(await retriever.search([set.id], 'giraffe')).toHaveLength(1);
  });

  it('records a failure without losing the rest of the set', async () => {
    const set = store.createSet('A');
    writeFileSync(join(dir, 'good.md'), 'zebra');
    writeFileSync(join(dir, 'bad.txt'), Buffer.from([1, 0, 2]));
    store.addSource(set.id, join(dir, 'good.md'));
    store.addSource(set.id, join(dir, 'bad.txt'));
    await indexSet(store, embedder, set.id, () => {});
    const docs = store.documents(set.id);
    expect(docs.find((d) => d.title === 'bad.txt')?.error).toMatch(/binary/);
    expect(docs.find((d) => d.title === 'good.md')?.error).toBeNull();
  });

  it('walks folders, skipping hidden files and dependencies', async () => {
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(dir, 'docs/node_modules'), { recursive: true });
    mkdirSync(join(dir, 'docs/.git'));
    writeFileSync(join(dir, 'docs/a.md'), 'x');
    writeFileSync(join(dir, 'docs/photo.png'), 'x');
    writeFileSync(join(dir, 'docs/node_modules/b.md'), 'x');
    writeFileSync(join(dir, 'docs/.git/c.md'), 'x');
    expect(await collectFiles(join(dir, 'docs'))).toEqual([join(dir, 'docs/a.md'), join(dir, 'docs/photo.png')]);
  });

  // The first PDF also loads pdfjs, which took 5.8s on a Windows runner.
  it('reads PDF text page by page', { timeout: 30_000 }, async () => {
    const path = join(dir, 'two-pages.pdf');
    writeFileSync(path, tinyPdf(['Zebras graze at dawn', 'Budgets close in March']));
    const segments = await parseFile(path);
    expect(segments.map((s) => s.page)).toEqual([1, 2]);
    expect(segments[1]?.text).toContain('Budgets close in March');
  });

  it('explains a PDF with no text layer', async () => {
    const path = join(dir, 'scan.pdf');
    writeFileSync(path, tinyPdf(['']));
    expect((await parseFile(path))[0]).toEqual({ page: 1, text: 'No readable text on this page. Use Ask about this page to inspect its visual content.' });
  });

  it('strips scripts from HTML', async () => {
    const path = join(dir, 'p.html');
    writeFileSync(path, '<p>Hi &amp; bye</p><script>alert(1)</script>');
    const [segment] = await parseFile(path);
    expect(segment?.text).toContain('Hi & bye');
    expect(segment?.text).not.toContain('alert');
  });
});

describe('runTurn', () => {
  const chunk = (id: number, text: string, page: number | null = 2) => ({
    id, documentId: id, text, page, line: null, title: `doc${id}.pdf`, path: `/d/doc${id}.pdf`, setName: 'Set',
  });

  it('gives sources to the model and returns only what the answer cites as cited', async () => {
    const { llm, seen } = scriptedLlm(['Paris is the capital [2]. Moon [7].']);
    const result = await runTurn(
      { llm, search: async () => [chunk(1, 'unrelated'), chunk(2, 'Paris is the capital')], hasSelectedDocuments: true },
      'What is the capital of France?', [], opts(), events(),
    );
    expect(JSON.stringify(seen[0]!.messages)).toContain('[2] doc2.pdf, page 2');
    expect(result.text).toBe('Paris is the capital [2]. Moon.');
    expect(result.citations.filter((c) => c.cited).map((c) => c.title)).toEqual(['doc2.pdf']);
    expect(result.uncited).toBe(false);
  });

  it('refuses to guess when nothing matches, without calling the model', async () => {
    const { llm, seen } = scriptedLlm(['should not run']);
    const result = await runTurn({ llm, search: async () => [], hasSelectedDocuments: true }, 'q', [], opts(), events());
    expect(result.text).toBe(NO_MATCH);
    expect(seen).toHaveLength(0);
  });

  it('flags an answer that cites nothing', async () => {
    const { llm } = scriptedLlm(['Trust me.']);
    const result = await runTurn(
      { llm, search: async () => [chunk(1, 'x')], hasSelectedDocuments: true }, 'q', [], opts(), events(),
    );
    expect(result.uncited).toBe(true);
    expect(result.citations).toHaveLength(1);
  });

  it('continues numbering across tool searches and does not repeat passages', async () => {
    const call: ToolCall = { id: 'c1', type: 'function', function: { name: 'search_documents', arguments: '{"query":"more"}' } };
    const { llm, seen } = scriptedLlm([[call], 'Found it [3].']);
    const search = async (q: string) =>
      q === 'more' ? [chunk(1, 'a'), chunk(3, 'new passage')] : [chunk(1, 'a'), chunk(2, 'b')];
    const result = await runTurn({ llm, search, hasSelectedDocuments: true }, 'a long enough question to stand alone', [], opts(), events());
    const toolMessage = (seen[1]!.messages as { role: string; content: string }[]).at(-1)!;
    expect(toolMessage.role).toBe('tool');
    expect(toolMessage.content).toBe('[3] doc3.pdf, page 2 (document ID 3)\nnew passage');
    expect(result.citations.find((c) => c.n === 3)).toMatchObject({ title: 'doc3.pdf', cited: true });
  });

  it('forces an answer when the model keeps calling tools', async () => {
    const call: ToolCall = { id: 'c', type: 'function', function: { name: 'search_documents', arguments: '{"query":"x"}' } };
    const { llm, seen } = scriptedLlm([[call], [call], 'Final [1].']);
    const result = await runTurn(
      { llm, search: async () => [chunk(1, 'a')], hasSelectedDocuments: true }, 'q', [], opts(), events(),
    );
    expect(seen).toHaveLength(3);
    expect(seen[2]!.tools).toEqual([]);
    expect(result.text).toBe('Final [1].');
  });

  it('reports a bad tool call back to the model', async () => {
    const call: ToolCall = { id: 'c', type: 'function', function: { name: 'search_documents', arguments: 'not json' } };
    const { llm, seen } = scriptedLlm([[call], 'ok [1]']);
    await runTurn({ llm, search: async () => [chunk(1, 'a')], hasSelectedDocuments: true }, 'q', [], opts(), events());
    expect((seen[1]!.messages as { content: string }[]).at(-1)!.content).toMatch(/needs a "query"/);
  });

  it('offers no search tool when no documents are selected', async () => {
    const { llm, seen } = scriptedLlm(['Hi.']);
    const result = await runTurn({ llm, search: async () => [], hasSelectedDocuments: false }, 'hi', [], opts(), events());
    expect(seen[0]!.tools).toEqual([]);
    expect(result).toMatchObject({ text: 'Hi.', citations: [], uncited: false });
  });

  it('speaks sentences in order without the citation markers', async () => {
    const spoken: string[] = [];
    const { llm } = scriptedLlm(['One [1]. Two [1]. Three.'], spoken);
    await runTurn(
      { llm, search: async () => [chunk(1, 'a')], hasSelectedDocuments: true }, 'q', [], opts(true), events(),
    );
    expect(spoken).toEqual(['One.', 'Two.', 'Three.']);
  });

  it('streams text independently of audio playback', async () => {
    const { llm } = scriptedLlm(['One [1]. Two.']);
    const e = events();
    await runTurn({ llm, search: async () => [chunk(1, 'a')], hasSelectedDocuments: true }, 'q', [], opts(true), e);
    expect(e.paced).toEqual([]);
    expect(e.log.join('')).toBe('One [1]. Two.');
  });

  it('still shows every sentence when speech fails, and keeps going', async () => {
    const { llm } = scriptedLlm(['One. Two.']);
    llm.speak = async function* (text) {
      if (text === 'One.') throw new Error('tts down');
      yield { samples: new ArrayBuffer(4), sampleRate: 24000 };
    };
    const e = events();
    const result = await runTurn({ llm, search: async () => [], hasSelectedDocuments: false }, 'q', [], opts(true), e);
    expect(e.log.join('')).toBe('One. Two.');
    expect(e.paced).toEqual([]);
    expect(result.text).toBe('One. Two.');
  });

  it('applies pronunciations to speech but not to the written answer', async () => {
    const spoken: string[] = [];
    const { llm } = scriptedLlm(['Nginx is fast.'], spoken);
    const result = await runTurn(
      {
        llm,
        search: async () => [],
        hasSelectedDocuments: false,
        pronounce: (t) => applyPronunciations(t, [{ word: 'nginx', spoken: 'engine ex' }]),
      },
      'q', [], opts(true), events(),
    );
    expect(spoken).toEqual(['engine ex is fast.']);
    expect(result.text).toBe('Nginx is fast.');
  });

  it('borrows the previous question for a short follow-up', async () => {
    const queries: string[] = [];
    const { llm } = scriptedLlm(['x [1]']);
    await runTurn(
      { llm, search: async (q) => (queries.push(q), [chunk(1, 'a')]), hasSelectedDocuments: true },
      'and the second?', [{ role: 'user', content: 'Who wrote the report?' }], opts(), events(),
    );
    expect(queries[0]).toBe('Who wrote the report? and the second?');
  });

  it('stops when aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const { llm } = scriptedLlm(['x']);
    await expect(
      runTurn({ llm, search: async () => [], hasSelectedDocuments: false }, 'q', [], { speak: false, signal: controller.signal }, events()),
    ).rejects.toThrow();
  });
});

it('normalize makes unit vectors and leaves zero vectors alone', () => {
  expect(normalize(new Float32Array([3, 4]))[0]).toBeCloseTo(0.6);
  expect([...normalize(new Float32Array([0, 0]))]).toEqual([0, 0]);
});

describe('applyPronunciations', () => {
  const apply = (text: string, ...pairs: [string, string][]) =>
    applyPronunciations(text, pairs.map(([word, spoken]) => ({ word, spoken })));

  it('matches whole words in any case', () => {
    expect(apply('NGINX and nginx, not nginxish', ['Nginx', 'engine ex'])).toBe('engine ex and engine ex, not nginxish');
  });

  it('prefers the longest match and handles phrases across spacing', () => {
    expect(apply('New  York and York', ['York', 'yawk'], ['New York', 'noo yawk'])).toBe('noo yawk and yawk');
  });

  it('does not rewrite a replacement', () => {
    expect(apply('a b', ['a', 'b'], ['b', 'c'])).toBe('b c');
  });

  it('treats regex characters and replacement patterns literally', () => {
    expect(apply('C++ rocks', ['C++', '$& see plus'])).toBe('$& see plus rocks');
    expect(apply('axb', ['a.b', 'nope'])).toBe('axb');
  });

  it('respects boundaries in other alphabets', () => {
    expect(apply('Köln und Kölnisch', ['Köln', 'kerln'])).toBe('kerln und Kölnisch');
  });

  it('leaves text alone with no entries', () => {
    expect(apply('hello')).toBe('hello');
  });
});

describe('stored pronunciations', () => {
  it('persist across reopening and replace case-insensitively', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'docent-')), 'p.db');
    const first = new Store(path);
    first.setPronunciation('Nginx', 'engine x');
    first.setPronunciation('NGINX', 'engine ex');
    first.close();
    const second = new Store(path);
    expect(second.pronunciations()).toEqual([{ word: 'NGINX', spoken: 'engine ex' }]);
    second.removePronunciation('nginx');
    expect(second.pronunciations()).toEqual([]);
  });
});
