export type AnswerModePreference = "auto" | "documents" | "general";

export interface QuestionScope {
  /** The user's choice; mode records the actual answer source for this conversation. */
  answerMode?: AnswerModePreference;
  visualKey?: string;
  mode: "documents" | "general";
  setIds: number[];
  documentIds: number[];
}

/** Selection, not search success or document count, determines automatic mode. */
export function resolveAnswerMode(
  preference: AnswerModePreference,
  setIds: readonly number[],
  hasVisuals: boolean,
): QuestionScope["mode"] {
  if (preference !== "auto") return preference;
  return setIds.length || hasVisuals ? "documents" : "general";
}

export function idKey(ids: number[]): string {
  return [...new Set(ids)].sort((a, b) => a - b).join(",");
}

/** History is useful only within the same source selection and answer mode. */
export function sameQuestionScope(a: QuestionScope, b: QuestionScope): boolean {
  return (
    (a.visualKey ?? "") === (b.visualKey ?? "") &&
    a.mode === b.mode &&
    (a.mode === "general" ||
      (idKey(a.setIds) === idKey(b.setIds) &&
        idKey(a.documentIds) === idKey(b.documentIds)))
  );
}
