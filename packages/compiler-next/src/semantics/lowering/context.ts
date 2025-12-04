import type { LowerContext, LowerInputs, LowerScopeStack } from "./types.js";
import type { ScopeId } from "../ids.js";

export const createLowerContext = ({
  builder,
  binding,
  moduleNodeId,
}: LowerInputs): LowerContext => ({
  builder,
  symbolTable: binding.symbolTable,
  scopeByNode: binding.scopeByNode,
  intrinsicSymbols: new Map(),
  intrinsicTypeSymbols: new Map(),
  moduleNodeId,
  overloadBySymbol: binding.overloadBySymbol,
  staticMethods: binding.staticMethods,
  moduleMembers: binding.moduleMembers,
  decls: binding.decls,
});

export const createLowerScopeStack = (initial: ScopeId): LowerScopeStack => {
  const stack: ScopeId[] = [initial];

  return {
    current: () => stack[stack.length - 1]!,
    push: (scope) => stack.push(scope),
    pop: () => {
      if (stack.length > 1) {
        stack.pop();
      }
    },
  };
};
