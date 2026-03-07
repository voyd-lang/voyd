import type { HirFunction, HirNamedTypeExpr } from "../hir/index.js";
import type { HirExprId, TypeId } from "../ids.js";
import { walkExpression } from "../hir/walk.js";
import { emitDiagnostic, normalizeSpan } from "../../diagnostics/index.js";
import { getExprEffectRow } from "./effects.js";
import { resolveImportedTypeExpr } from "./imports.js";
import {
  getOptionalInfo,
  optionalResolverContextForTypingContext,
} from "./optionals.js";
import { ensureTypeMatches, resolveTypeAlias } from "./type-system.js";
import type {
  FunctionSignature,
  ParamSignature,
  TypingContext,
  TypingState,
} from "./types.js";

type TypeExpressionFn = (
  exprId: HirExprId,
  ctx: TypingContext,
  state: TypingState,
  options?: { expectedType?: TypeId },
) => TypeId;

export const resolveOptionalTypeForDefaultParameter = ({
  innerType,
  scope,
  functionName,
  parameterName,
  ctx,
  state,
}: {
  innerType: TypeId;
  scope: number;
  functionName: string;
  parameterName: string;
  ctx: TypingContext;
  state: TypingState;
}): TypeId => {
  const optionalResolverContext = optionalResolverContextForTypingContext(ctx);
  const attemptedSymbols = new Set<number>();

  const resolveViaSymbol = (symbol: number): TypeId | undefined => {
    if (attemptedSymbols.has(symbol)) {
      return undefined;
    }
    attemptedSymbols.add(symbol);

    const localTemplate = ctx.typeAliases.getTemplate(symbol);
    const resolved = localTemplate
      ? resolveTypeAlias(symbol, ctx, state, [innerType])
      : resolveImportedTypeExpr({
          expr: {
            typeKind: "named",
            path: [ctx.symbolTable.getSymbol(symbol).name],
            symbol,
            ast: ctx.hir.module.ast,
            span: ctx.hir.module.span,
          } satisfies HirNamedTypeExpr,
          typeArgs: [innerType],
          ctx,
          state,
        });
    if (typeof resolved !== "number") {
      return undefined;
    }
    return getOptionalInfo(resolved, optionalResolverContext)
      ? resolved
      : undefined;
  };

  const resolveByNameAtScope = ({
    name,
    scopeId,
  }: {
    name: string;
    scopeId: number;
  }): TypeId | undefined => {
    const symbol = ctx.symbolTable.resolve(name, scopeId);
    return typeof symbol === "number" ? resolveViaSymbol(symbol) : undefined;
  };

  const resolveAtScope = (scopeId: number): TypeId | undefined =>
    resolveByNameAtScope({ name: "Optional", scopeId }) ??
    resolveByNameAtScope({ name: "Option", scopeId });

  const resolveIntrinsicOptionalAlias = (): TypeId | undefined => {
    for (const template of ctx.typeAliases.templates()) {
      const metadata = (ctx.symbolTable.getSymbol(template.symbol).metadata ??
        {}) as {
        intrinsicType?: unknown;
      };
      if (metadata.intrinsicType !== "optional") {
        continue;
      }
      const resolved = resolveViaSymbol(template.symbol);
      if (typeof resolved === "number") {
        return resolved;
      }
    }
    return undefined;
  };

  const resolved =
    resolveAtScope(scope) ??
    resolveAtScope(ctx.symbolTable.rootScope) ??
    resolveIntrinsicOptionalAlias();
  if (typeof resolved === "number") {
    return resolved;
  }

  throw new Error(
    `default parameter ${parameterName} in function ${functionName} requires an optional type alias (for example Optional) to be in scope`,
  );
};

export const typeDefaultParameterValues = ({
  fn,
  signature,
  ctx,
  state,
  typeExpression,
}: {
  fn: HirFunction;
  signature: FunctionSignature;
  ctx: TypingContext;
  state: TypingState;
  typeExpression: TypeExpressionFn;
}): { effectRows: number[]; signatureUpdated: boolean } => {
  const hasDefaultParameters = fn.parameters.some(
    (param) => typeof param.defaultValue === "number",
  );
  if (!hasDefaultParameters) {
    return { effectRows: [], signatureUpdated: false };
  }

  const effectRows: number[] = [];
  const functionName = ctx.symbolTable.getSymbol(fn.symbol).name;
  const functionScope =
    (typeof fn.decl === "number"
      ? ctx.decls.getFunctionById(fn.decl)?.scope
      : undefined) ?? ctx.symbolTable.rootScope;
  const parameterIndexBySymbol = new Map(
    fn.parameters.map((param, index) => [param.symbol, index]),
  );
  let updatedParameters: ParamSignature[] | undefined;
  let signatureUpdated = false;

  fn.parameters.forEach((param, index) => {
    if (typeof param.defaultValue !== "number") {
      return;
    }
    const signatureParam = (updatedParameters ?? signature.parameters)[index];
    if (!signatureParam) {
      throw new Error(
        `missing signature parameter for default value in function ${functionName}`,
      );
    }
    const parameterName =
      signatureParam.name ?? ctx.symbolTable.getSymbol(param.symbol).name;
    assertNoForwardParameterReferenceInDefault({
      defaultExprId: param.defaultValue,
      parameterIndex: index,
      parameterIndexBySymbol,
      functionName,
      parameterName,
      span: param.span,
      ctx,
    });
    const optionalInfo = getOptionalInfo(
      signatureParam.type,
      optionalResolverContextForTypingContext(ctx),
    );
    const hasUnknownOptionalPlaceholder =
      signatureParam.optional === true &&
      signatureParam.type === ctx.primitives.unknown;
    if (!optionalInfo && !hasUnknownOptionalPlaceholder) {
      throw new Error("default parameter type must be Optional");
    }
    const expectedInnerType = optionalInfo?.innerType ?? ctx.primitives.unknown;
    const defaultType = typeExpression(
      param.defaultValue,
      ctx,
      state,
      expectedInnerType !== ctx.primitives.unknown
        ? { expectedType: expectedInnerType }
        : {},
    );
    const inferredInnerType =
      expectedInnerType === ctx.primitives.unknown
        ? defaultType
        : expectedInnerType;
    if (expectedInnerType !== ctx.primitives.unknown) {
      ensureTypeMatches(
        defaultType,
        expectedInnerType,
        ctx,
        state,
        `default value for parameter ${parameterName}`,
        param.span,
      );
    } else {
      const updatedOptionalType = resolveOptionalTypeForDefaultParameter({
        innerType: inferredInnerType,
        scope: functionScope,
        functionName,
        parameterName,
        ctx,
        state,
      });
      const currentParameters = updatedParameters
        ? [...updatedParameters]
        : signature.parameters.map((entry) => ({ ...entry }));
      currentParameters[index] = {
        ...currentParameters[index]!,
        type: updatedOptionalType,
      };
      updatedParameters = currentParameters;
      signatureUpdated = true;
    }
    ctx.valueTypes.set(param.symbol, inferredInnerType);
    effectRows.push(getExprEffectRow(param.defaultValue, ctx));
  });

  if (signatureUpdated && updatedParameters) {
    signature.parameters = updatedParameters;
  }

  return { effectRows, signatureUpdated };
};

const assertNoForwardParameterReferenceInDefault = ({
  defaultExprId,
  parameterIndex,
  parameterIndexBySymbol,
  functionName,
  parameterName,
  span,
  ctx,
}: {
  defaultExprId: HirExprId;
  parameterIndex: number;
  parameterIndexBySymbol: ReadonlyMap<number, number>;
  functionName: string;
  parameterName: string;
  span: { file: string; start: number; end: number };
  ctx: TypingContext;
}): void => {
  walkExpression({
    exprId: defaultExprId,
    hir: ctx.hir,
    onEnterExpression: (_exprId, expr) => {
      if (expr.exprKind !== "identifier") {
        return;
      }
      const referencedIndex = parameterIndexBySymbol.get(expr.symbol);
      if (referencedIndex === undefined || referencedIndex < parameterIndex) {
        return;
      }
      const referencedParameterName = ctx.symbolTable.getSymbol(expr.symbol).name;
      return emitDiagnostic({
        ctx,
        code: "TY0044",
        params: {
          kind: "default-parameter-forward-reference",
          functionName,
          parameterName,
          referencedParameterName,
        },
        span: normalizeSpan(expr.span, span, ctx.hir.module.span),
      });
    },
  });
};
