export interface QuestionScope {
  mode: "documents" | "general";
  setIds: number[];
  documentIds: number[];
}

export function idKey(ids: number[]): string {
  return [...new Set(ids)].sort((a, b) => a - b).join(",");
}

/** History is useful only within the same source selection and answer mode. */
export function sameQuestionScope(a: QuestionScope, b: QuestionScope): boolean {
  return (
    a.mode === b.mode &&
    (a.mode === "general" ||
      (idKey(a.setIds) === idKey(b.setIds) &&
        idKey(a.documentIds) === idKey(b.documentIds)))
  );
}
