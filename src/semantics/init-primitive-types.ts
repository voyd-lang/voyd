import { i32, f32, i64, f64, bool, dVoid } from "../syntax-objects/types.js";
import { SemanticProcessor } from "./types.js";

export const initPrimitiveTypes: SemanticProcessor = (expr) => {
  expr.registerEntity(i32);
  expr.registerEntity(f32);
  expr.registerEntity(i64);
  expr.registerEntity(f64);
  expr.registerEntity(bool);
  expr.registerEntity(dVoid);
  return expr;
};
