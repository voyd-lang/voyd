import { File } from "../lib/file.mjs";
import { ModuleInfo } from "../lib/module-info.mjs";
import { List, Syntax } from "../lib/syntax.mjs";
import { Token } from "../lib/token.mjs";

export interface ReaderMacro {
  tag: string | RegExp;
  macro: (
    file: File,
    opts: {
      token: Token;
      reader: (file: File, terminator?: string, parent?: Syntax) => List;
      module: ModuleInfo;
    }
  ) => Syntax;
}
