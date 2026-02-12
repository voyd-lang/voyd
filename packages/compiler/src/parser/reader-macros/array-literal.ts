import {
  Expr,
  Form,
  isCommentAtom,
  isIdentifierAtom,
  isWhitespaceAtom,
  call,
  label,
  surfaceCall,
} from "../ast/index.js";
import { isOp } from "../grammar.js";
import { Token } from "../token.js";
import { ReaderMacro } from "./types.js";

export const arrayLiteralMacro: ReaderMacro = {
  match: (t) => t.value === "[",
  macro: (file, { reader, previous, token }) => {
    const items = reader(file, "]");
    if (shouldParseAsSubscript({ token, previous })) {
      return call("subscript", previous!, normalizeSubscriptIndex(items));
    }
    return surfaceCall(
      "new_array_unchecked",
      label("from", items.splitInto("fixed_array_literal"))
    );
  },
};

const RANGE_ONLY_OPERATORS = new Set(["..", "..=", "..<"]);

const normalizeSubscriptIndex = (items: Form): Expr => {
  const unwrapped = items.unwrap();
  if (
    isIdentifierAtom(unwrapped) &&
    RANGE_ONLY_OPERATORS.has(unwrapped.value)
  ) {
    return new Form([unwrapped, new Form()]);
  }
  return unwrapped;
};

const shouldParseAsSubscript = ({
  token,
  previous,
}: {
  token: Token;
  previous?: Expr;
}): boolean => {
  if (!previous?.location) {
    return false;
  }
  if (isWhitespaceAtom(previous) || isCommentAtom(previous)) {
    return false;
  }
  if (isIdentifierAtom(previous) && isOp(previous)) {
    return false;
  }
  return previous.location.endIndex === token.location.startIndex;
};
