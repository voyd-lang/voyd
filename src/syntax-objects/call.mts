import { Expr } from "./expr.mjs";
import { Fn } from "./fn.mjs";
import { Identifier } from "./identifier.mjs";
import { List } from "./list.mjs";
import { Syntax, SyntaxMetadata } from "./syntax.mjs";
import { Type } from "./types.mjs";

/** Defines a function call */
export class Call extends Syntax {
  readonly syntaxType = "call";
  fn?: Fn;
  fnName: Identifier;
  args: List;
  type?: Type;

  constructor(
    opts: SyntaxMetadata & {
      fnName: Identifier;
      fn?: Fn;
      args: List;
    }
  ) {
    super(opts);
    this.fnName = opts.fnName;
    this.fn = opts.fn;
    this.args = opts.args;
  }

  eachArg(fn: (expr: Expr) => void) {
    this.args.each(fn);
    return this;
  }

  argAt(index: number) {
    return this.args.at(index);
  }

  callArgAt(index: number): Call {
    const call = this.args.at(index);
    if (!call?.isCall()) {
      throw new Error(`No call at ${index}`);
    }
    return call;
  }

  calls(name: string) {
    return this.fnName.is(name);
  }

  toJSON() {
    return [this.fnName, ...this.args.value];
  }

  clone(parent?: Expr) {
    return new Call({
      ...this.getCloneOpts(parent),
      fnName: this.fnName,
      args: this.args,
    });
  }
}
