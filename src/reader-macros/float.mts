import { ReaderMacro } from "./types";

export const floatMacro: ReaderMacro = {
  tag: /^[+-]?\d+\.\d+$/,
  macro: (_, token) => ["float", token],
};
