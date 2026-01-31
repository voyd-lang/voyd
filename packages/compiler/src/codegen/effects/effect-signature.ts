import type { CodegenContext } from "../context.js";
import type { HirExprId, ProgramFunctionInstanceId, SymbolId, TypeId, TypeParamId } from "../../semantics/ids.js";
import { buildInstanceSubstitution } from "../type-substitution.js";
import { walkHirExpression } from "../hir-walk.js";

type EffectSignature = NonNullable<
  ReturnType<CodegenContext["program"]["functions"]["getSignature"]>
>;

const shouldFallbackType = (typeId: TypeId, ctx: CodegenContext): boolean => {
  const desc = ctx.program.types.getTypeDesc(typeId);
  return desc.kind === "type-param-ref" || (desc.kind === "primitive" && desc.name === "unknown");
};

const resolveEffectTypeId = ({
  typeId,
  fallback,
  substitution,
  ctx,
}: {
  typeId: TypeId;
  fallback?: TypeId;
  substitution?: Map<TypeParamId, TypeId>;
  ctx: CodegenContext;
}): TypeId => {
  const base =
    shouldFallbackType(typeId, ctx) && typeof fallback === "number" ? fallback : typeId;
  return substitution ? ctx.program.types.substitute(base, substitution) : base;
};

const resolveExprType = (exprId: HirExprId, ctx: CodegenContext): TypeId | undefined => {
  const resolved = ctx.module.types.getResolvedExprType(exprId);
  if (typeof resolved === "number") {
    return resolved;
  }
  const typeId = ctx.module.types.getExprType(exprId);
  return typeof typeId === "number" ? typeId : undefined;
};

const isUnknownType = (typeId: TypeId, ctx: CodegenContext): boolean => {
  const desc = ctx.program.types.getTypeDesc(typeId);
  return desc.kind === "primitive" && desc.name === "unknown";
};

const bindTypeParamsFromType = ({
  expected,
  actual,
  bindings,
  ctx,
  seen,
  conflict,
}: {
  expected: TypeId;
  actual: TypeId;
  bindings: Map<TypeParamId, TypeId>;
  ctx: CodegenContext;
  seen: Set<string>;
  conflict: { value: boolean };
}): void => {
  if (conflict.value) {
    return;
  }
  if (isUnknownType(actual, ctx)) {
    return;
  }
  const key = `${expected}:${actual}`;
  if (seen.has(key)) {
    return;
  }
  seen.add(key);

  const expectedDesc = ctx.program.types.getTypeDesc(expected);
  if (expectedDesc.kind === "type-param-ref") {
    const existing = bindings.get(expectedDesc.param);
    if (!existing || isUnknownType(existing, ctx)) {
      bindings.set(expectedDesc.param, actual);
      return;
    }
    if (existing !== actual) {
      conflict.value = true;
    }
    return;
  }

  if (expectedDesc.kind === "nominal-object" || expectedDesc.kind === "trait") {
    const actualDesc = ctx.program.types.getTypeDesc(actual);
    if (actualDesc.kind !== expectedDesc.kind || actualDesc.owner !== expectedDesc.owner) {
      return;
    }
    expectedDesc.typeArgs.forEach((typeArg, index) => {
      const actualArg = actualDesc.typeArgs[index];
      if (typeof actualArg === "number") {
        bindTypeParamsFromType({
          expected: typeArg,
          actual: actualArg,
          bindings,
          ctx,
          seen,
          conflict,
        });
      }
    });
    return;
  }

  if (expectedDesc.kind === "structural-object") {
    const actualDesc = ctx.program.types.getTypeDesc(actual);
    if (actualDesc.kind !== "structural-object") {
      return;
    }
    expectedDesc.fields.forEach((field) => {
      const candidate = actualDesc.fields.find((entry) => entry.name === field.name);
      if (candidate) {
        bindTypeParamsFromType({
          expected: field.type,
          actual: candidate.type,
          bindings,
          ctx,
          seen,
          conflict,
        });
      }
    });
    return;
  }

  if (expectedDesc.kind === "function") {
    const actualDesc = ctx.program.types.getTypeDesc(actual);
    if (actualDesc.kind !== "function") {
      return;
    }
    if (expectedDesc.parameters.length !== actualDesc.parameters.length) {
      return;
    }
    expectedDesc.parameters.forEach((param, index) => {
      const actualParam = actualDesc.parameters[index];
      if (!actualParam) {
        return;
      }
      bindTypeParamsFromType({
        expected: param.type,
        actual: actualParam.type,
        bindings,
        ctx,
        seen,
        conflict,
      });
    });
    bindTypeParamsFromType({
      expected: expectedDesc.returnType,
      actual: actualDesc.returnType,
      bindings,
      ctx,
      seen,
      conflict,
    });
    return;
  }

  if (expectedDesc.kind === "fixed-array") {
    const actualDesc = ctx.program.types.getTypeDesc(actual);
    if (actualDesc.kind !== "fixed-array") {
      return;
    }
    bindTypeParamsFromType({
      expected: expectedDesc.element,
      actual: actualDesc.element,
      bindings,
      ctx,
      seen,
      conflict,
    });
    return;
  }

  if (expectedDesc.kind === "intersection") {
    if (typeof expectedDesc.nominal === "number") {
      bindTypeParamsFromType({
        expected: expectedDesc.nominal,
        actual,
        bindings,
        ctx,
        seen,
        conflict,
      });
    }
    if (typeof expectedDesc.structural === "number") {
      bindTypeParamsFromType({
        expected: expectedDesc.structural,
        actual,
        bindings,
        ctx,
        seen,
        conflict,
      });
    }
    expectedDesc.traits?.forEach((trait) =>
      bindTypeParamsFromType({
        expected: trait,
        actual,
        bindings,
        ctx,
        seen,
        conflict,
      }),
    );
  }
};

const inferEffectTypeArgsFromCall = ({
  ctx,
  signature,
  callExprId,
}: {
  ctx: CodegenContext;
  signature: EffectSignature;
  callExprId: HirExprId;
}): readonly TypeId[] | undefined => {
  if (signature.typeParams.length === 0) {
    return undefined;
  }
  const callExpr = ctx.module.hir.expressions.get(callExprId);
  if (!callExpr || callExpr.exprKind !== "call") {
    return undefined;
  }

  const bindings = new Map<TypeParamId, TypeId>();
  const conflict = { value: false };
  const seen = new Set<string>();

  signature.parameters.forEach((param, index) => {
    const arg = callExpr.args[index];
    if (!arg) {
      return;
    }
    const argType = resolveExprType(arg.expr, ctx);
    if (typeof argType !== "number") {
      return;
    }
    bindTypeParamsFromType({
      expected: param.typeId,
      actual: argType,
      bindings,
      ctx,
      seen,
      conflict,
    });
  });

  const returnType = resolveExprType(callExprId, ctx);
  if (typeof returnType === "number") {
    bindTypeParamsFromType({
      expected: signature.returnType,
      actual: returnType,
      bindings,
      ctx,
      seen,
      conflict,
    });
  }

  if (conflict.value) {
    return undefined;
  }

  const typeArgs = signature.typeParams.map((param) => bindings.get(param.typeParam));
  if (typeArgs.some((arg) => typeof arg !== "number")) {
    return undefined;
  }
  if (typeArgs.some((arg) => isUnknownType(arg as TypeId, ctx))) {
    return undefined;
  }
  return typeArgs as TypeId[];
};

export const collectEffectTypeArgs = ({
  ctx,
  typeInstanceId,
  handlerBody,
  operation,
}: {
  ctx: CodegenContext;
  typeInstanceId?: ProgramFunctionInstanceId;
  handlerBody: HirExprId;
  operation: SymbolId;
}): readonly TypeId[] | undefined => {
  const signature = ctx.program.functions.getSignature(ctx.moduleId, operation);
  if (!signature || signature.typeParams.length === 0) {
    return undefined;
  }
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
        const callInfo = ctx.program.calls.getCallInfo(ctx.moduleId, exprId);
        const resolvedTypeArgs = (() => {
          if (typeof typeInstanceId === "number") {
            return callInfo.typeArgs?.get(typeInstanceId);
          }
          if (callInfo.typeArgs && callInfo.typeArgs.size === 1) {
            return callInfo.typeArgs.values().next().value;
          }
          return undefined;
        })();
        const inferredTypeArgs =
          resolvedTypeArgs && resolvedTypeArgs.length > 0
            ? resolvedTypeArgs
            : inferEffectTypeArgsFromCall({
                ctx,
                signature,
                callExprId: exprId,
              });
        const typeArgs = inferredTypeArgs;
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

export const resolveEffectSignatureTypes = ({
  ctx,
  signature,
  typeInstanceId,
  typeArgs,
  substitution,
  paramTypes,
  fallbackParams,
  returnType,
  fallbackReturnType,
}: {
  ctx: CodegenContext;
  signature?: EffectSignature;
  typeInstanceId?: ProgramFunctionInstanceId;
  typeArgs?: readonly TypeId[];
  substitution?: Map<TypeParamId, TypeId>;
  paramTypes: readonly TypeId[];
  fallbackParams?: readonly (TypeId | undefined)[];
  returnType: TypeId;
  fallbackReturnType?: TypeId;
}): { params: readonly TypeId[]; returnType: TypeId } => {
  const resolvedSubstitution =
    substitution ??
    (signature
      ? buildEffectTypeSubstitution({ ctx, typeInstanceId, signature, typeArgs })
      : undefined);
  const activeSubstitution =
    resolvedSubstitution && resolvedSubstitution.size > 0
      ? resolvedSubstitution
      : undefined;
  const resolvedParams = paramTypes.map((typeId, index) =>
    resolveEffectTypeId({
      typeId,
      fallback: fallbackParams ? fallbackParams[index] : undefined,
      substitution: activeSubstitution,
      ctx,
    })
  );
  const resolvedReturnType = resolveEffectTypeId({
    typeId: returnType,
    fallback: fallbackReturnType,
    substitution: activeSubstitution,
    ctx,
  });
  return { params: resolvedParams, returnType: resolvedReturnType };
};
