import { ReaderMacro } from "./types.mjs";

export const intMacro: ReaderMacro = {
  tag: /^[+-]?\d+$/,
  macro: (_, { token }) => parseInt(token),
};
