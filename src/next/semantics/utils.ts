import type { Expr, IdentifierAtom, Syntax } from "../parser/index.js";
import { isIdentifierAtom } from "../parser/index.js";
import type { SourceSpan } from "./ids.js";

export const isIdentifierWithValue = (
  expr: Expr | undefined,
  value: string
): expr is IdentifierAtom => isIdentifierAtom(expr) && expr.value === value;

export const toSourceSpan = (syntax?: Syntax): SourceSpan => {
  const location = syntax?.location;
  if (!location) {
    return { file: "<unknown>", start: 0, end: 0 };
  }
  return {
    file: location.filePath,
    start: location.startIndex,
    end: location.endIndex,
  };
};
