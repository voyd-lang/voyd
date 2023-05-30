import { i32, f32, i64, f64, bool, dVoid } from "../../lib/index.mjs";
import { SyntaxMacro } from "../types.mjs";

export const initPrimitiveTypes: SyntaxMacro = (list) => {
  list.addType("i32", i32);
  list.addType("f32", f32);
  list.addType("i64", i64);
  list.addType("f64", f64);
  list.addType("bool", bool);
  list.addType("void", dVoid);
  return list;
};
