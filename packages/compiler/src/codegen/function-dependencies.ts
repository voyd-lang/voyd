import type { CodegenContext, FunctionMetadata } from "./context.js";
import type { ProgramSymbolId, TypeId } from "../semantics/ids.js";
import { requireFunctionMeta } from "./function-lookup.js";

export type CodegenFunctionDependency = "string-literal-constructor";

const FUNCTION_DEPENDENCY_STATE = Symbol.for("voyd.codegen.functionDependencies");

type FunctionDependencyState = {
  symbolsByDependency: Map<CodegenFunctionDependency, ProgramSymbolId>;
};

const dependencyIntrinsicName = (
  dependency: CodegenFunctionDependency,
): string => {
  switch (dependency) {
    case "string-literal-constructor":
      return "__string_new";
  }
};

const dependencyStateOf = (ctx: CodegenContext): FunctionDependencyState =>
  ctx.programHelpers.getHelperState(FUNCTION_DEPENDENCY_STATE, () => ({
    symbolsByDependency: new Map<CodegenFunctionDependency, ProgramSymbolId>(),
  }));

const resolveDependencySymbol = ({
  ctx,
  dependency,
}: {
  ctx: CodegenContext;
  dependency: CodegenFunctionDependency;
}): ProgramSymbolId => {
  const state = dependencyStateOf(ctx);
  const cached = state.symbolsByDependency.get(dependency);
  if (typeof cached === "number") {
    return cached;
  }

  const intrinsicName = dependencyIntrinsicName(dependency);
  let matchedSymbol: ProgramSymbolId | undefined;

  ctx.program.modules.forEach((moduleView, moduleId) => {
    moduleView.hir.items.forEach((item) => {
      if (item.kind !== "function") {
        return;
      }
      const symbolId = ctx.program.symbols.canonicalIdOf(
        moduleId,
        item.symbol,
      ) as ProgramSymbolId;
      if (ctx.program.symbols.getIntrinsicName(symbolId) !== intrinsicName) {
        return;
      }
      if (typeof matchedSymbol === "number" && matchedSymbol !== symbolId) {
        const first = ctx.program.symbols.refOf(matchedSymbol);
        const second = ctx.program.symbols.refOf(symbolId);
        throw new Error(
          `ambiguous codegen function dependency ${dependency}: ${intrinsicName} found in ${first.moduleId}::${first.symbol} and ${second.moduleId}::${second.symbol}`,
        );
      }
      matchedSymbol = symbolId;
    });
  });

  if (typeof matchedSymbol !== "number") {
    throw new Error(
      `missing codegen function dependency ${dependency}: intrinsic ${intrinsicName}`,
    );
  }

  state.symbolsByDependency.set(dependency, matchedSymbol);
  return matchedSymbol;
};

export const markDependencyFunctionReachable = ({
  ctx,
  dependency,
  reachable,
}: {
  ctx: CodegenContext;
  dependency: CodegenFunctionDependency;
  reachable: Set<ProgramSymbolId>;
}): void => {
  reachable.add(resolveDependencySymbol({ ctx, dependency }));
};

export const requireDependencyFunctionMeta = ({
  ctx,
  dependency,
  typeArgs,
}: {
  ctx: CodegenContext;
  dependency: CodegenFunctionDependency;
  typeArgs?: readonly TypeId[];
}): FunctionMetadata => {
  const symbolId = resolveDependencySymbol({ ctx, dependency });
  const ref = ctx.program.symbols.refOf(symbolId);
  return requireFunctionMeta({
    ctx,
    moduleId: ref.moduleId,
    symbol: ref.symbol,
    typeArgs,
  });
};
