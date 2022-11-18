import { ReaderMacro } from "./types.mjs";

export const typedParameterMacro: ReaderMacro = {
  tag: /^[^.\s:]+(:[^.\s:]+){1,2}$/g,
  macro: (_, token) => ["typed-parameter", ...token.split(":")],
};
