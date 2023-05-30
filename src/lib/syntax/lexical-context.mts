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
  private readonly fns: Map<string, FnType[]> = new Map();
  private readonly vars: Map<string, Var> = new Map();
  private readonly types: Map<string, Type> = new Map();

  addFn(identifier: Id, type: FnType) {
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

  getFns(identifier: Id): FnType[] {
    const id = getIdStr(identifier);
    return this.fns.get(id) ?? [];
  }

  addVar(identifier: Id, v: Var) {
    const id = getIdStr(identifier);
    this.vars.set(id, v);
    return this;
  }

  getVar(identifier: Id): Var | undefined {
    const id = getIdStr(identifier);
    return this.vars.get(id);
  }

  addType(identifier: Id, v: Type) {
    const id = getIdStr(identifier);
    this.types.set(id, v);
    return this;
  }

  getType(identifier: Id): Type | undefined {
    const id = getIdStr(identifier);
    return this.types.get(id);
  }
}
