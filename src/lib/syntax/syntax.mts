import type { Expr } from "./expr.mjs";
import type { Id } from "./identifier.mjs";
import { LexicalContext, Var } from "./lexical-context.mjs";
import type { List } from "./list.mjs";
import type { FnType, Type } from "./types.mjs";

export type SourceLocation = {
  /** The exact character index the syntax starts */
  startIndex: number;
  /** The exact character index the syntax ends */
  endIndex: number;
  /** The line the syntax is located in */
  line: number;
  /** The column within the line the syntax begins */
  column: number;

  filePath: string;
};

export type SyntaxComparable = Expr | string | number | boolean;

export type SyntaxOpts<T = any> = {
  location?: SourceLocation;
  inherit?: Syntax;
  parent?: Expr;
  isFn?: boolean;
  value?: T;
};

export abstract class Syntax {
  protected isFn?: boolean;
  readonly id = getSyntaxId();
  readonly location?: SourceLocation;
  readonly context: LexicalContext;
  readonly props: Map<string, Expr> = new Map();
  readonly flags: Set<string> = new Set();
  private allFnVars: Var[] = [];
  private parent?: Expr;
  protected type?: Type;
  // Typescript can't discriminate between types via instanceof without this for some reason
  abstract readonly __type: string;
  abstract value: any;

  constructor({ location, inherit: from, parent, isFn }: SyntaxOpts) {
    this.location = location ?? from?.location;
    this.parent = parent ?? from?.getParent();
    this.context = from?.context ?? new LexicalContext();
    this.isFn = isFn ?? from?.isFn;
    this.type = from?.type;
    // NOTE: For now we intentionally do not clone allFnVars so code gen can get up to date indexes by manually setting the vars
  }

  get parentFn(): List | undefined {
    return this.isFn ? (this as unknown as List) : this.parent?.parentFn;
  }

  addFn(id: Id, fn: FnType) {
    this.context.addFn(id, fn);
    return this;
  }

  getFns(id: Id, start: FnType[] = []): FnType[] {
    start.push(...this.context.getFns(id));
    if (this.parent) return this.parent.getFns(id, start);
    return start;
  }

  addVar(id: Id, v: Omit<Var, "index">) {
    const val: Var = {
      ...v,
      index: v.kind !== "global" ? this.getNewVarIndex() : 0,
    };
    this.context.addVar(id, val);
    this.registerVarWithParentFn(val);
    return val;
  }

  getVar(id: Id): Var | undefined {
    return this.context.getVar(id) ?? this.parent?.getVar(id);
  }

  addType(id: Id, val: Type) {
    this.context.addType(id, val);
    return this;
  }

  getType(id: Id): Type | undefined {
    return this.context.getType(id) ?? this.parent?.getType(id);
  }

  getTypeOf(): Type | undefined {
    return this.type;
  }

  setTypeOf(type: Type) {
    this.type = type;
    return this;
  }

  is(val?: SyntaxComparable) {
    if (val instanceof Syntax) {
      return val.value === this.value;
    }

    return val === this.value;
  }

  getParent() {
    return this.parent;
  }

  setParent(parent?: Expr) {
    this.parent = parent;
    return this;
  }

  getAllFnVars(): Var[] {
    if (this.isFn) {
      return this.allFnVars;
    }

    if (this.parent) {
      return this.parent.getAllFnVars();
    }

    throw new Error("Not in a function.");
  }

  /** Marks this as a function definition */
  setAsFn() {
    this.isFn = true;
    return this;
  }

  toJSON() {
    return this.value;
  }

  abstract clone(parent?: Expr): Expr;

  private registerVarWithParentFn(v: Var) {
    if (v.kind === "global") return;

    if (this.isFn) {
      this.allFnVars.push(v);
      return;
    }

    this.parent?.registerVarWithParentFn(v);
  }

  private getNewVarIndex(): number {
    if (this.isFn) {
      return this.allFnVars.length;
    }

    if (!this.parent) {
      throw new Error("Not in a function");
    }

    return this.parent.getNewVarIndex();
  }
}

let currentSyntaxId = 0;
const getSyntaxId = () => {
  const current = currentSyntaxId;
  currentSyntaxId += 1;
  return current;
};
