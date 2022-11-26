import { ModuleInfo } from "../lib/module-info.mjs";
import { Expr } from "../parser.mjs";

export interface ReaderMacro {
  tag: string | RegExp;
  macro: (
    dream: string[],
    opts: {
      token: string;
      reader: (dream: string[], terminator?: string) => Expr;
      module: ModuleInfo;
    }
  ) => Expr | undefined;
}
