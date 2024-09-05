import { Float } from "../../syntax-objects/index.js";
import { ReaderMacro } from "./types.js";

export const floatMacro: ReaderMacro = {
  match: (t) => /^[+-]?\d+\.\d+(?:f64|f32)?$/.test(t.value),
  macro: (_, { token }) => {
    const value =
      token.value.at(-3) === "f"
        ? token.value.endsWith("f64")
          ? ({ type: "f64", value: Number(token.value.slice(0, -3)) } as const)
          : Number(token.value.slice(0, -3))
        : ({ type: "f64", value: Number(token.value) } as const); // Default to f64

    return new Float({ value, location: token.location });
  },
};
