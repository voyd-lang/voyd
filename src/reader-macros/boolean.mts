import { Bool } from "../syntax-objects/index.mjs";
import { ReaderMacro } from "./types.mjs";

export const booleanMacro: ReaderMacro = {
  match: (t) => /^true|false$/.test(t.value),
  macro: (_, { token }) =>
    new Bool({
      value: token.is("true"),
      location: token.location,
    }),
};
