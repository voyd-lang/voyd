import { Expr } from "./expr.js";
import { Fn } from "./fn.js";
import { Syntax, SyntaxMetadata } from "./syntax.js";

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
    this.fns.forEach((fn) => (fn.parent = this));
  }

  toJSON() {
    return ["declare", this.namespace, this.fns];
  }

  clone(parent?: Expr) {
    return new Declaration({
      ...this.getCloneOpts(parent),
      namespace: this.namespace,
      fns: this.fns.map((fn) => fn.clone()),
    });
  }
}
