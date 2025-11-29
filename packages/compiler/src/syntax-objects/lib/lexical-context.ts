import type { Fn } from "../fn.js";
import { getIdStr } from "./get-id-str.js";
import type { Id } from "../identifier.js";
import { NamedEntity } from "../named-entity.js";

export class LexicalContext {
  private readonly fns: Map<string, Fn[]> = new Map();
  private readonly fnsById: Map<string, Fn> = new Map();
  private readonly entities: Map<string, NamedEntity> = new Map();

  registerEntity(entity: NamedEntity, alias?: string) {
    const idStr = alias ?? getIdStr(entity.name);
    if (entity.isFn()) {
      if (!alias && this.fnsById.get(entity.id)) return; // Already registered
      const fns = this.fns.get(idStr) ?? [];
      fns.push(entity);
      this.fns.set(idStr, fns);
      this.fnsById.set(entity.id, entity);
      return;
    }

    this.entities.set(idStr, entity);
  }

  resolveEntity(name: Id): NamedEntity | undefined {
    // Intentionally does not check this.fns, those have separate resolution rules i.e. overloading that are handled elsewhere (for now)
    const id = getIdStr(name);
    return this.entities.get(id);
  }

  getAllEntities(): NamedEntity[] {
    return [...this.entities.values(), ...this.fnsById.values()];
  }

  resolveFns(name: Id): Fn[] {
    const id = getIdStr(name);
    return this.fns.get(id) ?? [];
  }

  resolveFnById(id: string): Fn | undefined {
    return this.fnsById.get(id);
  }
}
