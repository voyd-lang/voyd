import { Expr } from "./expr.mjs";
import { Identifier } from "./identifier.mjs";
import { List } from "./list.mjs";
import { Syntax, SyntaxMetadata } from "./syntax.mjs";
import { Type } from "./types.mjs";

/** Defines a function call */
export class Call extends Syntax {
  readonly syntaxType = "call";
  fnId?: string;
  fnName: Identifier;
  args: List;

  constructor(
    opts: SyntaxMetadata & {
      fnName: Identifier;
      fnId?: string;
      args: List;
    }
  ) {
    super(opts);
    this.fnName = opts.fnName;
    this.fnId = opts.fnId;
    this.args = opts.args;
  }

  get type(): Type {
    if (!this.fnId) {
      throw new Error("Could not resolve return type of fn call");
    }
    const type = this.resolveFnById(this.fnId)?.getReturnType();
    if (!type) {
      throw new Error(`Could not resolve return type of ${this.fnName}`);
    }
    return type;
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
