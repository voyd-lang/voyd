import { List, Expr, Identifier } from "./syntax.mjs";
import { Token } from "./token.mjs";
import { File } from "./file.mjs";

export function newToken(value: string, file: File) {
  return new Token({
    line: file.line,
    startIndex: file.position,
    endIndex: 0,
    column: file.column,
    filePath: file.filePath,
    value,
  });
}

export function newList(file: File) {
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

export function newIdentifier(token: Token): Expr {
  return new Identifier({
    value: token.value,
    location: token.location,
  });
}
