import { Expr } from "./expr.js";
import { Fn } from "./fn.js";
import { Identifier } from "./identifier.js";
import { ChildList } from "./lib/child-list.js";
import { Child } from "./lib/child.js";
import { LexicalContext } from "./lib/lexical-context.js";
import { List } from "./list.js";
import { Syntax, SyntaxMetadata } from "./syntax.js";
import { ObjectType, Type } from "./types.js";

/** Defines a function call */
export class Call extends Syntax {
  readonly syntaxType = "call";
  fn?: Fn | ObjectType;
  #fnName: Child<Identifier>;
  #args: Child<List>;
  #typeArgs = new Child<List | undefined>(undefined, this);
  #type?: Type;

  constructor(
    opts: SyntaxMetadata & {
      fnName: Identifier;
      fn?: Fn;
      args: List;
      type?: Type;
      lexicon?: LexicalContext;
      typeArgs?: List;
    }
  ) {
    super(opts);
    this.#fnName = new Child(opts.fnName, this);
    this.fn = opts.fn;
    this.#args = new Child(opts.args, this);
    this.typeArgs = opts.typeArgs;
    if (this.typeArgs) this.typeArgs.parent = this;
    this.#type = opts.type;
  }

  get args() {
    return this.#args.value;
  }

  set args(v: List) {
    this.#args.value = v;
  }

  get typeArgs() {
    return this.#typeArgs.value;
  }

  set typeArgs(v: List | undefined) {
    this.#typeArgs.value = v;
  }

  get fnName() {
    return this.#fnName.value;
  }

  set fnName(v: Identifier) {
    this.#fnName.value = v;
  }

  get children() {
    return [...this.args.toArray(), ...(this.typeArgs?.toArray() ?? [])];
  }

  set type(type: Type | undefined) {
    this.#type = type;
  }

  get type() {
    if (!this.#type && this.fn?.isFn()) {
      this.#type = this.fn.returnType;
    }

    if (!this.#type && this.fn?.isObjectType()) {
      this.#type = this.fn;
    }

    return this.#type;
  }

  getType(): Type | undefined {
    return this.type;
  }

  eachArg(fn: (expr: Expr) => void) {
    this.args.each(fn);
    return this;
  }

  argAt(index: number) {
    return this.args.at(index);
  }

  argsWithLabel(label: string) {
    return this.args.argsWithLabel(label);
  }

  exprArgAt(index: number): Expr {
    const expr = this.argAt(index);

    if (!expr) {
      throw new Error(`No expression found at ${index}`);
    }

    return expr;
  }

  /**
   * Returns the expression for the labeled argument at the given zero-based
   * position (same semantics as the previous implementation). Prefer
   * `getLabeledArg` when possible.
   */
  labeledArgAt(index: number): Expr {
    const labelExpr = this.args.at(index);
    if (!labelExpr?.isCall() || !labelExpr.calls(":")) {
      throw new Error(`No label found at ${index}`);
    }
    return labelExpr.exprArgAt(1);
  }

  /** Returns the expression associated with a label, e.g. `world` in
   * `hello(world: 1)`.  Undefined when the label is not present. */
  optionalLabeledArg(label: string): Expr | undefined {
    return this.args.optionalLabeledArg(label);
  }

  labeledArg(label: string): Expr {
    return this.args.labeledArg(label);
  }

  optionalLabeledArgAt(index: number): Expr | undefined {
    try {
      return this.labeledArgAt(index);
    } catch {
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

  argsArray(): Expr[] {
    return this.args.toArray();
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
      fnName: this.fnName.clone(),
      args: this.args.clone(),
      typeArgs: this.typeArgs?.clone(),
    });
  }
}
