import { File } from "../../lib/file.js";
import { Expr, List } from "../../syntax-objects/index.js";
import { Token } from "../../lib/token.js";

export interface ReaderMacro {
  match: (token: Token, prev?: Token) => boolean;
  macro: (
    file: File,
    opts: {
      token: Token;
      reader: (file: File, terminator?: string, parent?: Expr) => List;
    }
  ) => Expr;
}
