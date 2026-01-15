import type { ProgramFunctionInstanceId, TypeId, TypeParamId } from "../semantics/ids.js";
import type { CodegenContext } from "./context.js";

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
    if (!signature || signature.typeParams.length === 0) {
      return undefined;
    }
    if (signature.typeParams.length !== meta.typeArgs.length) {
      return undefined;
    }
    return new Map(
      signature.typeParams.map((param, index) => [
        param.typeParam,
        meta.typeArgs[index]!,
      ])
    );
  }

  const instance = ctx.program.functions.getInstance(typeInstanceId);
  if (instance.symbolRef.moduleId !== ctx.moduleId) {
    return undefined;
  }
  const signature = ctx.program.functions.getSignature(
    instance.symbolRef.moduleId,
    instance.symbolRef.symbol
  );
  if (!signature || signature.typeParams.length === 0) {
    return undefined;
  }
  if (signature.typeParams.length !== instance.typeArgs.length) {
    return undefined;
  }
  return new Map(
    signature.typeParams.map((param, index) => [
      param.typeParam,
      instance.typeArgs[index]!,
    ])
  );
};
