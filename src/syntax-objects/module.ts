import { Expr } from "./expr.js";
import { Float } from "./float.js";
import { Id, Identifier } from "./identifier.js";
import { Int } from "./int.js";
import { LexicalContext } from "./lexical-context.js";
import { List, ListValue } from "./list.js";
import {
  NamedEntity,
  ScopedNamedEntity,
  ScopedNamedEntityOpts,
} from "./named-entity.js";

export type VoidModuleOpts = ScopedNamedEntityOpts & {
  value?: ListValue[];
  phase?: number;
  isIndex?: boolean;
  exports?: LexicalContext;
};

export class VoidModule extends ScopedNamedEntity {
  readonly syntaxType = "module";
  readonly exports: LexicalContext;
  readonly isRoot: boolean = false;
  /** This module is the entry point of the user src code */
  isIndex = false;
  value: Expr[] = [];
  /**
   * 0 = init,
   * 1 = expanding regular macros,
   * 2 = regular macros expanded,
   * 3 = checking types,
   * 4 = types checked
   */
  phase = 0;

  constructor(opts: VoidModuleOpts) {
    super(opts);
    if (opts.value) this.push(...opts.value);
    this.exports = opts.exports ?? new LexicalContext();
    this.phase = opts.phase ?? 0;
    this.isIndex = opts.isIndex ?? false;
  }

  registerExport(entity: NamedEntity) {
    this.exports.registerEntity(entity);
  }

  resolveExport(name: Id): NamedEntity[] {
    const start: NamedEntity[] = this.exports.resolveFns(name);
    const entity = this.exports.resolveEntity(name);
    if (entity) start.push(entity);
    return start;
  }

  getAllExports(): NamedEntity[] {
    return this.exports.getAllEntities();
  }

  getPath(): string[] {
    const path = this.parentModule?.getPath() ?? [];
    return [...path, this.name.toString()];
  }

  each(fn: (expr: Expr, index: number, array: Expr[]) => void): VoidModule {
    this.value.forEach(fn);
    return this;
  }

  map(fn: (expr: Expr, index: number, array: Expr[]) => Expr): VoidModule {
    return new VoidModule({
      ...super.getCloneOpts(),
      value: this.value.map(fn),
      phase: this.phase,
      isIndex: this.isIndex,
      exports: this.exports,
    });
  }

  applyMap(fn: (expr: Expr, index: number, array: Expr[]) => Expr): VoidModule {
    const old = this.value;
    this.value = [];
    old.forEach((expr, index, arr) => this.push(fn(expr, index, arr)));
    return this;
  }

  toString() {
    return this.id;
  }

  clone(parent?: Expr | undefined): VoidModule {
    return new VoidModule({
      ...super.getCloneOpts(parent),
      value: this.value.map((expr) => expr.clone()),
      phase: this.phase,
    });
  }

  toJSON() {
    return [
      "module",
      this.name,
      ["exports", this.exports.getAllEntities().map((e) => e.id)],
      this.value,
    ];
  }

  push(...expr: ListValue[]) {
    expr.forEach((ex) => {
      if (typeof ex === "string") {
        this.value.push(new Identifier({ value: ex, parent: this }));
        return;
      }

      if (ex instanceof Array) {
        this.push(new List({ value: ex, parent: this }));
        return;
      }

      if (typeof ex === "number" && Number.isInteger(ex)) {
        this.value.push(new Int({ value: ex, parent: this }));
        return;
      }

      if (typeof ex === "number") {
        this.value.push(new Float({ value: ex, parent: this }));
        return;
      }

      ex.parent = this;

      if (ex instanceof NamedEntity) {
        this.registerEntity(ex);
      }

      if (ex.isList() && ex.calls("splice_quote")) {
        this.value.push(...ex.argsArray());
        return;
      }

      this.value.push(ex);
    });

    return this;
  }

  unshift(...expr: ListValue[]) {
    const old = this.value;
    this.value = [];
    this.push(...expr);
    this.push(...old);
    return this;
  }
}

export class RootModule extends VoidModule {
  readonly isRoot = true;

  constructor(opts: Omit<VoidModuleOpts, "name">) {
    super({ ...opts, name: "root" });
  }
}
