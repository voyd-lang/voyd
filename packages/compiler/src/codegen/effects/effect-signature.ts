import type { CodegenContext } from "../context.js";
import type { HirExprId, ProgramFunctionInstanceId, SymbolId, TypeId, TypeParamId } from "../../semantics/ids.js";
import { buildInstanceSubstitution } from "../type-substitution.js";
import { walkHirExpression } from "../hir-walk.js";

type EffectSignature = NonNullable<
  ReturnType<CodegenContext["program"]["functions"]["getSignature"]>
>;

export const collectEffectTypeArgs = ({
  ctx,
  handlerBody,
  operation,
}: {
  ctx: CodegenContext;
  handlerBody: HirExprId;
  operation: SymbolId;
}): readonly TypeId[] | undefined => {
  const candidates: TypeId[][] = [];
  walkHirExpression({
    exprId: handlerBody,
    ctx,
    visitLambdaBodies: true,
    visitHandlerBodies: true,
    visitor: {
      onExpr: (exprId) => {
        const expr = ctx.module.hir.expressions.get(exprId);
        if (!expr || expr.exprKind !== "call") return;
        const callee = ctx.module.hir.expressions.get(expr.callee);
        if (!callee || callee.exprKind !== "identifier") return;
        if (callee.symbol !== operation) return;
        const typeArgs = ctx.program.calls.getCallInfo(ctx.moduleId, exprId).typeArgs;
        if (typeArgs && typeArgs.length > 0) {
          candidates.push([...typeArgs]);
        }
      },
    },
  });
  if (candidates.length === 0) return undefined;
  const first = candidates[0]!;
  const compatible = candidates.every(
    (candidate) =>
      candidate.length === first.length &&
      candidate.every((entry, index) => entry === first[index])
  );
  if (!compatible) {
    const symbolId = ctx.program.symbols.idOf({
      moduleId: ctx.moduleId,
      symbol: operation,
    });
    const opName = ctx.program.symbols.getName(symbolId) ?? `${operation}`;
    throw new Error(
      `mixed generic instantiations for effect operation ${opName} in handler body`
    );
  }
  return first;
};

export const buildEffectTypeSubstitution = ({
  ctx,
  typeInstanceId,
  signature,
  typeArgs,
}: {
  ctx: CodegenContext;
  typeInstanceId?: ProgramFunctionInstanceId;
  signature: EffectSignature;
  typeArgs?: readonly TypeId[];
}): Map<TypeParamId, TypeId> => {
  const substitution = new Map<TypeParamId, TypeId>();
  const instanceSubstitution = buildInstanceSubstitution({ ctx, typeInstanceId });
  instanceSubstitution?.forEach((value, key) => {
    substitution.set(key, value);
  });

  if (
    signature.typeParams.length > 0 &&
    typeArgs &&
    typeArgs.length === signature.typeParams.length
  ) {
    signature.typeParams.forEach((param, index) => {
      const typeArg = typeArgs[index];
      if (typeof typeArg !== "number") return;
      const resolvedArg = instanceSubstitution
        ? ctx.program.types.substitute(typeArg, instanceSubstitution)
        : typeArg;
      substitution.set(param.typeParam, resolvedArg);
    });
  }

  return substitution;
};
