import { Expr, Identifier, List, Whitespace } from "./lib/syntax/index.mjs";
import { Token } from "./lib/token.mjs";
import { File } from "./lib/file.mjs";
import { getReaderMacroForToken } from "./reader-macros/index.mjs";
import {
  isDigit,
  isDigitSign,
  isOpChar,
  isTerminatingOpChar,
  isTerminator,
  isWhitespace,
} from "./lib/grammar.mjs";

export interface ParseOpts {
  nested?: boolean;
  terminator?: string;
  parent?: Expr;
}

export function parse(file: File, opts: ParseOpts = {}): List {
  const list = new List({
    location: {
      startIndex: file.position,
      endIndex: 0,
      line: file.line,
      column: file.column,
      filePath: file.filePath,
    },
    parent: opts.parent,
  });

  while (file.hasCharacters) {
    const token = lexer(file);

    const readerMacro = getReaderMacroForToken(token);

    if (readerMacro) {
      const result = readerMacro(file, {
        token,
        reader: (file, terminator, parent) =>
          parse(file, {
            nested: true,
            terminator,
            parent: parent ?? opts.parent,
          }),
      });
      if (typeof result !== "undefined") list.push(result);
      continue;
    }

    if (token.is("(")) {
      list.push(parse(file, { nested: true }));
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
    line: file.line,
    column: file.column,
    startIndex: file.position,
    endIndex: 0,
    filePath: file.filePath,
  });

  while (file.hasCharacters) {
    const char = file.next;

    // Skip comma's (for now)
    if (!token.hasChars && char === ",") {
      file.consumeChar();
      continue;
    }

    if (!token.hasChars && nextIsNumber(file)) {
      consumeNumber(file, token);
      break;
    }

    if (!token.hasChars && isTerminatingOpChar(char)) {
      consumeTerminatingOp(file, token);
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

    if (isTerminator(char)) {
      break;
    }

    token.addChar(file.consumeChar());
  }

  token.location.endIndex = file.position;
  return token;
};

const consumeTerminatingOp = (file: File, token: Token) => {
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
