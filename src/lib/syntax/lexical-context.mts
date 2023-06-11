import type { Fn } from "./fn.mjs";
import { getIdStr } from "./get-id-str.mjs";
import type { Id } from "./identifier.mjs";
import type { Parameter } from "./parameter.mjs";
import type { Type } from "./types.mjs";
import type { Variable } from "./variable.mjs";
import type { Global } from "./global.mjs";
import { MacroVariable } from "./macro-variable.mjs";
import { Macro } from "./macros.mjs";

export type IdentifierEntity =
  | Fn
  | Type
  | Variable
  | Parameter
  | Global
  | MacroEntity;

export type MacroEntity = Macro | MacroVariable;

export class LexicalContext {
  private readonly fns: Map<string, Fn[]> = new Map();
  private readonly vars: Map<string, Variable> = new Map();
  private readonly params: Map<string, Parameter> = new Map();
  private readonly types: Map<string, Type> = new Map();
  private readonly globals: Map<string, Global> = new Map();
  // TODO: Do these belong here? Seems like we may be giving LexicalContext too much work.
  private readonly macroVars: Map<string, MacroVariable> = new Map();
  private readonly macros: Map<string, Macro> = new Map();

  registerEntity(id: Id, entity: IdentifierEntity) {
    const idStr = getIdStr(id);
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

    throw new Error(`Unrecognized entity ${entity}, id: ${id}`);
  }

  resolveEntity(identifier: Id): IdentifierEntity | undefined {
    // Intentionally does not check this.fns, those have separate resolution rules i.e. overloading that are handled elsewhere (for now)
    const idStr = getIdStr(identifier);
    return (
      this.vars.get(idStr) ?? this.params.get(idStr) ?? this.types.get(idStr)
    );
  }

  /** Macro entity's includes macro parameters, variables,  */
  resolveMacroEntity(identifier: Id): MacroEntity | undefined {
    const idStr = getIdStr(identifier);
    return this.macroVars.get(idStr);
  }

  getFns(identifier: Id): Fn[] {
    const id = getIdStr(identifier);
    return this.fns.get(id) ?? [];
  }

  getVar(identifier: Id): Variable | undefined {
    const id = getIdStr(identifier);
    return this.vars.get(id);
  }

  getParam(identifier: Id): Parameter | undefined {
    const id = getIdStr(identifier);
    return this.params.get(id);
  }

  getType(identifier: Id): Type | undefined {
    const id = getIdStr(identifier);
    return this.types.get(id);
  }
}
