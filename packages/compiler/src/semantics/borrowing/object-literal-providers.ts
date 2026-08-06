import type { HirExpression } from "../hir/index.js";
import type { HirExprId } from "../ids.js";

type ObjectLiteralExpression = Extract<
  HirExpression,
  { exprKind: "object-literal" }
>;

export const objectLiteralFieldProvider = ({
  expression,
  field,
  spreadProvidesField,
}: {
  expression: ObjectLiteralExpression;
  field: string;
  spreadProvidesField: (value: HirExprId) => boolean;
}): ObjectLiteralExpression["entries"][number] | undefined =>
  expression.entries.reduce<
    ObjectLiteralExpression["entries"][number] | undefined
  >((selected, candidate) => {
    if (candidate.kind === "field" && candidate.name === field) {
      return candidate;
    }
    if (candidate.kind !== "spread") {
      return selected;
    }
    return spreadProvidesField(candidate.value) ? candidate : selected;
  }, undefined);
