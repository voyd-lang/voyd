import { ReaderMacro } from "./types.mjs";

export const booleanMacro: ReaderMacro = {
  tag: /^true|false$/,
  macro: (_, { token }) => token === "true",
};
