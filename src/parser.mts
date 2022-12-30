import { ModuleInfo } from "./lib/module-info.mjs";
import { Expr, Identifier, List } from "./lib/syntax.mjs";
import { Token } from "./lib/token.mjs";
import { File } from "./lib/file.mjs";
import { getReaderMacroForToken } from "./reader-macros/index.mjs";

export interface ParseOpts {
  nested?: boolean;
  terminator?: string;
  module: ModuleInfo;
}

export function parse(file: File, opts: ParseOpts): List {
  const list = newList(file);

  while (file.hasCharacters) {
    const token = lexer(file);

    const readerMacro = getReaderMacroForToken(token);

    if (readerMacro) {
      const result = readerMacro(file, {
        token,
        module: opts.module,
        reader: (file, terminator) =>
          parse(file, { nested: true, terminator, module: opts.module }),
      });
      if (typeof result !== "undefined") list.push(result);
      continue;
    }

    if (token.is("(")) {
      list.push(parse(file, { nested: true, module: opts.module }));
      continue;
    }

    if (token.is(")") || token.is(opts.terminator)) {
      if (opts.nested) break;
      continue;
    }

    list.push(identifier(token, file));
  }

  list.location!.endIndex = file.position;
  return list;
}

const lexer = (file: File): Token => {
  const token = new Token({
    line: file.line,
    index: file.position,
    column: file.column,
  });

  while (file.hasCharacters) {
    const char = file.next;

    // Ignore commas for now. They make a nice visual separator
    if (char === ",") {
      file.consume();
      continue;
    }

    // Handle real numbers
    if (char === "." && token.isNumber) {
      token.addChar(file.consume());
      continue;
    }

    const isTerminator = /[\{\[\(\}\]\)\s\.\;\:\'\"]/.test(char);

    if (isTerminator && (token.first === "#" || !token.hasChars)) {
      token.addChar(file.consume());
      break;
    }

    if (isTerminator) {
      break;
    }

    token.addChar(file.consume());
  }

  token.endIndex = file.position;
  return token;
};

function newList(file: File) {
  return new List({
    location: {
      line: file.line,
      startIndex: file.line,
      column: file.column,
      endIndex: 0,
      filePath: file.filePath,
    },
  });
}

function identifier(token: Token, file: File): Expr {
  return new Identifier({
    value: token.value,
    location: {
      filePath: file.filePath,
      line: token.line,
      column: token.column,
      startIndex: token.startIndex,
      endIndex: token.endIndex,
    },
  });
}
