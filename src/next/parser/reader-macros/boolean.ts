import { Atom } from "../ast/atom.js";
import { ReaderMacro } from "./types.js";

export const booleanMacro: ReaderMacro = {
  match: (t) => t.value === "true" || t.value === "false",
  macro: (_, { token }) => token.toAtom().setAttribute("isBool", true),
};
