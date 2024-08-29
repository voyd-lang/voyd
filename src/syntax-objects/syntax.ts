import type { Block } from "./block.js";
import type { Bool } from "./bool.js";
import type { Call } from "./call.js";
import type { Expr } from "./expr.js";
import type { Float } from "./float.js";
import type { Fn } from "./fn.js";
import type { Global } from "./global.js";
import type { Id, Identifier } from "./identifier.js";
import type { Int } from "./int.js";
import type { VoidModule } from "./module.js";
import { LexicalContext } from "./lexical-context.js";
import type { List } from "./list.js";
import type { MacroLambda } from "./macro-lambda.js";
import type { MacroVariable } from "./macro-variable.js";
import type { Macro } from "./macros.js";
import type { Parameter } from "./parameter.js";
import type { StringLiteral } from "./string-literal.js";
import type { ObjectLiteral } from "./object-literal.js";
import type {
  FnType,
  PrimitiveType,
  ObjectType,
  Type,
  TypeAlias,
} from "./types.js";
import type { Variable } from "./variable.js";
import type { Whitespace } from "./whitespace.js";
import { NamedEntity } from "./named-entity.js";
import { ScopedEntity } from "./scoped-entity.js";
import { Declaration } from "./declaration.js";
import { Use } from "./use.js";

export type SyntaxMetadata = {
  location?: SourceLocation;
  parent?: Expr;
};

export abstract class Syntax {
  /** For tagged unions */
  abstract readonly syntaxType: string;
  readonly syntaxId = getSyntaxId();
  location?: SourceLocation;
  parent?: Expr;

  constructor(metadata: SyntaxMetadata) {
    const { location, parent } = metadata;
    this.location = location;
    this.parent = parent;
  }

  get parentFn(): Fn | undefined {
    return this.parent?.isFn() ? this.parent : this.parent?.parentFn;
  }

  get parentModule(): VoidModule | undefined {
    return this.parent?.isModule() ? this.parent : this.parent?.parentModule;
  }

  get metadata() {
    return {
      location: this.location,
      parent: this.parent,
    };
  }

  getAllEntities(): NamedEntity[] {
    if (!this.isScopedEntity()) return this.parent?.getAllEntities() ?? [];
    return this.lexicon.getAllEntities();
  }

  registerEntity(v: NamedEntity): void {
    if (!this.isScopedEntity()) return this.parent?.registerEntity(v);
    this.lexicon.registerEntity(v);
  }

  resolveChildEntity(name: Id): NamedEntity | undefined {
    if (!this.isScopedEntity()) return undefined;
    return this.lexicon.resolveEntity(name);
  }

  /** Recursively searches for the entity up the parent tree */
  resolveEntity(name: Id): NamedEntity | undefined {
    if (!this.isScopedEntity()) return this.parent?.resolveEntity(name);
    return this.lexicon.resolveEntity(name) ?? this.parent?.resolveEntity(name);
  }

  /** Recursively searches for the fn entity(s) up the parent tree */
  resolveFns(id: Id, start: Fn[] = []): Fn[] {
    if (!this.isScopedEntity()) {
      return this.parent?.resolveFns(id, start) ?? start;
    }

    start.push(...this.lexicon.resolveFns(id));
    if (this.parent) return this.parent.resolveFns(id, start);
    return start;
  }

  /** Returns functions with the given name that are a direct child of the scoped entity */
  resolveChildFns(name: Id): Fn[] {
    if (!this.isScopedEntity()) return [];
    return this.lexicon.resolveFns(name);
  }

  /** Recursively searches for the fn entity up the parent tree */
  resolveFnById(id: string): Fn | undefined {
    if (!this.isScopedEntity()) return this.parent?.resolveFnById(id);
    return this.lexicon.resolveFnById(id) ?? this.parent?.resolveFnById(id);
  }

  getCloneOpts(parent?: Expr): SyntaxMetadata {
    return {
      ...this.metadata,
      parent: parent ?? this.parent,
    };
  }

  abstract clone(parent?: Expr): Expr;

  /** Should emit in compliance with core language spec */
  abstract toJSON(): any;

  isScopedEntity(): this is ScopedEntity {
    return (this as unknown as ScopedEntity).lexicon instanceof LexicalContext;
  }

  isExpr(): this is Expr {
    return true;
  }

  isStringLiteral(): this is StringLiteral {
    return this.syntaxType === "string-literal";
  }

  isList(): this is List {
    return this.syntaxType === "list";
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

  isObjectType(): this is ObjectType {
    return this.isType() && this.kindOfType === "object";
  }

  isPrimitiveType(): this is PrimitiveType {
    return this.isType() && this.kindOfType === "primitive";
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

  isModule(): this is VoidModule {
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
}

let currentSyntaxId = 0;
const getSyntaxId = () => {
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

  toString() {
    return `${this.filePath}:${this.line}:${this.column}`;
  }
}
