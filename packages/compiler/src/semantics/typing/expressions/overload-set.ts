import type { HirExpression } from "../../hir/index.js";
import type { TypeId } from "../../ids.js";
import type { TypingContext } from "../types.js";

export const typeOverloadSetExpr = (
  expr: HirExpression & {
    exprKind: "overload-set";
    name: string;
    set: number;
  },
  _ctx: TypingContext
): TypeId => {
  throw new Error(
    `overload set ${expr.name} cannot be used outside of a call expression`
  );
};
