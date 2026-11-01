import { describe, expect, it } from "vitest";
import {
  sameQuestionScope,
  type QuestionScope,
} from "../src/shared/question-scope";

const scope: QuestionScope = {
  mode: "documents",
  setIds: [1, 2],
  documentIds: [],
};
describe("question source boundaries", () => {
  it("starts fresh context when sets are added, removed, or replaced", () => {
    for (const setIds of [[1], [], [1, 2, 3], [3]]) {
      expect(sameQuestionScope(scope, { ...scope, setIds })).toBe(false);
    }
  });
  it("starts fresh context when the document filter or answer mode changes", () => {
    expect(sameQuestionScope(scope, { ...scope, documentIds: [10] })).toBe(
      false,
    );
    expect(sameQuestionScope(scope, { ...scope, mode: "general" })).toBe(false);
    expect(
      sameQuestionScope(
        { ...scope, documentIds: [10] },
        { ...scope, documentIds: [11] },
      ),
    ).toBe(false);
  });
  it("preserves follow-ups for the same selection regardless of order", () => {
    expect(
      sameQuestionScope(
        { ...scope, documentIds: [10, 11] },
        { ...scope, setIds: [2, 1], documentIds: [11, 10] },
      ),
    ).toBe(true);
    expect(
      sameQuestionScope(
        { ...scope, mode: "general" },
        { ...scope, mode: "general", setIds: [] },
      ),
    ).toBe(true);
  });
});
