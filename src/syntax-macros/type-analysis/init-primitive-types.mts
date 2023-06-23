import { i32, f32, i64, f64, bool, dVoid } from "../../lib/index.mjs";
import { SyntaxMacro } from "../types.mjs";

export const initPrimitiveTypes: SyntaxMacro = (list) => {
  list.registerEntity(i32);
  list.registerEntity(f32);
  list.registerEntity(i64);
  list.registerEntity(f64);
  list.registerEntity(bool);
  list.registerEntity(dVoid);
  return list;
};
