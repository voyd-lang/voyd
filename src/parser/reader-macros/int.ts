import { Int } from "../../syntax-objects/index.js";
import { ReaderMacro } from "./types.js";

export const intMacro: ReaderMacro = {
  match: (t) => /^[+-]?\d+$/.test(t.value),
  macro: (_, { token }) =>
    new Int({
      value: Number(token.value),
      location: token.location,
    }),
};
