import type { Fn } from "./fn.mjs";
import { getIdStr } from "./get-id-str.mjs";
import type { Id } from "./identifier.mjs";
import type { Parameter } from "./parameter.mjs";
import type { Type } from "./types.mjs";
import type { Variable } from "./variable.mjs";
import type { Global } from "./global.mjs";
import { MacroVariable } from "./macro-variable.mjs";
import { Macro } from "./macros.mjs";
import { ExternFn } from "./extern-fn.mjs";

export type Entity =
  | FnEntity
  | Type
  | Variable
  | Parameter
  | Global
  | MacroEntity;

export type MacroEntity = Macro | MacroVariable;

export type FnEntity = Fn | ExternFn;

export class LexicalContext {
  private readonly fns: Map<string, FnEntity[]> = new Map();
  private readonly fnsById: Map<string, FnEntity> = new Map();
  private readonly vars: Map<string, Variable> = new Map();
  private readonly params: Map<string, Parameter> = new Map();
  private readonly types: Map<string, Type> = new Map();
  private readonly globals: Map<string, Global> = new Map();
  private readonly macroVars: Map<string, MacroVariable> = new Map();
  private readonly macros: Map<string, Macro> = new Map();

  registerEntity(entity: Entity) {
    const idStr = getIdStr(entity.name);
    if (entity.syntaxType === "fn" || entity.syntaxType === "extern-fn") {
      const fns = this.fns.get(idStr) ?? [];
      fns.push(entity);
      this.fns.set(idStr, fns);
      this.fnsById.set(entity.id, entity);
      return;
    }

    if (entity.syntaxType === "type") {
      this.types.set(idStr, entity);
      return;
    }

    if (entity.syntaxType === "parameter") {
      this.params.set(idStr, entity);
      return;
    }

    if (entity.syntaxType === "variable") {
      this.vars.set(idStr, entity);
      return;
    }

    if (entity.syntaxType === "global") {
      this.globals.set(idStr, entity);
      return;
    }

    if (entity.syntaxType === "macro-variable") {
      this.macroVars.set(idStr, entity);
      return;
    }

    if (entity.syntaxType === "macro") {
      this.macros.set(idStr, entity);
      return;
    }

    throw new Error(
      `Unrecognized entity ${entity}, name: ${(entity as any)?.name}`
    );
  }

  resolveEntity(name: Id): Entity | undefined {
    // Intentionally does not check this.fns, those have separate resolution rules i.e. overloading that are handled elsewhere (for now)
    const id = getIdStr(name);
    return (
      this.vars.get(id) ??
      this.params.get(id) ??
      this.types.get(id) ??
      this.globals.get(id)
    );
  }

  /** Macro entity's includes macro parameters, variables,  */
  resolveMacroEntity(name: Id): MacroEntity | undefined {
    const idStr = getIdStr(name);
    return this.macroVars.get(idStr);
  }

  resolveFns(name: Id): FnEntity[] {
    const id = getIdStr(name);
    return this.fns.get(id) ?? [];
  }

  resolveFnById(id: string): FnEntity | undefined {
    return this.fnsById.get(id);
  }
}
