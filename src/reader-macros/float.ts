import { Float } from "../syntax-objects/index.js";
import { ReaderMacro } from "./types.js";

export const floatMacro: ReaderMacro = {
  match: (t) => /^[+-]?\d+\.\d+$/.test(t.value),
  macro: (_, { token }) =>
    new Float({
      value: Number(token.value),
      location: token.location,
    }),
};
