import {
  Form,
  isIdentifierAtom,
  isWhitespaceAtom,
  type Expr,
} from "../ast/index.js";
import { PossibleMissingCommaField } from "../surface/brace-entries.js";
import { ReaderMacro } from "./types.js";

export const objectLiteralMacro: ReaderMacro = {
  match: (t) => t.value === "{",
  macro: (dream, { reader }) => {
    const items = markPossibleMissingCommas(reader(dream, "}"));
    return items.splitInto("object_literal");
  },
};

const markPossibleMissingCommas = (items: Form): Form => {
  let colonCount = 0;
  let changed = false;
  let previous: Expr | undefined;
  let previousIndex = -1;
  const entries = items.toArray();

  entries.forEach((entry, index) => {
    if (isWhitespaceAtom(entry) && entry.isNewline) {
      colonCount = 0;
      previous = undefined;
      previousIndex = -1;
      return;
    }
    if (isIdentifierAtom(entry) && entry.value === ",") {
      colonCount = 0;
      previous = undefined;
      previousIndex = -1;
      return;
    }
    if (isIdentifierAtom(entry) && entry.value === ":") {
      colonCount += 1;
      if (colonCount > 1 && isIdentifierAtom(previous)) {
        const candidate = new PossibleMissingCommaField({
          location: previous.location?.clone(),
          value: previous.value,
        });
        candidate.isQuoted = previous.isQuoted;
        entries[previousIndex] = candidate;
        previous = candidate;
        changed = true;
      }
    }
    if (!isWhitespaceAtom(entry)) {
      previous = entry;
      previousIndex = index;
    }
  });
  return changed
    ? new Form({ location: items.location?.clone(), elements: entries })
    : items;
};
