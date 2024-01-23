import { File } from "../lib/file.mjs";
import { Expr, List } from "../syntax-objects/index.mjs";
import { Token } from "../lib/token.mjs";

export interface ReaderMacro {
  tag: string | RegExp;
  macro: (
    file: File,
    opts: {
      token: Token;
      reader: (file: File, terminator?: string, parent?: Expr) => List;
    }
  ) => Expr;
}
