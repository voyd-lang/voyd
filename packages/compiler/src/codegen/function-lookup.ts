import type binaryen from "binaryen";
import type { CodegenContext, FunctionMetadata } from "./context.js";
import type { SymbolId, TypeId } from "../semantics/ids.js";
import type { CodegenTraitImplInstance } from "../semantics/codegen-view/index.js";
import type { CompilerFunctionContractId } from "../compiler-contracts/index.js";

export const requireFunctionMetaByCompilerContract = ({
  ctx,
  contractId,
  typeArgs,
}: {
  ctx: CodegenContext;
  contractId: CompilerFunctionContractId;
  typeArgs?: readonly TypeId[];
}): FunctionMetadata => {
  const programSymbol =
    ctx.program.symbols.resolveCompilerFunctionContract(contractId);
  if (typeof programSymbol !== "number") {
    throw new Error(`missing compiler function contract '${contractId}'`);
  }

  const { moduleId, symbol } = ctx.program.symbols.refOf(programSymbol);
  try {
    return requireFunctionMeta({ ctx, moduleId, symbol, typeArgs });
  } catch (error) {
    const detail = error instanceof Error ? `: ${error.message}` : "";
    throw new Error(
      `missing codegen metadata for compiler function contract '${contractId}'${detail}`,
      { cause: error },
    );
  }
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
    const receiverTypeIndex = meta.firstUserParamIndex;
    const receiverType = meta.paramTypes[receiverTypeIndex] ?? runtimeType;
    return receiverType === runtimeType;
  });
  return selectPreferredMethodMetadata(matchingReceiver);
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

export const receiverTypeMatches = ({
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
