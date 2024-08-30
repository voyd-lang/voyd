import { Bool } from "../../syntax-objects/index.js";
import { ReaderMacro } from "./types.js";

export const booleanMacro: ReaderMacro = {
  match: (t) => /^true|false$/.test(t.value),
  macro: (_, { token }) =>
    new Bool({
      value: token.is("true"),
      location: token.location,
    }),
};
