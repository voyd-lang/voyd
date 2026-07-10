import type { HirFunction } from "../hir/index.js";
import type { HirExprId, TypeId, TypeParamId } from "../ids.js";
import { walkExpression } from "../hir/walk.js";
import { emitDiagnostic, normalizeSpan } from "../../diagnostics/index.js";
import { getExprEffectRow } from "./effects.js";
import { ensureTypeMatches } from "./type-system.js";
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

export const typeDefaultParameterValues = ({
  fn,
  signature,
  substitution,
  ctx,
  state,
  typeExpression,
}: {
  fn: HirFunction;
  signature: FunctionSignature;
  substitution?: ReadonlyMap<TypeParamId, TypeId>;
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
    const checkType = substitution
      ? ctx.arena.substitute(signatureParam.type, substitution)
      : signatureParam.type;
    const expectedInnerType = checkType;
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
    } else if (!substitution || substitution.size === 0) {
      const currentParameters = updatedParameters
        ? [...updatedParameters]
        : signature.parameters.map((entry) => ({ ...entry }));
      currentParameters[index] = {
        ...currentParameters[index]!,
        type: inferredInnerType,
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
