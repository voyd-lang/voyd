import { ReaderMacro } from "./types";

export const intMacro: ReaderMacro = {
  tag: /^[+-]?\d+$/,
  macro: (_, token) => ["int", token],
};
