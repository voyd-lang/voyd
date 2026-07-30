import binaryen from "binaryen";
import type { CodegenContext, FunctionContext, HirExprId } from "./context.js";
import type { CodegenPlaceProjection } from "../semantics/codegen-view/index.js";
import type { TypeId } from "../semantics/ids.js";
import { loadStructuralField } from "./structural.js";
import { getStructuralTypeInfo } from "./types.js";
import { exactNominalForType } from "./optimization/runtime-type-checks.js";
import { compileFixedPanicTrap } from "./panic.js";

export type RuntimeIdentityGuardOperandInfo = {
  expression: HirExprId;
  identity: "allocation" | "storage" | "indexed-place";
  allocationPath?: readonly CodegenPlaceProjection[];
};

export const runtimeIdentityConflictMessage = ({
  leftDisplay,
  rightDisplay,
}: {
  leftDisplay: string;
  rightDisplay: string;
}): string =>
  `Runtime exclusivity conflict: ${leftDisplay} overlaps ${rightDisplay}`;

type RuntimeIdentityComponent = {
  kind: "reference" | "i32";
  value: binaryen.ExpressionRef;
};

export const projectRuntimeAllocationIdentity = ({
  allocation,
  typeId,
  path,
  context,
  ctx,
}: {
  allocation: binaryen.ExpressionRef;
  typeId: TypeId;
  path: readonly CodegenPlaceProjection[];
  context: string;
  ctx: CodegenContext;
}): binaryen.ExpressionRef => {
  let value = allocation;
  let currentType = typeId;
  path.forEach((projection) => {
    if (projection.kind === "dereference" || projection.kind === "identity") {
      return;
    }
    const structInfo = getStructuralTypeInfo(currentType, ctx);
    const field =
      projection.kind === "field"
        ? structInfo?.fields.find(
            (candidate) => candidate.name === projection.name,
          )
        : projection.kind === "tuple"
          ? structInfo?.fields[projection.index]
          : undefined;
    if (!structInfo || !field) {
      throw new Error(
        `runtime identity guard cannot project ${projection.kind} (${context})`,
      );
    }
    const pointer = value;
    value = loadStructuralField({
      structInfo,
      field,
      pointer: () => pointer,
      exactNominalTypeId: exactNominalForType({ typeId: currentType, ctx }),
      ctx,
    });
    currentType = field.typeId;
  });
  assertReferenceOperand(value, context);
  return value;
};

export const compileRuntimeIdentityGuard = ({
  left,
  right,
  leftDisplay,
  rightDisplay,
  context,
  ctx,
}: {
  left: readonly RuntimeIdentityComponent[];
  right: readonly RuntimeIdentityComponent[];
  leftDisplay: string;
  rightDisplay: string;
  context: string;
  ctx: CodegenContext;
}): binaryen.ExpressionRef => {
  const equal = compileRuntimeIdentityConflict({ left, right, context, ctx });
  return ctx.mod.if(
    equal,
    compileFixedPanicTrap({
      message: runtimeIdentityConflictMessage({ leftDisplay, rightDisplay }),
      ctx,
    }),
  );
};

export const compileRuntimeIdentityConflict = ({
  left,
  right,
  context,
  ctx,
}: {
  left: readonly RuntimeIdentityComponent[];
  right: readonly RuntimeIdentityComponent[];
  context: string;
  ctx: CodegenContext;
}): binaryen.ExpressionRef => {
  if (left.length === 0 || left.length !== right.length) {
    throw new Error(`runtime identity shape mismatch (${context})`);
  }
  return left
    .map((component, index) => {
      const other = right[index]!;
      if (component.kind !== other.kind) {
        throw new Error(`runtime identity component mismatch (${context})`);
      }
      if (component.kind === "i32") {
        return ctx.mod.i32.eq(component.value, other.value);
      }
      assertReferenceOperand(component.value, context);
      assertReferenceOperand(other.value, context);
      return ctx.mod.ref.eq(component.value, other.value);
    })
    .reduce(
      (result, comparison) => ctx.mod.i32.and(result, comparison),
      ctx.mod.i32.const(1),
    );
};

export const runtimeIdentityForGuardOperand = ({
  operand,
  allocation,
  context,
  ctx,
  fnCtx,
}: {
  operand: RuntimeIdentityGuardOperandInfo;
  allocation: binaryen.ExpressionRef;
  context: string;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): readonly RuntimeIdentityComponent[] => {
  if (operand.identity === "allocation" || operand.identity === "storage") {
    assertReferenceOperand(allocation, context);
    return [{ kind: "reference", value: allocation }];
  }
  const place = findRuntimePlaceIdentity(operand.expression, ctx, fnCtx);
  if (!place) {
    throw new Error(
      `runtime identity guard is missing projected place ${operand.expression} (${context})`,
    );
  }
  return [
    {
      kind: "reference",
      value: ctx.mod.local.get(
        place.backingLocal.index,
        place.backingLocal.type,
      ),
    },
    {
      kind: "i32",
      value: ctx.mod.local.get(place.indexLocal.index, place.indexLocal.type),
    },
  ];
};

export const assertNoRuntimeIdentityGuards = ({
  callId,
  lowering,
  ctx,
}: {
  callId: HirExprId;
  lowering: string;
  ctx: CodegenContext;
}): void => {
  const guards = ctx.program.calls.getCallInfo(
    ctx.moduleId,
    callId,
  ).identityGuards;
  if (guards.length > 0) {
    throw new Error(
      `${lowering} cannot discard ${guards.length} runtime identity guard(s) at call ${callId}`,
    );
  }
};

export const prepareRuntimeIdentityGuardsForCall = ({
  callId,
  ctx,
  fnCtx,
}: {
  callId: HirExprId;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): void => {
  const indexedPlaceExpressions = ctx.program.calls
    .getCallInfo(ctx.moduleId, callId)
    .identityGuards.flatMap((guard) =>
      [guard.left, guard.right].flatMap((operand) =>
        operand.identity === "indexed-place" ? [operand.expression] : [],
      ),
    );
  if (indexedPlaceExpressions.length === 0) {
    return;
  }
  const requests = fnCtx.runtimePlaceIdentityRequests ?? new Set<HirExprId>();
  const addRequest = (exprId: HirExprId): void => {
    if (requests.has(exprId)) {
      return;
    }
    requests.add(exprId);
    const expression = ctx.module.hir.expressions.get(exprId);
    if (expression?.exprKind === "call" && expression.args.length === 1) {
      addRequest(expression.args[0]!.expr);
    }
  };
  indexedPlaceExpressions.forEach(addRequest);
  fnCtx.runtimePlaceIdentityRequests = requests;
};

const findRuntimePlaceIdentity = (
  exprId: HirExprId,
  ctx: CodegenContext,
  fnCtx: FunctionContext,
): import("./context.js").RuntimePlaceIdentity | undefined => {
  const direct = fnCtx.runtimePlaceIdentities?.get(exprId);
  if (direct) {
    return direct;
  }
  const expr = ctx.module.hir.expressions.get(exprId);
  if (expr?.exprKind !== "call" || expr.args.length !== 1) {
    return undefined;
  }
  return findRuntimePlaceIdentity(expr.args[0]!.expr, ctx, fnCtx);
};

const assertReferenceOperand = (
  operand: binaryen.ExpressionRef,
  context: string,
): void => {
  const type = binaryen.getExpressionType(operand);
  if (
    new Set([
      binaryen.none,
      binaryen.unreachable,
      binaryen.i32,
      binaryen.i64,
      binaryen.f32,
      binaryen.f64,
    ]).has(type)
  ) {
    throw new Error(
      `runtime identity guard requires reference operands (${context})`,
    );
  }
};
