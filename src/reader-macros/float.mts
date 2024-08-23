import { Float } from "../syntax-objects/index.mjs";
import { ReaderMacro } from "./types.mjs";

export const floatMacro: ReaderMacro = {
  match: (t) => /^[+-]?\d+\.\d+$/.test(t.value),
  macro: (_, { token }) =>
    new Float({
      value: Number(token.value),
      location: token.location,
    }),
};
