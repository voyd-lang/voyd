import { Expr } from "./expr.mjs";
import { getIdStr, Id } from "./identifier.mjs";
import { FnType, Type } from "./types.mjs";

export type Var = {
  mut?: boolean;
  type?: Type;
  kind: "var" | "param" | "global";
  /** For macro expansion phase */
  value?: Expr;
};

export class LexicalContext {
  private parent?: LexicalContext;
  private fns: Map<string, FnType[]> = new Map();
  private vars: Map<string, Var> = new Map();
  private types: Map<string, Type> = new Map();

  constructor(parent?: LexicalContext) {
    this.parent = parent;
  }

  setFn(identifier: Id, type: FnType) {
    const id = getIdStr(identifier);
    const fns = this.fns.get(id);
    if (!fns) {
      this.fns.set(id, [type]);
      return this;
    }
    fns.push(type);
    return this;
  }

  getFns(identifier: Id): FnType[] | undefined {
    const id = getIdStr(identifier);
    return this.fns.get(id) ?? this.parent?.getFns(id);
  }

  setVar(identifier: Id, v: Var) {
    const id = getIdStr(identifier);
    this.vars.set(id, v);
    return this;
  }

  getVar(identifier: Id): Var | undefined {
    const id = getIdStr(identifier);
    return this.vars.get(id) ?? this.parent?.getVar(id);
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
}
