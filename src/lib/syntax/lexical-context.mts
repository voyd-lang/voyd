import type { Expr } from "./expr.mjs";
import { getIdStr } from "./get-id-str.mjs";
import type { Id } from "./identifier.mjs";
import type { FnType, Type } from "./types.mjs";

export type Var = {
  mut?: boolean;
  type?: Type;
  kind: "var" | "param" | "global";
  /** For macro expansion phase */
  value?: Expr;
  // Not relevant for globals.
  index: number;
};

export class LexicalContext {
  private isFn?: boolean;
  private fnVarIndex = 0;
  private parent?: LexicalContext;
  private fns: Map<string, FnType[]> = new Map();
  private vars: Map<string, Var> = new Map();
  private types: Map<string, Type> = new Map();
  private allFnParams: Var[] = [];
  private allFnVars: Var[] = [];

  constructor(parent?: LexicalContext) {
    this.parent = parent;
  }

  setAsFn() {
    this.isFn = true;
  }

  setFn(identifier: Id, type: FnType) {
    const id = getIdStr(identifier);
    const fns = this.fns.get(id);
    if (!fns) {
      type.binaryenId = `${id}0`;
      this.fns.set(id, [type]);
      return this;
    }
    type.binaryenId = `${id}${fns.length}`;
    fns.push(type);
    return this;
  }

  getFns(identifier: Id): FnType[] | undefined {
    const id = getIdStr(identifier);
    return this.fns.get(id) ?? this.parent?.getFns(id);
  }

  setVar(identifier: Id, v: Omit<Var, "index">) {
    const id = getIdStr(identifier);
    const val: Var = {
      ...v,
      index: v.kind !== "global" ? this.getNewVarIndex() : 0,
    };
    this.vars.set(id, val);
    return this;
  }

  getVar(identifier: Id): Var | undefined {
    const id = getIdStr(identifier);
    return this.vars.get(id) ?? this.parent?.getVar(id);
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

  setType(identifier: Id, v: Type) {
    const id = getIdStr(identifier);
    this.types.set(id, v);
    return this;
  }

  getType(identifier: Id): Type | undefined {
    const id = getIdStr(identifier);
    return this.types.get(id) ?? this.parent?.getType(id);
  }

  setParent(parent: LexicalContext) {
    this.parent = parent;
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
      throw new Error("Not in function");
    }

    return this.parent.getNewVarIndex();
  }
}
