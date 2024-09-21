import { i32, f32, i64, f64, bool, dVoid } from "../syntax-objects/types.js";
import { voydBaseObject } from "../syntax-objects/types.js";
import { SemanticProcessor } from "./types.js";

export const initPrimitiveTypes: SemanticProcessor = (expr) => {
  if (!expr.isModule()) return expr;
  expr.registerExport(i32);
  expr.registerExport(f32);
  expr.registerExport(i64);
  expr.registerExport(f64);
  expr.registerExport(bool);
  expr.registerExport(dVoid);
  expr.registerExport(voydBaseObject);
  return expr;
};
