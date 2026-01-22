import type { ProgramFunctionInstanceId, TypeId, TypeParamId } from "../semantics/ids.js";
import type { CodegenContext } from "./context.js";

const buildSubstitutionFromSignature = ({
  signature,
  typeArgs,
  ctx,
}: {
  signature: { scheme: number; typeParams?: readonly { typeParam: TypeParamId }[] };
  typeArgs: readonly TypeId[];
  ctx: CodegenContext;
}): Map<TypeParamId, TypeId> | undefined => {
  if (typeArgs.length === 0) {
    return undefined;
  }

  const paramIds =
    signature.typeParams && signature.typeParams.length > 0
      ? signature.typeParams.map((param) => param.typeParam)
      : [];
  if (paramIds.length === typeArgs.length) {
    return new Map(paramIds.map((param, index) => [param, typeArgs[index]!] as const));
  }

  const scheme = ctx.program.types.getScheme(signature.scheme);
  if (scheme.params.length === typeArgs.length) {
    return new Map(
      scheme.params.map((param, index) => [param, typeArgs[index]!] as const)
    );
  }

  return undefined;
};

export const buildInstanceSubstitution = ({
  ctx,
  typeInstanceId,
}: {
  ctx: CodegenContext;
  typeInstanceId?: ProgramFunctionInstanceId;
}): Map<TypeParamId, TypeId> | undefined => {
  if (typeof typeInstanceId !== "number") {
    return undefined;
  }
  const meta = ctx.functionInstances.get(typeInstanceId);
  if (meta) {
    const signature = ctx.program.functions.getSignature(meta.moduleId, meta.symbol);
    if (!signature) {
      return undefined;
    }
    return buildSubstitutionFromSignature({ signature, typeArgs: meta.typeArgs, ctx });
  }

  const instance = ctx.program.functions.getInstance(typeInstanceId);
  if (instance.symbolRef.moduleId !== ctx.moduleId) {
    return undefined;
  }
  const signature = ctx.program.functions.getSignature(
    instance.symbolRef.moduleId,
    instance.symbolRef.symbol
  );
  if (!signature) {
    return undefined;
  }
  return buildSubstitutionFromSignature({ signature, typeArgs: instance.typeArgs, ctx });
};
