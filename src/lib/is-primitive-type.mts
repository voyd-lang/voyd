import { Expr, isIdentifier } from "./syntax.mjs";

export const CDT_ADDRESS_TYPE = "i32";

export const isPrimitiveType = (expr?: Expr) => {
  if (!isIdentifier(expr)) return false;
  return primitives.has(expr.value);
};

const primitives = new Set(["f64", "f32", "i64", "i32", "void"]);
