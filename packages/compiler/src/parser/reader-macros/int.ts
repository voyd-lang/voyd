import { Int } from "../../syntax-objects/index.js";
import { ReaderMacro } from "./types.js";

const INT = /^[+-]?\d+(?:i64|i32)?$/;

export const intMacro: ReaderMacro = {
  match: (t) => INT.test(t.value),
  macro: (_, { token }) => {
    const value =
      token.value.at(-3) === "i"
        ? token.value.endsWith("i64")
          ? ({
              type: "i64",
              value: BigInt(token.value.slice(0, -3)),
            } as const)
          : Number(token.value.slice(0, -3))
        : Number(token.value); // Default to i32

    return new Int({ value, location: token.location });
  },
};
