import { Int } from "../syntax-objects/index.mjs";
import { ReaderMacro } from "./types.mjs";

export const intMacro: ReaderMacro = {
  match: (t) => /^[+-]?\d+$/.test(t.value),
  macro: (_, { token }) =>
    new Int({
      value: Number(token.value),
      location: token.location,
    }),
};
