import type binaryen from "binaryen";
import type { CodegenContext, FunctionMetadata } from "./context.js";
import type { SymbolId, TypeId } from "../semantics/ids.js";
import type { CodegenTraitImplInstance } from "../semantics/codegen-view/index.js";

const hiddenParamOffsetFor = (meta: FunctionMetadata): number =>
  meta.effectful
    ? Math.max(0, meta.paramTypes.length - meta.paramTypeIds.length)
    : 0;

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

export const pickTraitImplMethodMeta = ({
  metas,
  impl,
  runtimeType,
  ctx,
}: {
  metas: readonly FunctionMetadata[] | undefined;
  impl: CodegenTraitImplInstance;
  runtimeType: binaryen.Type;
  ctx: CodegenContext;
}): FunctionMetadata | undefined => {
  if (!metas || metas.length === 0) {
    return undefined;
  }
  const matchingTypeIds = metas.filter((meta) => {
    const receiverTypeIndex = hiddenParamOffsetFor(meta);
    const receiverTypeId = meta.paramTypeIds[0];
    return (
      receiverTypeMatches({
        receiverTypeId,
        expectedTypeId: impl.target,
        ctx,
      }) ||
      receiverTypeMatches({
        receiverTypeId,
        expectedTypeId: impl.trait,
        ctx,
      })
    );
  });
  const preferredTypeId = selectPreferredMethodMetadata(matchingTypeIds);
  if (preferredTypeId) {
    return preferredTypeId;
  }

  const matchingReceiver = metas.filter((meta) => {
    const receiverTypeIndex = hiddenParamOffsetFor(meta);
    const receiverType = meta.paramTypes[receiverTypeIndex] ?? runtimeType;
    return receiverType === runtimeType;
  });
  return selectPreferredMethodMetadata(matchingReceiver);
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

const selectPreferredMethodMetadata = (
  metas: readonly FunctionMetadata[],
): FunctionMetadata | undefined => {
  if (metas.length === 0) {
    return undefined;
  }
  const concrete = metas.find((meta) => meta.typeArgs.length === 0);
  return concrete ?? metas[0];
};

const receiverTypeMatches = ({
  receiverTypeId,
  expectedTypeId,
  ctx,
}: {
  receiverTypeId: TypeId | undefined;
  expectedTypeId: TypeId;
  ctx: CodegenContext;
}): boolean => {
  if (typeof receiverTypeId !== "number") {
    return false;
  }
  return ctx.program.types.unify(receiverTypeId, expectedTypeId, {
    location: ctx.module.hir.module.ast,
    reason: "trait method metadata selection",
    variance: "invariant",
  }).ok;
};

const sameTypeArgs = (left: readonly TypeId[], right: readonly TypeId[]): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index]);
