import { Expr } from "../parser.mjs";
import { toIdentifier } from "./to-identifier.mjs";

export const CDT_ADDRESS_TYPE = "i32";

export const isPrimitiveType = (expr?: Expr) => {
  if (typeof expr !== "string") return false;
  return primitives.has(toIdentifier(expr));
};

const primitives = new Set(["f64", "f32", "i64", "i32", "void"]);
