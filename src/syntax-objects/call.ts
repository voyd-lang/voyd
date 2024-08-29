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
      type?: Type;
    }
  ) {
    super(opts);
    this.fnName = opts.fnName;
    this.fn = opts.fn;
    this.args = opts.args;
    this.type = opts.type;
    opts.args.parent = this;
  }

  eachArg(fn: (expr: Expr) => void) {
    this.args.each(fn);
    return this;
  }

  argAt(index: number) {
    return this.args.at(index);
  }

  exprArgAt(index: number): Expr {
    const expr = this.argAt(index);

    if (!expr) {
      throw new Error(`No expression found at ${index}`);
    }

    return expr;
  }

  // Returns the value of the labeled argument at the given index
  labeledArgAt(index: number): Expr {
    const label = this.args.at(index);

    if (!label?.isCall() || !label?.calls(":")) {
      throw new Error(`No label found at ${index}`);
    }

    return label.exprArgAt(1);
  }

  // Returns the value of the labeled argument at the given index
  optionalLabeledArgAt(index: number): Expr | undefined {
    try {
      return this.labeledArgAt(index);
    } catch (_e) {
      return undefined;
    }
  }

  callArgAt(index: number): Call {
    const call = this.args.at(index);
    if (!call?.isCall()) {
      throw new Error(`No call at ${index}`);
    }
    return call;
  }

  identifierArgAt(index: number): Identifier {
    const call = this.args.at(index);
    if (!call?.isIdentifier()) {
      throw new Error(`No identifier at ${index}`);
    }
    return call;
  }

  argArrayMap<T>(fn: (expr: Expr) => T): T[] {
    return this.args.toArray().map(fn);
  }

  calls(name: string) {
    return this.fnName.is(name);
  }

  toJSON() {
    return [this.fnName, ...this.args.toArray()];
  }

  clone(parent?: Expr) {
    return new Call({
      ...this.getCloneOpts(parent),
      fnName: this.fnName,
      args: this.args,
    });
  }
}
