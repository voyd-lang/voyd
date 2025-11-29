import { CharStream } from "../char-stream.js";
import { Expr, List } from "../../syntax-objects/index.js";
import { Token } from "../token.js";

export interface ReaderMacro {
  match: (token: Token, prev?: Expr, nextChar?: string) => boolean;
  macro: (
    file: CharStream,
    opts: {
      token: Token;
      reader: (file: CharStream, terminator?: string) => List;
    }
  ) => Expr | undefined;
}
