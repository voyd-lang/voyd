import { Expr, Identifier, List, Whitespace } from "./syntax-objects/index.js";
import { Token } from "./lib/token.js";
import { File } from "./lib/file.js";
import { getReaderMacroForToken } from "./reader-macros/index.js";
import {
  isDigit,
  isDigitSign,
  isTerminator,
  isWhitespace,
  isOpChar,
} from "./lib/grammar.js";

export interface ParseOpts {
  nested?: boolean;
  terminator?: string;
  parent?: Expr;
}

export function parse(file: File, opts: ParseOpts = {}): List {
  const list = new List({
    location: file.currentSourceLocation(),
    parent: opts.parent,
    value: !opts.nested ? ["ast", ","] : [],
  });

  let prev: Token | undefined = undefined;
  let cur: Token | undefined = undefined;
  while (file.hasCharacters) {
    const token = lexer(file);
    prev = cur;
    cur = token;

    if (processWithReaderMacro(token, prev, file, opts, list)) {
      continue;
    }

    if (token.is("(")) {
      const subList = parse(file, { nested: true });
      subList.mayBeTuple = true;
      list.push(subList);
      continue;
    }

    if (token.is(")") || token.is(opts.terminator)) {
      if (opts.nested) break;
      continue;
    }

    if (token.isWhitespace) {
      list.push(
        new Whitespace({
          value: token.value,
          location: token.location,
        })
      );
      continue;
    }

    list.push(
      new Identifier({
        value: token.value,
        location: token.location,
      })
    );
  }

  list.location!.endIndex = file.position;
  return list;
}

const lexer = (file: File): Token => {
  const token = new Token({
    location: file.currentSourceLocation(),
  });

  while (file.hasCharacters) {
    const char = file.next;

    if (!token.hasChars && char === " ") {
      consumeSpaces(file, token);
      break;
    }

    if (!token.hasChars && nextIsNumber(file)) {
      consumeNumber(file, token);
      break;
    }

    if (!token.hasChars && isOpChar(char)) {
      consumeOperator(file, token);
      break;
    }

    if (!token.hasChars && isTerminator(char)) {
      token.addChar(file.consumeChar());
      break;
    }

    // Support sharp identifiers (Used by reader macros ignores non-whitespace terminators)
    if (token.first === "#" && !isWhitespace(char)) {
      token.addChar(file.consumeChar());
      continue;
    }

    if (char === "\t") {
      throw new Error(
        "Tabs are not supported, use four spaces for indentation"
      );
    }

    if (isTerminator(char)) {
      break;
    }

    token.addChar(file.consumeChar());
  }

  token.location.endIndex = file.position;
  return token;
};

const consumeOperator = (file: File, token: Token) => {
  while (isOpChar(file.next)) {
    token.addChar(file.consumeChar());
  }
};

const consumeNumber = (file: File, token: Token) => {
  const isValidNumber = (str: string) =>
    /^[+-]?\d*(\.\d+)?[Ee]?[+-]?\d*$/.test(str);
  const stillConsumingNumber = () =>
    file.next &&
    (isValidNumber(token.value + file.next) ||
      isValidNumber(token.value + file.next + file.at(1)));

  while (stillConsumingNumber()) {
    token.addChar(file.consumeChar());
  }
};

const nextIsNumber = (file: File) =>
  isDigit(file.next) || (isDigitSign(file.next) && isDigit(file.at(1) ?? ""));

const consumeSpaces = (file: File, token: Token) => {
  while (file.next === " " && token.span < 2) {
    token.addChar(file.consumeChar());
  }
};

/** Returns true if token was matched with and processed by a macro  */
const processWithReaderMacro = (
  token: Token,
  prev: Token | undefined,
  file: File,
  opts: ParseOpts,
  list: List
) => {
  const readerMacro = getReaderMacroForToken(token, prev);
  if (!readerMacro) return undefined;

  const result = readerMacro(file, {
    token,
    reader: (file, terminator, parent) =>
      parse(file, {
        nested: true,
        terminator,
        parent: parent ?? opts.parent,
      }),
  });

  if (!result) return undefined;

  list.push(result);
  return true;
};
