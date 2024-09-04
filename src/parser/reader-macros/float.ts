import { Float, Int } from "../../syntax-objects/index.js";
import { ReaderMacro } from "./types.js";

export const floatMacro: ReaderMacro = {
  match: (t) => /^[+-]?\d+\.\d+n?$/.test(t.value),
  macro: (_, { token }) => {
    const value = token.value.endsWith("n")
      ? ({ type: "f64", value: Number(token.value.slice(0, -1)) } as const)
      : Number(token.value);

    return new Float({ value, location: token.location });
  },
};
