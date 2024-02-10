import type { Fn } from "./fn.mjs";
import { getIdStr } from "./get-id-str.mjs";
import type { Id } from "./identifier.mjs";
import { ExternFn } from "./extern-fn.mjs";
import { NamedEntity } from "./named-entity.mjs";

export type FnEntity = Fn | ExternFn;

export class LexicalContext {
  private readonly fns: Map<string, FnEntity[]> = new Map();
  private readonly fnsById: Map<string, FnEntity> = new Map();
  private readonly entities: Map<string, NamedEntity> = new Map();

  registerEntity(entity: NamedEntity) {
    const idStr = getIdStr(entity.name);
    if (entity.isFn() || entity.isExternFn()) {
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

  resolveFns(name: Id): FnEntity[] {
    const id = getIdStr(name);
    return this.fns.get(id) ?? [];
  }

  resolveFnById(id: string): FnEntity | undefined {
    return this.fnsById.get(id);
  }
}
