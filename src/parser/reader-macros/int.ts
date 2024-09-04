import { Int } from "../../syntax-objects/index.js";
import { ReaderMacro } from "./types.js";

export const intMacro: ReaderMacro = {
  match: (t) => /^[+-]?\d+n?$/.test(t.value),
  macro: (_, { token }) => {
    const value = token.value.endsWith("n")
      ? ({ type: "i64", value: BigInt(token.value.slice(0, -1)) } as const)
      : Number(token.value);

    return new Int({ value, location: token.location });
  },
};
