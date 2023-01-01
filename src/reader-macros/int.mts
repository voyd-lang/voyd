import { Float } from "../lib/syntax/index.mjs";
import { ReaderMacro } from "./types.mjs";

export const intMacro: ReaderMacro = {
  tag: /^[+-]?\d+$/,
  macro: (_, { token }) =>
    new Float({
      value: Number(token.value),
      location: token.location,
    }),
};
