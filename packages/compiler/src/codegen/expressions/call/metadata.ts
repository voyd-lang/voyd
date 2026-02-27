import type { FunctionMetadata, HirExprId } from "../../context.js";
import type { ProgramFunctionInstanceId } from "../../../semantics/ids.js";
import { buildInstanceSubstitution } from "../../type-substitution.js";
import { typeContainsUnresolvedParam } from "../../../semantics/type-utils.js";
import type { CodegenContext } from "../../context.js";

export const getFunctionMetadataForCall = ({
  symbol,
  callId,
  ctx,
  moduleId,
  typeInstanceId,
}: {
  symbol: number;
  callId: HirExprId;
  ctx: CodegenContext;
  moduleId?: string;
  typeInstanceId?: ProgramFunctionInstanceId;
}): FunctionMetadata | undefined => {
  const callInfo = ctx.program.calls.getCallInfo(ctx.moduleId, callId);
  const rawTypeArgs = (() => {
    if (typeof typeInstanceId === "number") {
      const resolved = callInfo.typeArgs?.get(typeInstanceId);
      if (resolved) {
        return resolved;
      }
    }

    const template =
      callInfo.typeArgs &&
      Array.from(callInfo.typeArgs.values()).find((args) =>
        args.some((arg) =>
          typeContainsUnresolvedParam({
            typeId: arg,
            getTypeDesc: (id) => ctx.program.types.getTypeDesc(id),
          })
        )
      );
    if (template) {
      return template;
    }

    const singleton =
      callInfo.typeArgs && callInfo.typeArgs.size === 1
        ? callInfo.typeArgs.values().next().value
        : undefined;
    if (singleton) {
      return singleton;
    }

    return [];
  })();

  const substitution = buildInstanceSubstitution({ ctx, typeInstanceId });
  const typeArgs = substitution
    ? rawTypeArgs.map((arg) => ctx.program.types.substitute(arg, substitution))
    : rawTypeArgs;

  const candidates: { moduleId: string; symbol: number }[] = [
    { moduleId: moduleId ?? ctx.moduleId, symbol },
  ];

  if (!moduleId) {
    const targetId = ctx.program.imports.getTarget(ctx.moduleId, symbol);
    if (targetId) {
      const resolved = ctx.program.symbols.refOf(targetId);
      if (resolved.moduleId !== ctx.moduleId || resolved.symbol !== symbol) {
        candidates.push({
          moduleId: resolved.moduleId,
          symbol: resolved.symbol,
        });
      }
    }
  }

  for (const candidate of candidates) {
    const instanceId = ctx.program.functions.getInstanceId(
      candidate.moduleId,
      candidate.symbol,
      typeArgs
    );
    const instance =
      instanceId === undefined ? undefined : ctx.functionInstances.get(instanceId);
    if (instance) {
      return instance;
    }

    const metas = ctx.functions.get(candidate.moduleId)?.get(candidate.symbol);
    if (!metas || metas.length === 0) {
      continue;
    }

    if (typeArgs.length === 0) {
      const genericMeta = metas.find((meta) => meta.typeArgs.length === 0);
      if (genericMeta) {
        return genericMeta;
      }
    }

    const exact = metas.find(
      (meta) =>
        meta.typeArgs.length === typeArgs.length &&
        meta.typeArgs.every((arg, index) => arg === typeArgs[index])
    );
    if (exact) {
      return exact;
    }

    if (typeArgs.length > 0) {
      continue;
    }

    return metas[0];
  }

  return undefined;
};
