import type { Block } from "./block.js";
import type { Bool } from "./bool.js";
import type { Call } from "./call.js";
import type { Expr } from "./expr.js";
import type { Float } from "./float.js";
import type { Fn } from "./fn.js";
import type { Global } from "./global.js";
import type { Id, Identifier } from "./identifier.js";
import type { Int } from "./int.js";
import type { VoydModule } from "./module.js";
import { LexicalContext } from "./lib/lexical-context.js";
import type { List } from "./list.js";
import type { MacroLambda } from "./macro-lambda.js";
import type { Closure } from "./closure.js";
import type { MacroVariable } from "./macro-variable.js";
import type { Macro } from "./macros.js";
import type { Parameter } from "./parameter.js";
import type { ObjectLiteral } from "./object-literal.js";
import type { ArrayLiteral } from "./array-literal.js";
import type {
  FnType,
  PrimitiveType,
  ObjectType,
  Type,
  TypeAlias,
  FixedArrayType,
  UnionType,
  IntersectionType,
  SelfType,
  VoydRefType,
  TupleType,
} from "./types.js";
import type { Variable } from "./variable.js";
import type { Whitespace } from "./whitespace.js";
import type { NamedEntity } from "./named-entity.js";
import type { ScopedEntity } from "./scoped-entity.js";
import type { Declaration } from "./declaration.js";
import type { Use } from "./use.js";
import type { Match } from "./match.js";
import type { Implementation } from "./implementation.js";
import type { TraitType } from "./trait.js";

export type Attributes = { [key: string]: unknown };

export type SyntaxMetadata = {
  location?: SourceLocation;
  parent?: Expr;
  attributes?: Attributes;
};

export abstract class Syntax {
  /** For tagged unions */
  abstract readonly syntaxType: string;
  readonly syntaxId = getSyntaxId();
  #attributes?: Attributes;
  #tmpAttributes?: Attributes;
  location?: SourceLocation;
  parent?: Expr;

  constructor(metadata: SyntaxMetadata) {
    const { location, parent } = metadata;
    this.location = location;
    this.parent = parent;
    this.#attributes = metadata.attributes;
  }

  get parentFn(): Fn | Closure | undefined {
    return this.parent?.isFn() || this.parent?.isClosure()
      ? (this.parent as Fn | Closure)
      : this.parent?.parentFn;
  }

  get parentModule(): VoydModule | undefined {
    return this.parent?.isModule() ? this.parent : this.parent?.parentModule;
  }

  get parentImpl(): Implementation | undefined {
    return this.parent?.isImpl() ? this.parent : this.parent?.parentImpl;
  }

  get parentTrait(): TraitType | undefined {
    return this.parent?.isTrait() ? this.parent : this.parent?.parentTrait;
  }

  get metadata() {
    return {
      location: this.location,
      parent: this.parent,
      attributes: this.#attributes ? { ...this.#attributes } : undefined,
    };
  }

  setTmpAttribute(key: string, value: unknown): void {
    if (value === undefined) {
      if (this.#tmpAttributes) {
        delete this.#tmpAttributes[key];
        if (Object.keys(this.#tmpAttributes).length === 0) {
          this.#tmpAttributes = undefined;
        }
      }
      return;
    }

    if (!this.#tmpAttributes) this.#tmpAttributes = {};
    this.#tmpAttributes[key] = value;
  }

  hasTmpAttribute(key: string): boolean {
    return this.#tmpAttributes ? key in this.#tmpAttributes : false;
  }

  getTmpAttribute<T>(key: string): T | undefined {
    return this.#tmpAttributes?.[key] as T | undefined;
  }

  getAllEntities(): NamedEntity[] {
    if (!this.isScopedEntity()) return this.parent?.getAllEntities() ?? [];
    return this.lexicon.getAllEntities();
  }

  registerEntity(v: NamedEntity, alias?: string): void {
    if (!this.isScopedEntity()) return this.parent?.registerEntity(v, alias);
    this.lexicon.registerEntity(v, alias);
  }

  /** Will resolve a sibling module, or a direct ancestor */
  resolveModule(name: Id, level = 0): VoydModule | undefined {
    if (!this.isModule()) {
      return this.parentModule?.resolveModule(name, level);
    }

    if (this.name.is(name)) return this;

    // We check root module as its where we find src and std
    if (level < 2 || this.isRoot) {
      const sibling = this.resolveEntity(name);
      if (sibling?.isModule()) return sibling;
    }

    return this.parentModule?.resolveModule(name, level + 1);
  }

  /** Recursively searches for the entity up the parent tree up to the parent module */
  resolveEntity(name: Id): NamedEntity | undefined {
    if (!this.isScopedEntity()) return this.parent?.resolveEntity(name);

    if (this.isModule()) return this.lexicon.resolveEntity(name);

    // Crawl up blocks until we hit a module
    return this.lexicon.resolveEntity(name) ?? this.parent?.resolveEntity(name);
  }

  /** Recursively searches for the fn entity(s) up the parent tree */
  resolveFns(id: Id, start: Fn[] = []): Fn[] {
    if (!this.isScopedEntity()) {
      return this.parent?.resolveFns(id, start) ?? start;
    }

    if (this.isModule()) return start.concat(this.lexicon.resolveFns(id));

    start.push(...this.lexicon.resolveFns(id));
    if (this.parent) return this.parent.resolveFns(id, start);
    return start;
  }

  getCloneOpts(parent?: Expr): SyntaxMetadata {
    return {
      ...this.metadata,
      parent: parent ?? this.parent,
    };
  }

  /**
   * Returns the static type resolved for this expression, if available.
   * Subclasses that carry type information should override this method
   * and/or populate a `type` property during semantic analysis.
   */
  getType(): Type | undefined {
    return undefined;
  }

  /** Clone this object (Implementations should not carry over resolved type expression) */
  abstract clone(parent?: Expr): Expr;

  /** Should emit in compliance with core language spec */
  abstract toJSON(): unknown;

  setAttribute(key: string, value: unknown) {
    if (!this.#attributes) this.#attributes = {};
    this.#attributes[key] = value;
  }

  getAttribute(key: string): unknown {
    if (!this.#attributes) return undefined;
    return this.#attributes[key];
  }

  hasAttribute(key: string): boolean {
    if (!this.#attributes) return false;
    return this.#attributes[key] !== undefined;
  }

  isScopedEntity(): this is ScopedEntity {
    return (this as unknown as ScopedEntity).lexicon instanceof LexicalContext;
  }

  isExpr(): this is Expr {
    return true;
  }

  isList(): this is List {
    return this.syntaxType === "list";
  }

  isMatch(): this is Match {
    return this.syntaxType === "match";
  }

  isFloat(): this is Float {
    return this.syntaxType === "float";
  }

  isInt(): this is Int {
    return this.syntaxType === "int";
  }

  isBool(): this is Bool {
    return this.syntaxType === "bool";
  }

  isWhitespace(): this is Whitespace {
    return this.syntaxType === "whitespace";
  }

  isImpl(): this is Implementation {
    return this.syntaxType === "implementation";
  }

  isTrait(): this is TraitType {
    return this.isType() && this.kindOfType === "trait";
  }

  isTupleType(): this is TupleType {
    return this.isType() && this.kindOfType === "tuple";
  }

  isObjectType(): this is ObjectType {
    return this.isType() && this.kindOfType === "object";
  }

  isUnionType(): this is UnionType {
    return this.isType() && this.kindOfType === "union";
  }

  isIntersectionType(): this is IntersectionType {
    return this.isType() && this.kindOfType === "intersection";
  }

  isFixedArrayType(): this is FixedArrayType {
    return this.isType() && this.kindOfType === "fixed-array";
  }

  isTraitType(): this is TraitType {
    return this.isType() && this.kindOfType === "trait";
  }

  isPrimitiveType(): this is PrimitiveType {
    return this.isType() && this.kindOfType === "primitive";
  }

  isSelfType(): this is SelfType {
    return this.isType() && this.kindOfType === "self";
  }

  isIdentifier(): this is Identifier {
    return this.syntaxType === "identifier";
  }

  isFnType(): this is FnType {
    return this.isType() && this.kindOfType === "fn";
  }

  isFn(): this is Fn {
    return this.syntaxType === "fn";
  }

  isVariable(): this is Variable {
    return this.syntaxType === "variable";
  }

  isGlobal(): this is Global {
    return this.syntaxType === "global";
  }

  isMacro(): this is Macro {
    return this.syntaxType === "macro";
  }

  isMacroVariable(): this is MacroVariable {
    return this.syntaxType === "macro-variable";
  }

  isMacroLambda(): this is MacroLambda {
    return this.syntaxType === "macro-lambda";
  }

  isClosure(): this is Closure {
    return this.syntaxType === "closure";
  }

  isModule(): this is VoydModule {
    return this.syntaxType === "module";
  }

  isCall(): this is Call {
    return this.syntaxType === "call";
  }

  isParameter(): this is Parameter {
    return this.syntaxType === "parameter";
  }

  isType(): this is Type {
    return this.syntaxType === "type";
  }

  isTypeAlias(): this is TypeAlias {
    return this.isType() && this.kindOfType === "type-alias";
  }

  isBlock(): this is Block {
    return this.syntaxType === "block";
  }

  isDeclaration(): this is Declaration {
    return this.syntaxType === "declaration";
  }

  isUse(): this is Use {
    return this.syntaxType === "use";
  }

  isObjectLiteral(): this is ObjectLiteral {
    return this.syntaxType === "object-literal";
  }

  isArrayLiteral(): this is ArrayLiteral {
    return this.syntaxType === "array-literal";
  }

  isRefType(): this is VoydRefType {
    if (!this.isType()) return false;

    switch (this.kindOfType) {
      case "object":
      case "intersection":
      case "union":
      case "tuple":
        return true;
      default:
        return false;
    }
  }

  setEndLocationToStartOf(location?: SourceLocation) {
    this.location?.setEndToStartOf(location);
  }

  setEndLocationToEndOf(location?: SourceLocation) {
    this.location?.setEndToEndOf(location);
  }

  toAST(): { type: string; location?: SourceLocation; value: unknown } {
    const json = this.toJSON();
    const value =
      json instanceof Array
        ? json.map((v) => {
            if (v instanceof Syntax) return v.toAST();
            return v;
          })
        : json;

    return {
      type: this.syntaxType,
      location: this.location,
      value,
    };
  }
}

let currentSyntaxId = 0;
export const getSyntaxId = () => {
  const current = currentSyntaxId;
  currentSyntaxId += 1;
  return current;
};

export class SourceLocation {
  /** The exact character index the syntax starts */
  startIndex: number;
  /** The exact character index the syntax ends */
  endIndex: number;
  /** The line the syntax is located in */
  line: number;
  /** The column within the line the syntax begins */
  column: number;
  /** The column index in the line where the syntax ends  */
  endColumn?: number;
  endLine?: number;

  filePath: string;

  constructor(opts: {
    startIndex: number;
    endIndex: number;
    line: number;
    column: number;
    filePath: string;
  }) {
    this.startIndex = opts.startIndex;
    this.endIndex = opts.endIndex;
    this.line = opts.line;
    this.column = opts.column;
    this.filePath = opts.filePath;
  }

  setEndToStartOf(location?: SourceLocation) {
    if (!location) return;
    this.endIndex = location.startIndex;
    this.endColumn = location.column;
    this.endLine = location.line;
  }

  setEndToEndOf(location?: SourceLocation) {
    if (!location) return;
    this.endIndex = location.endIndex;
    this.endColumn = location.endColumn;
    this.endLine = location.endLine;
  }

  toString() {
    return `${this.filePath}:${this.line}${
      this.endLine && this.endLine !== this.line ? `-${this.endLine}` : ""
    }:${this.column + 1}${this.endColumn ? `-${this.endColumn + 1}` : ""}`;
  }

  toJSON() {
    return {
      startIndex: this.startIndex,
      endIndex: this.endIndex,
      line: this.line,
      column: this.column,
      endColumn: this.endColumn,
      endLine: this.endLine,
      filePath: this.filePath,
    };
  }

  clone() {
    return new SourceLocation(this.toJSON());
  }
}
