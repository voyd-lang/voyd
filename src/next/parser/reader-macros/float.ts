import { Atom } from "../ast/atom.js";
import { ReaderMacro } from "./types.js";

const FLOAT = /^[+-]?\d+\.\d+(?:f64|f32)?$/;

export const floatMacro: ReaderMacro = {
  match: (t) => FLOAT.test(t.value),
  macro: (_, { token }) => {
    const floatType = token.value.endsWith("f32") ? "f32" : "f64";
    const value =
      token.value.at(-3) === "f" ? token.value.slice(0, -3) : token.value;

    return new Atom({ value, location: token.location })
      .setAttribute("isFloat", true)
      .setAttribute("floatType", floatType);
  },
};
