import { ReaderMacro } from "./types.mjs";

export const floatMacro: ReaderMacro = {
  tag: /^[+-]?\d+\.\d+$/,
  macro: (_, token) => `/float${token}`,
};
