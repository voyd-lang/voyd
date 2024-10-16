import { Expr } from "./expr.js";
import { Id } from "./identifier.js";
import { ChildList } from "./lib/child-list.js";
import { LexicalContext } from "./lib/lexical-context.js";
import {
  NamedEntity,
  ScopedNamedEntity,
  ScopedNamedEntityOpts,
} from "./named-entity.js";

export type VoydModuleOpts = ScopedNamedEntityOpts & {
  value?: Expr[];
  phase?: number;
  isIndex?: boolean;
  exports?: LexicalContext;
};

export class VoydModule extends ScopedNamedEntity {
  readonly syntaxType = "module";
  readonly exports: LexicalContext;
  readonly isRoot: boolean = false;
  /** This module is the entry point of the user src code */
  isIndex = false;
  #value = new ChildList(undefined, this);
  /**
   * 0 = init,
   * 1 = expanding regular macros,
   * 2 = regular macros expanded,
   * 3 = checking types,
   * 4 = types checked
   */
  phase = 0;

  constructor(opts: VoydModuleOpts) {
    super(opts);
    if (opts.value) this.push(...opts.value);
    this.exports = opts.exports ?? new LexicalContext();
    this.phase = opts.phase ?? 0;
    this.isIndex = opts.isIndex ?? false;
  }

  get value() {
    return this.#value.toArray();
  }

  set value(value: Expr[]) {
    this.#value = new ChildList(undefined, this);
    this.push(...value);
  }

  registerExport(entity: NamedEntity, alias?: string) {
    this.exports.registerEntity(entity, alias);
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

  each(fn: (expr: Expr, index: number, array: Expr[]) => void): VoydModule {
    this.value.forEach(fn);
    return this;
  }

  map(fn: (expr: Expr, index: number, array: Expr[]) => Expr): VoydModule {
    return new VoydModule({
      ...super.getCloneOpts(),
      value: this.value.map(fn),
      phase: this.phase,
      isIndex: this.isIndex,
      exports: this.exports,
    });
  }

  applyMap(fn: (expr: Expr, index: number, array: Expr[]) => Expr): VoydModule {
    const old = this.value;
    this.value = [];
    old.forEach((expr, index, arr) => this.push(fn(expr, index, arr)));
    return this;
  }

  toString() {
    return this.id;
  }

  clone(parent?: Expr | undefined): VoydModule {
    return new VoydModule({
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

  push(...expr: Expr[]) {
    this.#value.push(...expr);
    return this;
  }

  unshift(...expr: Expr[]) {
    this.#value.unshift(...expr);
    return this;
  }
}

export class RootModule extends VoydModule {
  readonly isRoot = true;

  constructor(opts: Omit<VoydModuleOpts, "name">) {
    super({ ...opts, name: "root" });
  }
}
