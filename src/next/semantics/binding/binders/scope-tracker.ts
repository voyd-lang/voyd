import type { ScopeId } from "../ids.js";
import type { SymbolTable } from "../binder/index.js";

export class BinderScopeTracker {
  private readonly stack: [ScopeId, ...ScopeId[]];

  constructor(private readonly symbolTable: SymbolTable) {
    this.stack = [symbolTable.rootScope];
  }

  current() {
    return this.stack.at(-1)!;
  }

  depth() {
    return this.stack.length;
  }

  enterScope<T>(scope: ScopeId, runInScope: () => T): T {
    this.push(scope);
    try {
      return runInScope();
    } finally {
      this.pop();
    }
  }

  private push(scope: ScopeId) {
    this.symbolTable.enterScope(scope);
    this.stack.push(scope);
  }

  private pop() {
    if (this.stack.length <= 1) {
      throw new Error("attempted to exit the root scope");
    }
    this.stack.pop();
    this.symbolTable.exitScope();
  }
}
