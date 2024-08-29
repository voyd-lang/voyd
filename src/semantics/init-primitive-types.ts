import { i32, f32, i64, f64, bool, dVoid } from "../syntax-objects/types.js";
import { TypeChecker } from "./types";

export const initPrimitiveTypes: TypeChecker = (expr) => {
  expr.registerEntity(i32);
  expr.registerEntity(f32);
  expr.registerEntity(i64);
  expr.registerEntity(f64);
  expr.registerEntity(bool);
  expr.registerEntity(dVoid);
  return expr;
};
