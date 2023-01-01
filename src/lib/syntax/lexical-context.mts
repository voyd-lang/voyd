import { Identifier } from "./identifier.mjs";
import { FnType, Type } from "./types.mjs";

export class LexicalContext {
  private parent?: LexicalContext;
  private fns: Map<string, FnType[]> = new Map();
  private vars: Map<string, { mut: boolean; type: Type }> = new Map();
  private globals: Map<string, { mut: boolean; type: Type }> = new Map();
  private params: Map<string, Type> = new Map();

  constructor(parent?: LexicalContext) {
    this.parent = parent;
  }

  setFn(identifier: string | Identifier, type: FnType) {
    const id = typeof identifier === "string" ? identifier : identifier.value;
    const fns = this.fns.get(id);
    if (!fns) {
      this.fns.set(id, [type]);
      return this;
    }
    fns.push(type);
    return this;
  }

  getFns(identifier: Identifier | string): FnType[] | undefined {
    const id = typeof identifier === "string" ? identifier : identifier.value;
    return this.fns.get(id) ?? this.parent?.getFns(id);
  }

  setId(identifier: Identifier) {
    this.vars.set(identifier.value, identifier);
    return this;
  }

  getId(identifier: Identifier | string): Identifier | undefined {
    const id = typeof identifier === "string" ? identifier : identifier.value;
    return this.vars.get(id) ?? this.parent?.getId(id);
  }

  setParent(parent: LexicalContext) {
    this.parent = parent;
  }
}

const getIdStr = (id: string | Identifier) =>
