import { describe, expect, it } from "vitest";
import {
  sameQuestionScope,
  resolveAnswerMode,
  type QuestionScope,
} from "../src/shared/question-scope";

const scope: QuestionScope = {
  mode: "documents",
  setIds: [1, 2],
  documentIds: [],
};
describe("question source boundaries", () => {
  it("uses general knowledge only when automatic mode has no selected sets or visual evidence", () => {
    expect(resolveAnswerMode("auto", [], false)).toBe("general");
    expect(resolveAnswerMode("auto", [1], false)).toBe("documents");
    expect(resolveAnswerMode("auto", [], true)).toBe("documents");
    expect(resolveAnswerMode("auto", [1], true)).toBe("documents");
  });
  it("respects explicit choices even with no documents or with selected sets", () => {
    expect(resolveAnswerMode("documents", [], false)).toBe("documents");
    expect(resolveAnswerMode("general", [1, 2], false)).toBe("general");
  });
  it("resets automatic conversations when selection changes the effective mode", () => {
    const empty: QuestionScope = {
      ...scope,
      answerMode: "auto",
      mode: resolveAnswerMode("auto", [], false),
      setIds: [],
    };
    const selected: QuestionScope = {
      ...scope,
      answerMode: "auto",
      mode: resolveAnswerMode("auto", [1, 2], false),
    };
    expect(sameQuestionScope(empty, selected)).toBe(false);
    expect(sameQuestionScope(selected, empty)).toBe(false);
    expect(sameQuestionScope(empty, { ...empty, answerMode: "general" })).toBe(
      true,
    );
  });
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
