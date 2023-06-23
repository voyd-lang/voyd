import type { Expr } from "./expr.mjs";
import type { Fn } from "./fn.mjs";
import type { Id } from "./identifier.mjs";
import { Entity, LexicalContext, MacroEntity } from "./lexical-context.mjs";
import { Parameter } from "./parameter.mjs";
import { Variable } from "./variable.mjs";

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
  context?: LexicalContext;
};

export abstract class Syntax {
  readonly syntaxId = getSyntaxId();
  readonly location?: SourceLocation;
  readonly context: LexicalContext;
  parent?: Expr;
  /** For tagged unions */
  abstract readonly syntaxType: string;

  constructor({ location, parent, context }: SyntaxOpts) {
    this.location = location;
    this.parent = parent;
    this.context = context ?? new LexicalContext();
  }

  get parentFn(): Fn | undefined {
    return this.parent?.syntaxType === "fn"
      ? this.parent
      : this.parent?.parentFn;
  }

  registerEntity(v: Entity) {
    this.context.registerEntity(v);
    if (v.syntaxType === "parameter" || v.syntaxType === "variable") {
      this.registerLocalWithParentFn(v);
    }
  }

  resolveEntity(name: Id): Entity | undefined {
    return this.context.resolveEntity(name) ?? this.parent?.resolveEntity(name);
  }

  resolveMacroEntity(name: Id): MacroEntity | undefined {
    return (
      this.context.resolveMacroEntity(name) ??
      this.parent?.resolveMacroEntity(name)
    );
  }

  resolveFns(id: Id, start: Fn[] = []): Fn[] {
    start.push(...this.context.resolveFns(id));
    if (this.parent) return this.parent.resolveFns(id, start);
    return start;
  }

  resolveFnById(id: string): Fn | undefined {
    return this.context.resolveFnById(id) ?? this.parent?.resolveFnById(id);
  }

  getCloneOpts(parent?: Expr): SyntaxOpts {
    return {
      location: this.location,
      parent: parent ?? this.parent,
      context: this.context,
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
}

let currentSyntaxId = 0;
const getSyntaxId = () => {
  const current = currentSyntaxId;
  currentSyntaxId += 1;
  return current;
};
