import { isCyclic } from "../helpers.mjs";
import type { Expr } from "./expr.mjs";
import type { Id } from "./identifier.mjs";
import { LexicalContext, Var } from "./lexical-context.mjs";
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

export type SyntaxOpts = {
  location?: SourceLocation;
  from?: Syntax;
  parent?: Expr;
};

export abstract class Syntax {
  protected isFn?: boolean;
  private fnVarIndex = 0;
  readonly id = getSyntaxId();
  readonly location?: SourceLocation;
  readonly context: LexicalContext;
  readonly props: Map<string, Expr> = new Map();
  readonly flags: Set<string> = new Set();
  private allFnParams: Var[] = [];
  private allFnVars: Var[] = [];
  private parent?: Expr;
  protected type?: Type;
  // Typescript can't discriminate between types via instanceof without this for some reason
  abstract readonly __type: string;
  abstract value: any;

  constructor({ location, from, parent }: SyntaxOpts) {
    this.location = location ?? from?.location;
    this.parent = parent ?? from?.getParent();
    this.context = from?.context ?? new LexicalContext();
  }

  setFn(id: Id, fn: FnType) {
    this.context.setFn(id, fn);
    return this;
  }

  getFns(id: Id): FnType[] | undefined {
    return this.context.getFns(id) ?? this.parent?.getFns(id);
  }

  setVar(id: Id, v: Omit<Var, "index">) {
    const val: Var = {
      ...v,
      index: v.kind !== "global" ? this.getNewVarIndex() : 0,
    };
    this.context.setVar(id, val);
    this.registerVarWithParentFn(val);
    return this;
  }

  getVar(id: Id): Var | undefined {
    return this.context.getVar(id) ?? this.parent?.getVar(id);
  }

  setType(id: Id, val: Type) {
    this.context.setType(id, val);
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

  getAllFnParams(): Var[] {
    if (this.isFn) {
      return this.allFnParams;
    }

    if (this.parent) {
      return this.parent.getAllFnParams();
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

  private registerVarWithParentFn(v: Var) {
    if (v.kind === "global") return;

    if (this.isFn && v.kind === "var") {
      this.allFnVars.push(v);
      return;
    }

    if (this.isFn && v.kind === "param") {
      this.allFnParams.push(v);
      return;
    }

    this.parent?.registerVarWithParentFn(v);
  }

  private getNewVarIndex(): number {
    if (this.isFn) {
      const cur = this.fnVarIndex;
      this.fnVarIndex += 1;
      return cur;
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
