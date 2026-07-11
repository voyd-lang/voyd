import {
  isIdentifierAtom,
  isWhitespaceAtom,
  type Expr,
  type Form,
} from "../ast/index.js";
import { POSSIBLE_MISSING_BRACE_ENTRY_COMMA_ATTRIBUTE } from "../attributes.js";
import { ReaderMacro } from "./types.js";

export const objectLiteralMacro: ReaderMacro = {
  match: (t) => t.value === "{",
  macro: (dream, { reader }) => {
    const items = reader(dream, "}");
    markPossibleMissingCommas(items);
    return items.splitInto("object_literal");
  },
};

const markPossibleMissingCommas = (items: Form): void => {
  let colonCount = 0;
  let previous: Expr | undefined;

  items.toArray().forEach((entry) => {
    if (isWhitespaceAtom(entry) && entry.isNewline) {
      colonCount = 0;
      previous = undefined;
      return;
    }
    if (isIdentifierAtom(entry) && entry.value === ",") {
      colonCount = 0;
      previous = undefined;
      return;
    }
    if (isIdentifierAtom(entry) && entry.value === ":") {
      colonCount += 1;
      if (colonCount > 1 && isIdentifierAtom(previous)) {
        previous.attributes = {
          ...previous.attributes,
          [POSSIBLE_MISSING_BRACE_ENTRY_COMMA_ATTRIBUTE]: true,
        };
      }
    }
    if (!isWhitespaceAtom(entry)) previous = entry;
  });
};
