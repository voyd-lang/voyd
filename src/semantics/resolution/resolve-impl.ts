import { Implementation } from "../../syntax-objects/implementation.js";
import { getExprType } from "./get-expr-type.js";

export const resolveImpl = (impl: Implementation): Implementation => {
  const targetType = getExprType(impl.targetTypeExpr.value);
};
