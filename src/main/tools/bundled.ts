import type { ToolPackage, InputSchema } from "../../shared/tools";

const allDocuments = `function documents(library) {
  const out = []; let offset = 0;
  do { const page = library.documents(offset); out.push(...page.documents); offset = page.nextOffset; } while (offset !== null);
  return out;
}
function passages(library, id) {
  const out = []; let offset = 0;
  do { const page = library.read(id, offset); out.push(...page.passages); offset = page.nextOffset; } while (offset !== null);
  return out;
}
`;
function tool(
  id: string,
  name: string,
  description: string,
  inputSchema: InputSchema,
  code: string,
  tests: ToolPackage["tests"],
): ToolPackage {
  return {
    format: "docent-tool",
    formatVersion: 1,
    manifest: {
      id,
      name,
      description,
      version: "1.0.0",
      author: "Docent contributors",
      license: "MIT",
      apiVersion: 1,
      permissions: ["documents:read"],
      inputSchema,
      examples: tests.map((t) => ({ name: t.name, input: t.input })),
    },
    code: allDocuments + code,
    tests,
  };
}
const empty: InputSchema = {
  type: "object",
  properties: {},
  additionalProperties: false,
};

export const BUNDLED_TOOLS: ToolPackage[] = [
  tool(
    "count-mentions",
    "Count documents mentioning a phrase",
    "Scan every selected document and count distinct documents containing a literal phrase, ignoring letter case. Counts documents, not people or votes. Returns example passages.",
    {
      type: "object",
      properties: {
        phrase: {
          type: "string",
          description: "Literal phrase to look for",
          maxLength: 120,
        },
      },
      required: ["phrase"],
      additionalProperties: false,
    },
    `function run(input, library) {
      const phrase = input.phrase.trim(); if (!phrase) throw new Error("Enter a phrase.");
      let count = 0; const evidence = [];
      for (const doc of documents(library)) {
        let match = null;
        for (const p of passages(library, doc.id)) if (!match && p.text.toLowerCase().includes(phrase.toLowerCase())) match = p;
        if (match) { count++; if (evidence.length < 20) evidence.push(match.id); }
      }
      return { data: { phrase, unit: "distinct documents", count }, evidence };
    }`,
    [
      {
        name: "Count a phrase once per document",
        input: { phrase: "filter" },
        documents: [
          { title: "Manual", text: "Filter F19. Replace the filter." },
          { title: "Other", text: "A different subject." },
        ],
        expectedData: {
          phrase: "filter",
          unit: "distinct documents",
          count: 1,
        },
      },
    ],
  ),
  tool(
    "bibliography",
    "Extract numbered bibliographies",
    "List research references from recognized numbered bibliographies in selected documents. Each entry retains its original number and supporting passage IDs. Unsupported formats are reported explicitly.",
    empty,
    `function run(input, library) {
      const found = [], unsupported = [], evidence = [];
      for (const doc of documents(library)) {
        const entries = library.references(doc.id).entries;
        if (!entries.length) { unsupported.push(doc.title); continue; }
        found.push({ title: doc.title, total: entries.length, entries: entries.slice(0, 100) });
        for (const entry of entries.slice(0, 100)) for (const id of entry.evidence) if (!evidence.includes(id)) evidence.push(id);
      }
      if (evidence.length > 100) throw new Error("Choose fewer documents to return bibliography evidence.");
      return { data: { documents: found, unsupported }, evidence };
    }`,
    [
      {
        name: "Extract two references",
        input: {},
        documents: [
          {
            title: "Example paper",
            text: "References\n[1] A. Author. First study. 2020.\n[2] B. Author. Second study. 2021.",
          },
        ],
        expectedData: {
          documents: [
            {
              title: "Example paper",
              total: 2,
              entries: [
                {
                  number: 1,
                  text: "A. Author. First study. 2020.",
                  evidence: ["p1"],
                },
                {
                  number: 2,
                  text: "B. Author. Second study. 2021.",
                  evidence: ["p1"],
                },
              ],
            },
          ],
          unsupported: [],
        },
      },
    ],
  ),
  tool(
    "duplicate-originals",
    "Find duplicate original files",
    "Find selected documents whose saved originals have identical content hashes. This detects exact file copies, not paraphrases or semantically similar documents.",
    empty,
    `function run(input, library) {
      const byHash = new Map(), evidence = [];
      for (const doc of documents(library)) {
        if (!doc.version) continue;
        if (!byHash.has(doc.version)) byHash.set(doc.version, []);
        byHash.get(doc.version).push(doc);
      }
      const groups = [];
      for (const docs of byHash.values()) if (docs.length > 1) {
        groups.push({ documents: docs.map(d => d.title) });
        for (const doc of docs) { const p = library.read(doc.id, 0, 1).passages[0]; if (p && evidence.length < 100) evidence.push(p.id); }
      }
      return { data: { unit: "identical original files", groups }, evidence };
    }`,
    [
      {
        name: "Find identical copies",
        input: {},
        documents: [
          { title: "Copy A", text: "Identical content." },
          { title: "Copy B", text: "Identical content." },
          { title: "Different", text: "Different content." },
        ],
        expectedData: {
          unit: "identical original files",
          groups: [{ documents: ["Copy A", "Copy B"] }],
        },
      },
    ],
  ),
  tool(
    "compare-passages",
    "Compare document passages",
    "Compare two selected document IDs by exact indexed passage text. Return added and removed passages with evidence. Chunk boundaries can change when a file is edited; this is a textual comparison, not a semantic judgment.",
    {
      type: "object",
      properties: {
        beforeId: {
          type: "integer",
          format: "document-id",
          minimum: 1,
          description: "Original document",
        },
        afterId: {
          type: "integer",
          format: "document-id",
          minimum: 1,
          description: "Revised document",
        },
      },
      required: ["beforeId", "afterId"],
      additionalProperties: false,
    },
    `function run(input, library) {
      const before = passages(library, input.beforeId), after = passages(library, input.afterId);
      const key = p => p.text.replace(/\\s+/g, " ").trim();
      const old = new Set(before.map(key)), next = new Set(after.map(key));
      const removed = before.filter(p => !next.has(key(p))), added = after.filter(p => !old.has(key(p)));
      const shown = [...removed.slice(0, 20), ...added.slice(0, 20)];
      return { data: { removedCount: removed.length, addedCount: added.length,
        removed: removed.slice(0, 20).map(p => p.text), added: added.slice(0, 20).map(p => p.text),
        truncated: removed.length > 20 || added.length > 20 }, evidence: shown.map(p => p.id) };
    }`,
    [
      {
        name: "Compare revised instructions",
        input: { beforeId: 1, afterId: 2 },
        documents: [
          { title: "Before", text: "Replace filter F19." },
          { title: "After", text: "Replace filter F20." },
        ],
        expectedData: {
          removedCount: 1,
          addedCount: 1,
          removed: ["Replace filter F19."],
          added: ["Replace filter F20."],
          truncated: false,
        },
      },
    ],
  ),
];
