import type { Store, StoredChunk } from "./store";
import { cleanMarkdown } from "./ingest/parse";

export interface RequesterEvidence {
  author: string;
  quote: string;
  chunk: StoredChunk;
}
export interface RequesterReport {
  examples: RequesterEvidence[];
  documentsChecked: number;
  terms: string[];
}
const GENERIC = new Set([
  "a",
  "an",
  "the",
  "for",
  "of",
  "to",
  "in",
  "on",
  "support",
  "feature",
  "features",
  "tool",
  "tools",
  "ability",
  "please",
  "shapr3d",
  "this",
  "that",
  "these",
  "those",
  "create",
  "creating",
  "creation",
]);

/** Deliberately narrow: this route answers attributed requests, not every question about people. */
export function requesterTerms(question: string): string[] | null {
  const match = question
    .trim()
    .match(
      /^(?:who|which (?:users|people|members|participants))\s+(?:(?:has|have)\s+)?(?:requested|requests|asked for|wants?|would like)\s+(.+?)[?.!]*$/i,
    );
  if (!match) return null;
  const words = (match[1]!.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter(
    (w) => w.length > 2 && !GENERIC.has(w),
  );
  if (!words.length || words.length > 6) return null;
  return [
    ...new Set(
      words.flatMap((w) =>
        w.endsWith("s") ? [w, w.slice(0, -1)] : [w, w + "s"],
      ),
    ),
  ];
}

const wish =
  /\b(?:please|can you|could you)\s+(?:add|implement|make|give)\b|\bi(?:['’]d| would)\s+(?:really\s+|strongly\s+)?(?:like|love|appreciate)\b|\bwould\s+(?:really\s+|strongly\s+|be\s+)?(?:appreciate|appreciated|welcome)\b/i;
const endorsement =
  /(?:^|\s)\+\s*1(?:\s|[,.!?]|$)|\banother vote\b|^i (?:really )?support\b/i;
const notARequest =
  /\b(?:like|want|need) to (?:understand|know|hear|ask)\b|\b(?:give|provide|share)\b.{0,40}\b(?:details|information|examples|use cases)\b|\b(?:do not|don't|don’t) (?:want|need|support)\b/i;
function featureMatcher(terms: string[]) {
  const groups = new Map<string, string[]>();
  for (const term of terms) {
    const key = term.endsWith("s") ? term.slice(0, -1) : term;
    groups.set(key, [...(groups.get(key) ?? []), term]);
  }
  const patterns = [...groups.values()].map(
    (group) =>
      new RegExp(
        `(?<![\\p{L}\\p{N}])(?:${group.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})(?![\\p{L}\\p{N}])`,
        "iu",
      ),
  );
  return (text: string) => patterns.every((p) => p.test(text));
}
const blank = (s: string) => s.replace(/[^\n]/g, "");

/** Strip quoted content before attribution, including nested Discourse quote containers. */
function withoutQuotes(raw: string): string {
  let start = -1,
    depth = 0,
    cursor = 0,
    out = "";
  for (const tag of raw.matchAll(/<\/?(?:aside|blockquote)\b[^>]*>/gi)) {
    const closing = tag[0].startsWith("</");
    if (!closing) {
      if (!depth) start = tag.index!;
      depth++;
    } else if (depth && --depth === 0) {
      out +=
        raw.slice(cursor, start) +
        blank(raw.slice(start, tag.index! + tag[0].length));
      cursor = tag.index! + tag[0].length;
    }
  }
  if (depth) return out + raw.slice(cursor, start) + blank(raw.slice(start));
  return (out + raw.slice(cursor)).replace(/^\s*>[^\n]*/gm, blank);
}

export function attributedRequests(
  raw: string,
  topicTitle: string,
  terms: string[],
) {
  const relevant = featureMatcher(terms);
  const title = topicTitle.replace(/[-_]/g, " ");
  const titleMatches = relevant(title);
  const headers = [...raw.matchAll(/^## Post (\d+) — ([^\r\n]+)\r?$/gm)];
  const dedicatedRequest =
    titleMatches &&
    (/\btool|request|would like|wish\b/i.test(title) ||
      /requesting a feature|feature request/i.test(
        raw.slice(0, headers[1]?.index ?? 3000),
      ));
  return headers.flatMap((header, i) => {
    const block = raw.slice(header.index!, headers[i + 1]?.index ?? raw.length);
    const body = cleanMarkdown(withoutQuotes(block))
      .replace(/^## Post[^\n]*|^- (?:Posted|Source):[^\n]*/gm, "")
      .trim();
    const sentences = body
      .split(/\n+|(?<=[.!?])\s+/)
      .map((s) => s.trim())
      .filter(Boolean);
    const quote = sentences.find((s) => {
      if (
        s.length > 650 ||
        notARequest.test(s) ||
        /\[\d+\]/.test(s) ||
        /^![\[]/.test(s)
      )
        return false;
      if (endorsement.test(s)) {
        const vague =
          /\b(?:this|the) (?:feature|request)\b|^\+1(?:\s+(?:as well|from me|here|too))?[.! ]*$/i.test(
            s,
          );
        return (
          (dedicatedRequest && vague) ||
          (relevant(s) &&
            (dedicatedRequest || /\btool|feature|request\b/i.test(s)))
        );
      }
      const explicitWish =
        wish.test(s) &&
        relevant(s) &&
        (dedicatedRequest ||
          /\btool|feature|ability|option|support|native|automatic\b/i.test(s));
      const featureNeed =
        dedicatedRequest &&
        /^(?:i|we) (?:really )?(?:need|want)\b/i.test(s) &&
        /\bfeature|tool\b/i.test(s);
      return explicitWish || featureNeed;
    });
    if (!quote) return [];
    const line = raw.slice(0, header.index).split("\n").length;
    // Keep the post's own header with its evidence; never attribute a neighboring post or quote.
    const excerpt = `${header[0]}\n\n${quote}`;
    return [{ author: header[2]!.trim(), quote, line, excerpt }];
  });
}

/** Bounded, read-only extraction from saved originals in the current question's scope. */
export async function findRequesters(
  store: Store,
  setIds: number[],
  documentIds: number[],
  question: string,
  signal?: AbortSignal,
): Promise<RequesterReport | null> {
  const terms = requesterTerms(question);
  if (!terms) return null;
  const candidates = store.chunksById(
    store.keywordSearch(setIds, terms.join(" "), 400, documentIds),
  );
  const relevant = featureMatcher(terms);
  // A long discussion can crowd the FTS limit. Include matching topic titles independently.
  for (const setId of setIds)
    for (const doc of store.documents(setId)) {
      if (documentIds.length && !documentIds.includes(doc.id)) continue;
      if (relevant(doc.title.replace(/[-_]/g, " ")))
        candidates.push(...store.documentChunkPage(doc.id, 0, 1));
    }
  const docs = [...new Map(candidates.map((c) => [c.documentId, c])).values()]
    .sort((a, b) => {
      const score = (c: StoredChunk) => {
        const title = c.title.replace(/[-_]/g, " ");
        return relevant(title)
          ? 10 + (/\btool|request|would like|wish\b/i.test(title) ? 10 : 0)
          : 0;
      };
      return score(b) - score(a) || a.title.length - b.title.length;
    })
    .slice(0, 40);
  const examples: RequesterEvidence[] = [],
    seen = new Set<string>();
  let documentsChecked = 0;
  for (const doc of docs) {
    signal?.throwIfAborted();
    if (!/\.(?:md|markdown)$/i.test(doc.path)) continue;
    const bytes = store.originalBytes(doc.documentId);
    if (!bytes || bytes.length > 2 * 1024 * 1024) continue;
    const raw = Buffer.from(bytes).toString("utf8");
    if (!/^## Post \d+ — /m.test(raw)) continue;
    documentsChecked++;
    for (const post of attributedRequests(raw, doc.title, terms)) {
      const key = post.author.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      if (examples.length < 12)
        examples.push({
          author: post.author,
          quote: post.quote,
          chunk: {
            ...doc,
            id: -1000 - examples.length,
            text: post.excerpt,
            line: post.line,
            page: null,
          },
        });
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  signal?.throwIfAborted();
  const fresh = examples.filter(
    (e) =>
      store.documentChunkPage(e.chunk.documentId, 0, 1)[0]?.version ===
      e.chunk.version,
  );
  return fresh.length ? { examples: fresh, documentsChecked, terms } : null;
}
