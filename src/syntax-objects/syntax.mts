import type { Block } from "./block.mjs";
import type { Bool } from "./bool.mjs";
import type { Call } from "./call.mjs";
import type { Expr } from "./expr.mjs";
import type { Float } from "./float.mjs";
import type { Fn } from "./fn.mjs";
import type { Global } from "./global.mjs";
import type { Id, Identifier } from "./identifier.mjs";
import type { Int } from "./int.mjs";
import type { VoidModule } from "./module.mjs";
import { LexicalContext } from "./lexical-context.mjs";
import type { List } from "./list.mjs";
import type { MacroLambda } from "./macro-lambda.mjs";
import type { MacroVariable } from "./macro-variable.mjs";
import type { Macro } from "./macros.mjs";
import type { Parameter } from "./parameter.mjs";
import type { StringLiteral } from "./string-literal.mjs";
import type { ObjectLiteral } from "./object-literal.mjs";
import type {
  FnType,
  PrimitiveType,
  ObjectType,
  Type,
  TypeAlias,
} from "./types.mjs";
import type { Variable } from "./variable.mjs";
import type { Whitespace } from "./whitespace.mjs";
import { NamedEntity } from "./named-entity.mjs";
import { ScopedEntity } from "./scoped-entity.mjs";
import { Declaration } from "./declaration.mjs";
import { Use } from "./use.mjs";

export type SyntaxMetadata = {
  location?: SourceLocation;
  parent?: Expr;
  contextTag?: ContextTag;
};

export abstract class Syntax {
  /** For tagged unions */
  abstract readonly syntaxType: string;
  readonly syntaxId = getSyntaxId();
  location?: SourceLocation;
  contextTag?: ContextTag;
  parent?: Expr;

  constructor(metadata: SyntaxMetadata) {
    const { location, parent, contextTag } = metadata;
    this.location = location;
    this.parent = parent;
    this.contextTag = contextTag;
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
      contextTag: this.contextTag,
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

/** Used to determine proper context inheritance chain for macro expansion hygiene */
export type ContextTag =
  | {
      /** Syntax object was generated by macro expansion, should inherit the context from module located at path */
      type: "macro";
      /** The path to the module the syntax should inherit */
      path: string[];
    }
  | {
      /** Syntax object wrapped or transformed by macro expansion, should inherit the normal context (outside the macro context) */
      type: "resume-normal";
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
