import { Float } from "../syntax-objects/index.mjs";
import { ReaderMacro } from "./types.mjs";

export const floatMacro: ReaderMacro = {
  tag: /^[+-]?\d+\.\d+$/,
  macro: (_, { token }) =>
    new Float({
      value: Number(token.value),
      location: token.location,
    }),
};
