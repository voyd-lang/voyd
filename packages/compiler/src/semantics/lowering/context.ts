import type { LowerContext, LowerInputs, LowerScopeStack } from "./types.js";
import type { ScopeId } from "../ids.js";
import { modulePathToString } from "../../modules/path.js";

export const createLowerContext = ({
  builder,
  binding,
  moduleNodeId,
  moduleId,
  modulePath,
  packageId,
  isPackageRoot,
}: LowerInputs): LowerContext => {
  const importSpansByLocal = new Map(
    binding.imports.flatMap((entry) =>
      entry.span ? [[entry.local, entry.span] as const] : [],
    ),
  );

  return {
    builder,
    symbolTable: binding.symbolTable,
    scopeByNode: binding.scopeByNode,
    intrinsicSymbols: new Map(),
    intrinsicTypeSymbols: new Map(),
    moduleNodeId,
    moduleId: moduleId ?? modulePathToString(modulePath),
    overloadBySymbol: binding.overloadBySymbol,
    staticMethods: binding.staticMethods,
    moduleMembers: binding.moduleMembers,
    decls: binding.decls,
    dependencies: binding.dependencies,
    importSpansByLocal,
    modulePath,
    packageId,
    isPackageRoot,
  };
};

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
