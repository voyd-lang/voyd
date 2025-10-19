import { Atom } from "../ast/atom.js";
import { ReaderMacro } from "./types.js";

const INT = /^[+-]?\d+(?:i64|i32)?$/;

export const intMacro: ReaderMacro = {
  match: (t) => INT.test(t.value),
  macro: (_, { token }) => {
    const intType = token.value.endsWith("i64") ? "i64" : "i32";
    const value =
      token.value.at(-3) === "i" ? token.value.slice(0, -3) : token.value;

    return new Atom({ value, location: token.location })
      .setAttribute("isFloat", true)
      .setAttribute("intType", intType);
  },
};
