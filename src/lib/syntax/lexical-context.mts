import type { Fn } from "./fn.mjs";
import { getIdStr } from "./get-id-str.mjs";
import type { Id } from "./identifier.mjs";
import type { Parameter } from "./parameter.mjs";
import type { Type } from "./types.mjs";
import type { Variable } from "./variable.mjs";
import type { Global } from "./global.mjs";
import { MacroVariable } from "./macro-variable.mjs";
import { Macro } from "./macros.mjs";

export type Entity = Fn | Type | Variable | Parameter | Global | MacroEntity;

export type MacroEntity = Macro | MacroVariable;

export class LexicalContext {
  private readonly fns: Map<string, Fn[]> = new Map();
  private readonly vars: Map<string, Variable> = new Map();
  private readonly params: Map<string, Parameter> = new Map();
  private readonly types: Map<string, Type> = new Map();
  private readonly globals: Map<string, Global> = new Map();
  private readonly macroVars: Map<string, MacroVariable> = new Map();
  private readonly macros: Map<string, Macro> = new Map();

  registerEntity(entity: Entity) {
    const idStr = getIdStr(entity.name);
    if (entity.syntaxType === "fn") {
      const fns = this.fns.get(idStr) ?? [];
      fns.push(entity);
      this.fns.set(idStr, fns);
    }

    if (entity.syntaxType === "type") {
      this.types.set(idStr, entity);
    }

    if (entity.syntaxType === "parameter") {
      this.params.set(idStr, entity);
    }

    if (entity.syntaxType === "variable") {
      this.vars.set(idStr, entity);
    }

    if (entity.syntaxType === "global") {
      this.globals.set(idStr, entity);
    }

    if (entity.syntaxType === "macro-variable") {
      this.macroVars.set(idStr, entity);
    }

    if (entity.syntaxType === "macro") {
      this.macros.set(idStr, entity);
    }

    throw new Error(`Unrecognized entity ${entity}, id: ${entity.name}`);
  }

  resolveEntity(name: Id): Entity | undefined {
    // Intentionally does not check this.fns, those have separate resolution rules i.e. overloading that are handled elsewhere (for now)
    const idStr = getIdStr(name);
    return (
      this.vars.get(idStr) ?? this.params.get(idStr) ?? this.types.get(idStr)
    );
  }

  /** Macro entity's includes macro parameters, variables,  */
  resolveMacroEntity(name: Id): MacroEntity | undefined {
    const idStr = getIdStr(name);
    return this.macroVars.get(idStr);
  }

  getFns(name: Id): Fn[] {
    const id = getIdStr(name);
    return this.fns.get(id) ?? [];
  }

  getVar(name: Id): Variable | undefined {
    const id = getIdStr(name);
    return this.vars.get(id);
  }

  getParam(name: Id): Parameter | undefined {
    const id = getIdStr(name);
    return this.params.get(id);
  }

  getType(name: Id): Type | undefined {
    const id = getIdStr(name);
    return this.types.get(id);
  }
}
