import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  codeBlocks,
  inlineCode,
  mapProse,
  proseOnly,
} from "../src/shared/code-text";
import { resolveCitations, evidenceIssues } from "../src/main/citations";
import { remapHistory } from "../src/main/evidence";
import {
  repairQuotedReferences,
  sourceIntegrityIssues,
} from "../src/main/grounding";
import { AnswerText } from "../src/renderer/src/AnswerText";
import type { Citation } from "../src/shared/types";

const body =
  'def example(values):\n    first = values[0]\n    rows = [1, 2, 99]\n\n    return "Keep  two  spaces and this literal quotation"\n';
const answer =
  "Example [1].\n\n```python\n" +
  body +
  "```\n\nUse `values[0]` and **the result** [1, 9].";
const source: Citation = {
  n: 1,
  documentId: 1,
  title: "Notes",
  path: "/notes.txt",
  setName: "Notes",
  page: null,
  line: 1,
  excerpt: "Example values and results.",
  cited: true,
};

describe("code-aware answer formatting", () => {
  it("preserves fenced code exactly, including CRLF, language labels and unfinished streamed blocks", () => {
    expect(codeBlocks(answer).filter((p) => p.kind === "code")).toMatchObject([
      { language: "python", text: body },
    ]);
    const crlf = "~~~other-language\r\n\tdata[0]\r\n~~~~\r\n";
    expect(codeBlocks(crlf)[0]?.text).toBe("\tdata[0]\r\n");
    expect(codeBlocks("````markdown\n```\nexample\n```\n````")[0]?.text).toBe(
      "```\nexample\n```\n",
    );
    for (let length = 1; length <= answer.length; length++) {
      const partial = answer.slice(0, length);
      expect(
        codeBlocks(partial)
          .map((p) => p.raw)
          .join(""),
      ).toBe(partial);
    }
    expect(codeBlocks("```python\n    pending  ")[0]?.text).toBe(
      "    pending  ",
    );
  });
  it("handles multiple inline backticks, wrapped inline code and escaped literal ticks", () => {
    const text =
      "Use `values[0]` and `` `tag` `` and `a\nb`. An unmatched ` stays text.";
    expect(
      inlineCode(text)
        .filter((p) => p.kind === "code")
        .map((p) => p.text),
    ).toEqual(["values[0]", "`tag`", "a b"]);
    expect(inlineCode("escaped \\`tick").every((p) => p.kind === "text")).toBe(
      true,
    );
    expect(mapProse(text, (p) => p)).toBe(text);
    expect(proseOnly(answer)).not.toMatch(/values\[0\]|\[99\]|quotation/);
  });
  it("cleans real citations without changing arrays, strings or indentation", () => {
    const result = resolveCitations(answer, 1);
    expect(result.cited).toEqual(new Set([1]));
    expect(result.text).toBe(answer.replace("[1, 9]", "[1]"));
    expect(
      codeBlocks(resolveCitations(answer, 0).text).find(
        (p) => p.kind === "code",
      )?.text,
    ).toBe(body);
    expect(resolveCitations("```\n    rows = [1, 2]\n  ", 0).text).toBe(
      "```\n    rows = [1, 2]\n  ",
    );
    expect(resolveCitations("`[1, 2]`", 2).cited.size).toBe(0);
    expect(
      evidenceIssues(
        answer.replace("[1, 9]", "[1]"),
        new Map([[1, "Example values and results."]]),
      ),
    ).toEqual([]);
  });
  it("leaves code references alone in evidence checks, repairs and follow-up history", () => {
    const quoted = "“Keep the exact `values[0]` expression.” [9]";
    const sources = [{ n: 1, text: "Keep the exact `values[0]` expression." }];
    expect(repairQuotedReferences(quoted, sources)).toBe(
      quoted.replace("[9]", "[1]"),
    );
    expect(
      sourceIntegrityIssues(quoted.replace("[9]", "[1]"), sources),
    ).toEqual([]);
    expect(
      sourceIntegrityIssues(answer.replace("[1, 9]", "[1]"), sources),
    ).toEqual([]);
    const code = '```js\n"Keep the exact values in this quote"[9]\n```';
    expect(
      repairQuotedReferences(code, [
        { n: 1, text: "Keep the exact values in this quote" },
      ]),
    ).toBe(code);
    const [mapped] = remapHistory(
      [{ role: "assistant", content: answer }],
      new Map([[1, 3]]),
    );
    expect(
      codeBlocks(mapped!.content).find((p) => p.kind === "code")?.text,
    ).toBe(body);
    expect(mapped!.content).toContain("Use `values[0]`");
    expect(mapped!.content).toContain("result** [3]");
  });
  it("renders code as inert text, and only turns citations outside code into buttons", () => {
    const text =
      '**Use `values[0]`** [1].\n\n```html\n<script>alert("x")</script>\n<img src=x onerror=alert(1)>\n[1] **literal**\n```\n\nDone [1].';
    const html = renderToStaticMarkup(
      <AnswerText message={{ text, citations: [source] }} onCite={() => {}} />,
    );
    expect(html).toContain(
      '<strong>Use <code class="inline-code">values[0]</code></strong>',
    );
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toMatch(/<script|<img/);
    expect(html).toContain("[1] **literal**");
    expect(html.match(/class="cite"/g)).toHaveLength(2);
    expect(html).toContain("Copy code");
    expect(html).not.toContain("```html");
  });
});
