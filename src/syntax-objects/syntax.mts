import type { Block } from "./block.mjs";
import type { Bool } from "./bool.mjs";
import type { Call } from "./call.mjs";
import type { Expr } from "./expr.mjs";
import type { ExternFn } from "./extern-fn.mjs";
import type { Float } from "./float.mjs";
import type { Fn } from "./fn.mjs";
import type { Global } from "./global.mjs";
import type { Id, Identifier } from "./identifier.mjs";
import type { Int } from "./int.mjs";
import {
  Entity,
  FnEntity,
  LexicalContext,
  MacroEntity,
} from "./lexical-context.mjs";
import type { List } from "./list.mjs";
import type { MacroLambda } from "./macro-lambda.mjs";
import type { MacroVariable } from "./macro-variable.mjs";
import type { Macro } from "./macros.mjs";
import type { Parameter } from "./parameter.mjs";
import type { StringLiteral } from "./string-literal.mjs";
import type { FnType, PrimitiveType, ObjectType, Type } from "./types.mjs";
import type { Variable } from "./variable.mjs";
import type { Whitespace } from "./whitespace.mjs";

export type SourceLocation = {
  /** The exact character index the syntax starts */
  startIndex: number;
  /** The exact character index the syntax ends */
  endIndex: number;
  /** The line the syntax is located in */
  line: number;
  /** The column within the line the syntax begins */
  column: number;

  filePath: string;
};

export type SyntaxOpts = {
  location?: SourceLocation;
  parent?: Expr;
  lexicon?: LexicalContext;
};

export abstract class Syntax {
  readonly syntaxId = getSyntaxId();
  readonly location?: SourceLocation;
  readonly lexicon: LexicalContext;
  parent?: Expr;
  /** For tagged unions */
  abstract readonly syntaxType: string;

  constructor({ location, parent, lexicon }: SyntaxOpts) {
    this.location = location;
    this.parent = parent;
    this.lexicon = lexicon ?? new LexicalContext();
  }

  get parentFn(): Fn | undefined {
    return this.parent?.syntaxType === "fn"
      ? this.parent
      : this.parent?.parentFn;
  }

  get context() {
    return {
      location: this.location,
      parent: this.parent,
      lexicon: this.lexicon,
    };
  }

  registerEntity(v: Entity) {
    this.lexicon.registerEntity(v);
    if (v.syntaxType === "parameter" || v.syntaxType === "variable") {
      this.registerLocalWithParentFn(v);
    }
  }

  resolveEntity(name: Id): Entity | undefined {
    return this.lexicon.resolveEntity(name) ?? this.parent?.resolveEntity(name);
  }

  resolveMacroEntity(name: Id): MacroEntity | undefined {
    return (
      this.lexicon.resolveMacroEntity(name) ??
      this.parent?.resolveMacroEntity(name)
    );
  }

  resolveFns(id: Id, start: FnEntity[] = []): FnEntity[] {
    start.push(...this.lexicon.resolveFns(id));
    if (this.parent) return this.parent.resolveFns(id, start);
    return start;
  }

  resolveFnById(id: string): FnEntity | undefined {
    return this.lexicon.resolveFnById(id) ?? this.parent?.resolveFnById(id);
  }

  getCloneOpts(parent?: Expr): SyntaxOpts {
    return {
      ...this.context,
      parent: parent ?? this.parent,
    };
  }

  abstract clone(parent?: Expr): Expr;

  /** Should emit in compliance with core language spec */
  abstract toJSON(): any;

  private registerLocalWithParentFn(v: Variable | Parameter): void {
    if (!this.parent) {
      throw new Error(`Not in fn, cannot register ${v}`);
    }

    if (this.parent.syntaxType === "fn") {
      this.parent?.registerLocal(v);
      return;
    }

    return this.parent.registerLocalWithParentFn(v);
  }

  isExpr(): this is Expr {
    return true;
  }

  isStringLiteral(): this is StringLiteral {
    return this.isExpr() && this.syntaxType === "string-literal";
  }

  isList(): this is List {
    return this.isExpr() && this.syntaxType === "list";
  }

  isFloat(): this is Float {
    return this.isExpr() && this.syntaxType === "float";
  }

  isInt(): this is Int {
    return this.isExpr() && this.syntaxType === "int";
  }

  isBool(): this is Bool {
    return this.isExpr() && this.syntaxType === "bool";
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
    return this.isExpr() && this.syntaxType === "identifier";
  }

  isFnType(): this is FnType {
    return this.isType() && this.kindOfType === "fn";
  }

  isFn(): this is Fn {
    return this.isExpr() && this.syntaxType === "fn";
  }

  isExternFn(): this is ExternFn {
    return this.isExpr() && this.syntaxType === "extern-fn";
  }

  isVariable(): this is Variable {
    return this.isExpr() && this.syntaxType === "variable";
  }

  isGlobal(): this is Global {
    return this.isExpr() && this.syntaxType === "global";
  }

  isMacro(): this is Macro {
    return this.isExpr() && this.syntaxType === "macro";
  }

  isMacroVariable(): this is MacroVariable {
    return this.isExpr() && this.syntaxType === "macro-variable";
  }

  isMacroLambda(): this is MacroLambda {
    return this.isExpr() && this.syntaxType === "macro-lambda";
  }

  isCall(): this is Call {
    return this.isExpr() && this.syntaxType === "call";
  }

  isParameter(): this is Parameter {
    return this.isExpr() && this.syntaxType === "parameter";
  }

  isType(): this is Type {
    return this.isExpr() && this.syntaxType === "type";
  }

  isBlock(): this is Block {
    return this.isExpr() && this.syntaxType === "block";
  }
}

let currentSyntaxId = 0;
const getSyntaxId = () => {
  const current = currentSyntaxId;
  currentSyntaxId += 1;
  return current;
};
