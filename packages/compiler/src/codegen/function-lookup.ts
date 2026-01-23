import type { CodegenContext, FunctionMetadata } from "./context.js";
import type { SymbolId, TypeId } from "../semantics/ids.js";

export const requireFunctionMetaByName = ({
  ctx,
  moduleId,
  name,
  typeArgs,
  paramCount,
}: {
  ctx: CodegenContext;
  moduleId: string;
  name: string;
  typeArgs?: readonly TypeId[];
  paramCount?: number;
}): FunctionMetadata => {
  const symbol = findFunctionSymbolByName({ ctx, moduleId, name, paramCount });
  if (typeof symbol !== "number") {
    throw new Error(`missing function ${moduleId}::${name}`);
  }
  return requireFunctionMeta({ ctx, moduleId, symbol, typeArgs });
};

export const requireFunctionMeta = ({
  ctx,
  moduleId,
  symbol,
  typeArgs,
}: {
  ctx: CodegenContext;
  moduleId: string;
  symbol: SymbolId;
  typeArgs?: readonly TypeId[];
}): FunctionMetadata => {
  const metas = ctx.functions.get(moduleId)?.get(symbol);
  if (!metas || metas.length === 0) {
    throw new Error(`missing metadata for function ${moduleId}::${symbol}`);
  }
  if (typeArgs) {
    const matched = metas.find((meta) => sameTypeArgs(meta.typeArgs, typeArgs));
    if (matched) return matched;
    throw new Error(
      `missing instantiation for ${moduleId}::${symbol}<${typeArgs.join(",")}>`
    );
  }
  return metas.find((meta) => meta.typeArgs.length === 0) ?? metas[0]!;
};

const findFunctionSymbolByName = ({
  ctx,
  moduleId,
  name,
  paramCount,
}: {
  ctx: CodegenContext;
  moduleId: string;
  name: string;
  paramCount?: number;
}): SymbolId | undefined => {
  const moduleView = ctx.program.modules.get(moduleId);
  if (!moduleView) {
    return undefined;
  }
  for (const item of moduleView.hir.items.values()) {
    if (item.kind !== "function") continue;
    const symbolName =
      ctx.program.symbols.getName(
        ctx.program.symbols.idOf({ moduleId, symbol: item.symbol })
      ) ?? "";
    if (symbolName !== name) continue;
    if (typeof paramCount === "number") {
      const signature = ctx.program.functions.getSignature(moduleId, item.symbol);
      if (!signature || signature.parameters.length !== paramCount) {
        continue;
      }
    }
    return item.symbol;
  }
  return undefined;
};

const sameTypeArgs = (left: readonly TypeId[], right: readonly TypeId[]): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index]);
