import { Expr } from "./expr.mjs";
import { Fn } from "./fn.mjs";
import { Identifier } from "./identifier.mjs";
import { List } from "./list.mjs";
import { Syntax, SyntaxMetadata } from "./syntax.mjs";
import { Type } from "./types.mjs";

/** Defines a declared namespace for external function imports */
export class Declaration extends Syntax {
  readonly syntaxType = "declaration";
  namespace: string;
  fns: Fn[];

  constructor(
    opts: SyntaxMetadata & {
      namespace: string;
      fns?: Fn[];
    }
  ) {
    super(opts);
    this.namespace = opts.namespace;
    this.fns = opts.fns ?? [];
  }

  toJSON() {
    return ["declare", this.namespace, this.fns];
  }

  clone(parent?: Expr) {
    return new Declaration({
      ...this.getCloneOpts(parent),
      namespace: this.namespace,
      fns: this.fns,
    });
  }
}
