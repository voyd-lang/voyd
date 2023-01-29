import { i32, f32, i64, f64, bool, dVoid } from "../../lib/index.mjs";
import { SyntaxMacro } from "../types.mjs";

export const initPrimitiveTypes: SyntaxMacro = (list) => {
  list.setType("i32", i32);
  list.setType("f32", f32);
  list.setType("i64", i64);
  list.setType("f64", f64);
  list.setType("bool", bool);
  list.setType("void", dVoid);
  return list;
};
