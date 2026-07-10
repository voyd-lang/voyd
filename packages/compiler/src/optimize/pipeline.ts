import type {
  HirExpression,
  HirFunction,
  HirModuleLet,
} from "../semantics/hir/index.js";
import { walkExpression } from "../semantics/hir/index.js";
import type {
  CodegenFunctionSignature,
  ModuleCodegenView,
  ProgramCodegenView,
} from "../semantics/codegen-view/index.js";
import { getSymbolTable } from "../semantics/_internal/symbol-table.js";
import { analyzeLambdaCaptures } from "../semantics/lowering/captures.js";
import type {
  HirExprId,
  ProgramFunctionId,
  ProgramFunctionInstanceId,
  ProgramSymbolId,
  SymbolId,
  TypeId,
} from "../semantics/ids.js";
import type { SemanticsPipelineResult } from "../semantics/pipeline.js";
import type { CodegenOptions } from "../codegen/context.js";
import {
  BOUNDARY_MSGPACK_CONTRACT_IDS,
  type CompilerFunctionContractId,
} from "../compiler-contracts/index.js";
import { type ProgramOptimizationPass } from "./pass.js";
import type {
  EscapeAnalysisEscapeReason,
  EscapeAnalysisOriginFact,
  EscapeAnalysisOriginKind,
  EscapeAnalysisParameterFact,
  CallShapeParameterState,
  CallShapeSpecializationRequest,
  OptimizedCallInfo,
  OptimizedModuleView,
  ProgramOptimizationResult,
} from "./ir.js";
import { MutableOptimizationContext } from "./context.js";
import { finalizeOptimization } from "./finalize.js";
import {
  runOptimizationPassSequence,
  runOptimizationPassesToFixedPoint,
} from "./runner.js";
import {
  createOptimizationSchedule,
  optimizationFixedPointIterationBudget,
} from "./schedule.js";
import { recordOptimizationBodyIndexCounters } from "./telemetry.js";
import {
  buildOptimizationIr,
  mutableExpressions,
  mutableHandlerClauseCaptures,
  mutableStatements,
  normalizeFunctionInstantiations,
  type MutableOptimizationIr,
} from "./state.js";

type ConstantValue =
  | { literalKind: "i32" | "f32" | "f64"; value: number }
  | { literalKind: "i64"; value: bigint }
  | { literalKind: "boolean"; value: boolean }
  | { literalKind: "string"; value: string }
  | { literalKind: "void"; value: "" };

const BOUNDARY_MSGPACK_DEPENDENT_INTRINSICS = new Set([
  "__retain_callback",
  "__boundary_retain_callback",
  "__boundary_value_to_msgpack",
  "__boundary_msgpack_to_value",
]);

const exprLiteralBoolean = (
  expr: HirExpression | undefined,
): boolean | undefined =>
  expr?.exprKind === "literal" && expr.literalKind === "boolean"
    ? expr.value === "true"
    : undefined;

const toLiteralExpr = ({
  original,
  constant,
}: {
  original: HirExpression;
  constant: ConstantValue;
}): HirExpression => ({
  kind: "expr",
  exprKind: "literal",
  id: original.id,
  ast: original.ast,
  span: original.span,
  typeHint: original.typeHint,
  literalKind: constant.literalKind,
  value:
    constant.literalKind === "boolean"
      ? constant.value
        ? "true"
        : "false"
      : constant.literalKind === "void"
        ? ""
        : `${constant.value}`,
});

const toValueBlockExpr = ({
  original,
  value,
}: {
  original: HirExpression;
  value: HirExprId;
}): HirExpression => ({
  kind: "expr",
  exprKind: "block",
  id: original.id,
  ast: original.ast,
  span: original.span,
  typeHint: original.typeHint,
  statements: [],
  value,
});

const nextHirId = ({
  moduleView,
}: {
  moduleView: OptimizedModuleView;
}): number =>
  Math.max(
    moduleView.hir.module.id,
    ...moduleView.hir.items.keys(),
    ...moduleView.hir.statements.keys(),
    ...moduleView.hir.expressions.keys(),
  ) + 1;

const toEvaluatedValueBlockExpr = ({
  original,
  moduleView,
  exprId,
  value,
}: {
  original: HirExpression;
  moduleView: OptimizedModuleView;
  exprId: HirExprId;
  value: HirExprId;
}): HirExpression => {
  const statementId = nextHirId({ moduleView });
  mutableStatements({ moduleView }).set(statementId, {
    id: statementId,
    kind: "expr-stmt",
    ast: original.ast,
    span: original.span,
    expr: exprId,
  });
  return {
    kind: "expr",
    exprKind: "block",
    id: original.id,
    ast: original.ast,
    span: original.span,
    typeHint: original.typeHint,
    statements: [statementId],
    value,
  };
};

const collectPostOrderExprIds = ({
  rootExprId,
  moduleView,
}: {
  rootExprId: HirExprId;
  moduleView: OptimizedModuleView;
}): HirExprId[] => {
  const ids: HirExprId[] = [];
  walkExpression({
    exprId: rootExprId,
    hir: moduleView.hir,
    onEnterExpression: (exprId) => {
      ids.push(exprId);
    },
  });
  return ids.reverse();
};

const collectModuleRootExprIds = ({
  moduleView,
}: {
  moduleView: OptimizedModuleView;
}): HirExprId[] => {
  const roots: HirExprId[] = [];
  moduleView.hir.items.forEach((item) => {
    if (item.kind === "function") {
      roots.push(
        item.body,
        ...item.parameters.flatMap((param) =>
          typeof param.defaultValue === "number" ? [param.defaultValue] : [],
        ),
      );
      return;
    }
    if (item.kind === "module-let") {
      roots.push(item.initializer);
    }
  });
  return roots;
};

const exactNominalForType = ({
  typeId,
  program,
}: {
  typeId: TypeId | undefined;
  program: ProgramCodegenView;
}): TypeId | undefined => {
  if (typeof typeId !== "number") {
    return undefined;
  }
  const desc = program.types.getTypeDesc(typeId);
  if (desc.kind === "nominal-object" || desc.kind === "value-object") {
    return typeId;
  }
  if (desc.kind === "intersection" && typeof desc.nominal === "number") {
    return desc.nominal;
  }
  return undefined;
};

const collectNominals = ({
  typeId,
  program,
  nominals,
}: {
  typeId: TypeId;
  program: ProgramCodegenView;
  nominals: Set<TypeId>;
}): void => {
  const desc = program.types.getTypeDesc(typeId);
  if (desc.kind === "union") {
    desc.members.forEach((member) =>
      collectNominals({ typeId: member, program, nominals }),
    );
    return;
  }
  const exact = exactNominalForType({ typeId, program });
  if (typeof exact === "number") {
    nominals.add(exact);
  }
};

const exprTypeFor = ({
  moduleView,
  exprId,
}: {
  moduleView: ModuleCodegenView;
  exprId: HirExprId;
}): TypeId | undefined =>
  moduleView.types.getResolvedExprType(exprId) ??
  moduleView.types.getExprType(exprId);

const I32_MIN = -(1n << 31n);
const I64_MIN = -(1n << 63n);

const wrapI32 = (value: bigint): number => Number(BigInt.asIntN(32, value));

const wrapI64 = (value: bigint): bigint => BigInt.asIntN(64, value);

const normalizeI32ShiftCount = (value: bigint): bigint =>
  BigInt.asUintN(32, value) & 31n;

const normalizeI64ShiftCount = (value: bigint): bigint =>
  BigInt.asUintN(64, value) & 63n;

const normalizeF32 = (value: number): number => Math.fround(value);

const constantF32Op = (
  left: number,
  right: number,
  op: string,
): number | undefined => {
  switch (op) {
    case "+":
      return normalizeF32(left + right);
    case "-":
      return normalizeF32(left - right);
    case "*":
      return normalizeF32(left * right);
    case "/":
      return normalizeF32(left / right);
    case "%":
      return normalizeF32(left % right);
    default:
      return undefined;
  }
};

const constantFloatOp = (
  left: number,
  right: number,
  op: string,
): number | undefined => {
  switch (op) {
    case "+":
      return left + right;
    case "-":
      return left - right;
    case "*":
      return left * right;
    case "/":
      return right === 0 ? undefined : left / right;
    case "%":
      return right === 0 ? undefined : left % right;
    default:
      return undefined;
  }
};

const constantI32Op = (
  left: number,
  right: number,
  op: string,
): number | undefined => {
  const leftBig = BigInt(left);
  const rightBig = BigInt(right);

  switch (op) {
    case "+":
      return wrapI32(leftBig + rightBig);
    case "-":
      return wrapI32(leftBig - rightBig);
    case "*":
      return wrapI32(leftBig * rightBig);
    case "/":
      if (rightBig === 0n) {
        return undefined;
      }
      if (leftBig === I32_MIN && rightBig === -1n) {
        return undefined;
      }
      return wrapI32(leftBig / rightBig);
    case "%":
      return rightBig === 0n ? undefined : wrapI32(leftBig % rightBig);
    case "__shift_l":
      return wrapI32(leftBig << normalizeI32ShiftCount(rightBig));
    case "__shift_ru":
      return wrapI32(
        BigInt.asUintN(32, leftBig) >> normalizeI32ShiftCount(rightBig),
      );
    case "__bit_and":
      return wrapI32(leftBig & rightBig);
    case "__bit_or":
      return wrapI32(leftBig | rightBig);
    case "__bit_xor":
      return wrapI32(leftBig ^ rightBig);
    default:
      return undefined;
  }
};

const constantI64Op = (
  left: bigint,
  right: bigint,
  op: string,
): bigint | undefined => {
  switch (op) {
    case "+":
      return wrapI64(left + right);
    case "-":
      return wrapI64(left - right);
    case "*":
      return wrapI64(left * right);
    case "/":
      if (right === 0n) {
        return undefined;
      }
      if (left === I64_MIN && right === -1n) {
        return undefined;
      }
      return wrapI64(left / right);
    case "%":
      return right === 0n ? undefined : wrapI64(left % right);
    case "__shift_l":
      return wrapI64(left << normalizeI64ShiftCount(right));
    case "__shift_ru":
      return wrapI64(BigInt.asUintN(64, left) >> normalizeI64ShiftCount(right));
    case "__bit_and":
      return wrapI64(left & right);
    case "__bit_or":
      return wrapI64(left | right);
    case "__bit_xor":
      return wrapI64(left ^ right);
    default:
      return undefined;
  }
};

const constantNumberCompareOp = (
  left: number,
  right: number,
  op: string,
): boolean | undefined => {
  switch (op) {
    case "<":
      return left < right;
    case "<=":
      return left <= right;
    case ">":
      return left > right;
    case ">=":
      return left >= right;
    case "==":
      return left === right;
    case "!=":
      return left !== right;
    default:
      return undefined;
  }
};

const constantI64CompareOp = (
  left: bigint,
  right: bigint,
  op: string,
): boolean | undefined => {
  switch (op) {
    case "<":
      return left < right;
    case "<=":
      return left <= right;
    case ">":
      return left > right;
    case ">=":
      return left >= right;
    case "==":
      return left === right;
    case "!=":
      return left !== right;
    default:
      return undefined;
  }
};

const constantBooleanOp = (
  left: boolean,
  right: boolean,
  op: string,
): boolean | undefined => {
  switch (op) {
    case "and":
      return left && right;
    case "or":
      return left || right;
    case "xor":
      return left !== right;
    case "==":
      return left === right;
    case "!=":
      return left !== right;
    default:
      return undefined;
  }
};

const parseConstantLiteral = (
  expr: HirExpression,
): ConstantValue | undefined => {
  if (expr.exprKind !== "literal") {
    return undefined;
  }
  switch (expr.literalKind) {
    case "i32":
    case "f64": {
      const parsed = Number(expr.value);
      return Number.isFinite(parsed)
        ? { literalKind: expr.literalKind, value: parsed }
        : undefined;
    }
    case "f32": {
      const parsed = Number(expr.value);
      return Number.isFinite(parsed)
        ? { literalKind: "f32", value: normalizeF32(parsed) }
        : undefined;
    }
    case "i64":
      try {
        return { literalKind: "i64", value: BigInt(expr.value) };
      } catch {
        return undefined;
      }
    case "boolean":
      return { literalKind: "boolean", value: expr.value === "true" };
    case "string":
      return { literalKind: "string", value: expr.value };
    case "void":
      return { literalKind: "void", value: "" };
    default:
      return undefined;
  }
};

const resolveCallTarget = ({
  callInfo,
  callerInstanceId,
}: {
  callInfo: OptimizedCallInfo;
  callerInstanceId?: ProgramFunctionInstanceId;
}): ProgramFunctionId | undefined => {
  if (
    typeof callerInstanceId === "number" &&
    typeof callInfo.targets?.get(callerInstanceId) === "number"
  ) {
    return callInfo.targets.get(callerInstanceId);
  }
  return callInfo.targets?.size === 1
    ? callInfo.targets.values().next().value
    : undefined;
};

const resolveCallTypeArgs = ({
  callInfo,
  callerInstanceId,
}: {
  callInfo: OptimizedCallInfo;
  callerInstanceId?: ProgramFunctionInstanceId;
}): readonly TypeId[] => {
  if (
    typeof callerInstanceId === "number" &&
    callInfo.typeArgs?.has(callerInstanceId)
  ) {
    return callInfo.typeArgs.get(callerInstanceId) ?? [];
  }
  return callInfo.typeArgs?.size === 1
    ? (callInfo.typeArgs.values().next().value ?? [])
    : [];
};

const resolveCallArgPlan = ({
  callInfo,
  callerInstanceId,
}: {
  callInfo: OptimizedCallInfo;
  callerInstanceId?: ProgramFunctionInstanceId;
}) => {
  if (
    typeof callerInstanceId === "number" &&
    callInfo.argPlans?.has(callerInstanceId)
  ) {
    return callInfo.argPlans.get(callerInstanceId);
  }
  return callInfo.argPlans?.size === 1
    ? callInfo.argPlans.values().next().value
    : undefined;
};

const callArgumentExprIdForParameter = ({
  argExprIds,
  callInfo,
  callerInstanceId,
  parameterIndex,
}: {
  argExprIds: readonly HirExprId[];
  callInfo: OptimizedCallInfo | undefined;
  callerInstanceId: ProgramFunctionInstanceId;
  parameterIndex: number;
}): HirExprId | undefined => {
  const argPlan = callInfo
    ? resolveCallArgPlan({ callInfo, callerInstanceId })
    : undefined;
  if (!argPlan) {
    return argExprIds[parameterIndex];
  }
  const entry = argPlan[parameterIndex];
  return entry?.kind === "direct" ? argExprIds[entry.argIndex] : undefined;
};

const isPureHelperCandidate = ({
  moduleId,
  symbol,
  program,
}: {
  moduleId: string;
  symbol: SymbolId;
  program: ProgramCodegenView;
}): HirFunction | undefined => {
  const signature = program.functions.getSignature(moduleId, symbol);
  if (!signature) {
    return undefined;
  }
  if (!program.effects.isEmpty(signature.effectRow)) {
    return undefined;
  }
  if (signature.typeParams.length > 0) {
    return undefined;
  }
  const moduleView = program.modules.get(moduleId);
  return Array.from(moduleView?.hir.items.values() ?? []).find(
    (item): item is HirFunction =>
      item.kind === "function" && item.symbol === symbol,
  );
};

const evaluateIntrinsic = ({
  name,
  args,
}: {
  name: string;
  args: readonly ConstantValue[];
}): ConstantValue | undefined => {
  if (
    args.length === 1 &&
    name === "not" &&
    args[0]?.literalKind === "boolean"
  ) {
    return { literalKind: "boolean", value: !args[0].value };
  }

  if (
    args.length === 1 &&
    name === "__f32_demote_f64" &&
    args[0]?.literalKind === "f64"
  ) {
    return { literalKind: "f32", value: normalizeF32(args[0].value) };
  }

  if (args.length === 2) {
    const [left, right] = args;
    if (left && right && left.literalKind === right.literalKind) {
      if (left.literalKind === "i64" && right.literalKind === "i64") {
        const compare = constantI64CompareOp(left.value, right.value, name);
        if (typeof compare === "boolean") {
          return { literalKind: "boolean", value: compare };
        }
        const computed = constantI64Op(left.value, right.value, name);
        if (typeof computed === "bigint") {
          return { literalKind: "i64", value: computed };
        }
      }

      if (left.literalKind === "i32" && right.literalKind === "i32") {
        const compare = constantNumberCompareOp(left.value, right.value, name);
        if (typeof compare === "boolean") {
          return { literalKind: "boolean", value: compare };
        }
        const computed = constantI32Op(left.value, right.value, name);
        if (typeof computed === "number") {
          return {
            literalKind: left.literalKind,
            value: computed,
          };
        }
      }

      if (left.literalKind === "f32" && right.literalKind === "f32") {
        const compare = constantNumberCompareOp(left.value, right.value, name);
        if (typeof compare === "boolean") {
          return { literalKind: "boolean", value: compare };
        }
        const computed = constantF32Op(left.value, right.value, name);
        if (typeof computed === "number") {
          return {
            literalKind: left.literalKind,
            value: computed,
          };
        }
      }

      if (left.literalKind === "f64" && right.literalKind === "f64") {
        const compare = constantNumberCompareOp(left.value, right.value, name);
        if (typeof compare === "boolean") {
          return { literalKind: "boolean", value: compare };
        }
        const computed = constantFloatOp(left.value, right.value, name);
        if (typeof computed === "number") {
          return {
            literalKind: left.literalKind,
            value: computed,
          };
        }
      }
    }

    if (left?.literalKind === "boolean" && right?.literalKind === "boolean") {
      const value = constantBooleanOp(left.value, right.value, name);
      if (typeof value === "boolean") {
        return { literalKind: "boolean", value };
      }
    }
  }

  return undefined;
};

const evaluateConstantExpr = ({
  exprId,
  moduleView,
  ir,
  localEnv,
  callerInstanceId,
  visited,
}: {
  exprId: HirExprId;
  moduleView: OptimizedModuleView;
  ir: MutableOptimizationIr;
  localEnv: Map<SymbolId, ConstantValue>;
  callerInstanceId?: ProgramFunctionInstanceId;
  visited: Set<string>;
}): ConstantValue | undefined => {
  const expr = moduleView.hir.expressions.get(exprId);
  if (!expr) {
    return undefined;
  }

  const literal = parseConstantLiteral(expr);
  if (literal) {
    return literal;
  }

  if (expr.exprKind === "identifier") {
    return localEnv.get(expr.symbol);
  }

  if (expr.exprKind === "block") {
    for (const statementId of expr.statements) {
      const statement = moduleView.hir.statements.get(statementId);
      if (!statement) {
        continue;
      }
      if (statement.kind === "let" && statement.pattern.kind === "identifier") {
        const value = evaluateConstantExpr({
          exprId: statement.initializer,
          moduleView,
          ir,
          localEnv,
          callerInstanceId,
          visited,
        });
        if (!value) {
          return undefined;
        }
        localEnv.set(statement.pattern.symbol, value);
        continue;
      }
      if (statement.kind === "expr-stmt") {
        if (
          !evaluateConstantExpr({
            exprId: statement.expr,
            moduleView,
            ir,
            localEnv,
            callerInstanceId,
            visited,
          })
        ) {
          return undefined;
        }
        continue;
      }
      return undefined;
    }
    if (typeof expr.value !== "number") {
      return { literalKind: "void", value: "" };
    }
    return evaluateConstantExpr({
      exprId: expr.value,
      moduleView,
      ir,
      localEnv,
      callerInstanceId,
      visited,
    });
  }

  const callInfo = ir.calls.get(moduleView.moduleId)?.get(exprId);
  if (expr.exprKind !== "call" && expr.exprKind !== "method-call") {
    return undefined;
  }

  const args = (
    expr.exprKind === "call" ? expr.args : [{ expr: expr.target }, ...expr.args]
  ).map((arg) =>
    evaluateConstantExpr({
      exprId: arg.expr,
      moduleView,
      ir,
      localEnv: new Map(localEnv),
      callerInstanceId,
      visited,
    }),
  );
  if (args.some((arg) => arg === undefined)) {
    return undefined;
  }

  const resolvedTargetId =
    callInfo && resolveCallTarget({ callInfo, callerInstanceId });
  const targetRef =
    typeof resolvedTargetId === "number"
      ? ir.baseProgram.symbols.refOf(resolvedTargetId as ProgramSymbolId)
      : undefined;
  const targetModuleId = targetRef?.moduleId ?? moduleView.moduleId;
  const targetSymbol =
    targetRef?.symbol ??
    (expr.exprKind === "call"
      ? (() => {
          const callee = moduleView.hir.expressions.get(expr.callee);
          return callee?.exprKind === "identifier" ? callee.symbol : undefined;
        })()
      : undefined);
  if (typeof targetSymbol !== "number") {
    return undefined;
  }

  const targetProgramSymbol = ir.baseProgram.symbols.canonicalIdOf(
    targetModuleId,
    targetSymbol,
  );
  const intrinsicName =
    ir.baseProgram.symbols.getIntrinsicName(targetProgramSymbol) ??
    ir.baseProgram.symbols.getName(targetProgramSymbol);
  const intrinsicFlags =
    ir.baseProgram.symbols.getIntrinsicFunctionFlags(targetProgramSymbol);
  if (
    intrinsicFlags.intrinsic === true &&
    intrinsicFlags.intrinsicUsesSignature !== true
  ) {
    return evaluateIntrinsic({
      name: intrinsicName ?? `${targetSymbol}`,
      args: args as ConstantValue[],
    });
  }

  const helperFn = isPureHelperCandidate({
    moduleId: targetModuleId,
    symbol: targetSymbol,
    program: ir.baseProgram,
  });
  if (!helperFn) {
    return undefined;
  }
  const visitKey = `${targetModuleId}:${targetSymbol}`;
  if (visited.has(visitKey)) {
    return undefined;
  }

  if (helperFn.parameters.length !== args.length) {
    return undefined;
  }

  const helperModule = ir.modules.get(targetModuleId);
  if (!helperModule) {
    return undefined;
  }

  const nextEnv = new Map<SymbolId, ConstantValue>();
  helperFn.parameters.forEach((parameter, index) => {
    nextEnv.set(parameter.symbol, args[index]!);
  });
  visited.add(visitKey);
  const result = evaluateConstantExpr({
    exprId: helperFn.body,
    moduleView: helperModule,
    ir,
    localEnv: nextEnv,
    callerInstanceId:
      callInfo && resolvedTargetId !== undefined
        ? ir.baseProgram.functions.getInstanceId(
            targetModuleId,
            targetSymbol,
            resolveCallTypeArgs({ callInfo, callerInstanceId }),
          )
        : undefined,
    visited,
  });
  visited.delete(visitKey);
  return result;
};

const pureCompileTimeEvaluationPass: ProgramOptimizationPass = {
  name: "pure-compile-time-evaluation",
  run(ctx) {
    let changed = false;
    let foldedCalls = 0;
    const changedModules = new Set<string>();

    ctx.ir.modules.forEach((moduleView) => {
      const rootExprIds = collectModuleRootExprIds({ moduleView });
      rootExprIds.forEach((rootExprId) => {
        collectPostOrderExprIds({ rootExprId, moduleView }).forEach(
          (exprId) => {
            const expr = moduleView.hir.expressions.get(exprId);
            if (
              !expr ||
              (expr.exprKind !== "call" && expr.exprKind !== "method-call")
            ) {
              return;
            }
            const constant = evaluateConstantExpr({
              exprId,
              moduleView,
              ir: ctx.ir as MutableOptimizationIr,
              localEnv: new Map(),
              visited: new Set(),
            });
            if (!constant) {
              return;
            }
            mutableExpressions({ moduleView }).set(
              exprId,
              toLiteralExpr({ original: expr, constant }),
            );
            changed = true;
            changedModules.add(moduleView.moduleId);
            foldedCalls += 1;
          },
        );
      });
    });

    return {
      changed,
      invalidates: changed
        ? ([
            "reachable-function-instances",
            "handler-captures",
            "trait-dispatch-signatures",
            "hir-body-topology",
          ] as const)
        : undefined,
      invalidatedHirModuleIds: [...changedModules],
      metrics: { folded_calls: foldedCalls },
    };
  },
};

const simplifyBooleanBranchPass: ProgramOptimizationPass = {
  name: "boolean-branch-simplification",
  run(ctx) {
    let changed = false;
    let removedBranches = 0;
    let simplifiedBranches = 0;
    const changedModules = new Set<string>();

    ctx.ir.modules.forEach((moduleView) => {
      const rootExprIds = collectModuleRootExprIds({ moduleView });
      rootExprIds.forEach((rootExprId) => {
        collectPostOrderExprIds({ rootExprId, moduleView }).forEach(
          (exprId) => {
            const expr = moduleView.hir.expressions.get(exprId);
            if (!expr || (expr.exprKind !== "if" && expr.exprKind !== "cond")) {
              return;
            }

            let sawUnknown = false;
            const nextBranches: Array<(typeof expr.branches)[number]> = [];
            let selectedValue: HirExprId | undefined;

            for (const branch of expr.branches) {
              const conditionExpr = moduleView.hir.expressions.get(
                branch.condition,
              );
              const constant = exprLiteralBoolean(conditionExpr);
              if (constant === false && !sawUnknown) {
                changed = true;
                changedModules.add(moduleView.moduleId);
                removedBranches += 1;
                continue;
              }
              if (constant === true && !sawUnknown) {
                selectedValue = branch.value;
                changed = true;
                changedModules.add(moduleView.moduleId);
                simplifiedBranches += 1;
                break;
              }
              sawUnknown = true;
              nextBranches.push(branch);
            }

            if (typeof selectedValue === "number") {
              mutableExpressions({ moduleView }).set(
                exprId,
                toValueBlockExpr({ original: expr, value: selectedValue }),
              );
              return;
            }

            if (
              nextBranches.length === 0 &&
              typeof expr.defaultBranch === "number"
            ) {
              mutableExpressions({ moduleView }).set(
                exprId,
                toValueBlockExpr({ original: expr, value: expr.defaultBranch }),
              );
              changed = true;
              changedModules.add(moduleView.moduleId);
              simplifiedBranches += 1;
              return;
            }

            if (nextBranches.length !== expr.branches.length) {
              mutableExpressions({ moduleView }).set(exprId, {
                ...expr,
                branches: nextBranches,
              });
            }
          },
        );
      });
    });

    return {
      changed,
      invalidates: changed
        ? ([
            "reachable-function-instances",
            "handler-captures",
            "hir-body-topology",
          ] as const)
        : undefined,
      invalidatedHirModuleIds: [...changedModules],
      metrics: {
        removed_branches: removedBranches,
        simplified_branches: simplifiedBranches,
      },
    };
  },
};

const constructorKnownSimplificationPass: ProgramOptimizationPass = {
  name: "constructor-known-simplification",
  run(ctx) {
    let changed = false;
    let simplifiedMatches = 0;
    const changedModules = new Set<string>();

    const exactDiscriminantType = ({
      moduleView,
      expr,
      functionItem,
    }: {
      moduleView: OptimizedModuleView;
      expr: Extract<HirExpression, { exprKind: "match" }>;
      functionItem?: HirFunction;
    }): TypeId | undefined => {
      const staticType = exactNominalForType({
        typeId: exprTypeFor({ moduleView, exprId: expr.discriminant }),
        program: ctx.ir.baseProgram,
      });
      if (typeof staticType === "number") {
        return staticType;
      }
      if (!functionItem) {
        return undefined;
      }

      const instanceTypes = new Set<TypeId>();
      for (const instanceId of ctx.ir.facts.reachableFunctionInstances) {
        const instance = ctx.ir.baseProgram.functions.getInstance(instanceId);
        if (
          instance.symbolRef.moduleId !== moduleView.moduleId ||
          instance.symbolRef.symbol !== functionItem.symbol
        ) {
          continue;
        }
        const exactType = exactNominalForExpr({
          moduleView,
          exprId: expr.discriminant,
          callerInstanceId: instanceId,
          program: ctx.ir.baseProgram,
          exactParameterTypes: ctx.ir.facts.exactParameterTypes,
        });
        if (typeof exactType !== "number") {
          return undefined;
        }
        instanceTypes.add(exactType);
        if (instanceTypes.size > 1) {
          return undefined;
        }
      }

      return instanceTypes.size === 1
        ? instanceTypes.values().next().value
        : undefined;
    };

    const simplifyRoot = ({
      moduleView,
      rootExprId,
      functionItem,
    }: {
      moduleView: OptimizedModuleView;
      rootExprId: HirExprId;
      functionItem?: HirFunction;
    }): void => {
      collectPostOrderExprIds({ rootExprId, moduleView }).forEach((exprId) => {
        const expr = moduleView.hir.expressions.get(exprId);
        if (!expr || expr.exprKind !== "match") {
          return;
        }

        const discriminantType = exactDiscriminantType({
          moduleView,
          expr,
          functionItem,
        });
        if (typeof discriminantType !== "number") {
          return;
        }

        const selectedArm = expr.arms.find((arm) => {
          if (arm.pattern.kind === "type" && arm.pattern.binding) {
            return false;
          }
          if (arm.pattern.kind !== "wildcard" && arm.pattern.kind !== "type") {
            return false;
          }
          if (arm.pattern.kind === "wildcard") {
            return true;
          }
          const patternTypeId =
            typeof arm.pattern.typeId === "number"
              ? arm.pattern.typeId
              : undefined;
          if (typeof patternTypeId !== "number") {
            return false;
          }
          const nominals = new Set<TypeId>();
          collectNominals({
            typeId: patternTypeId,
            program: ctx.ir.baseProgram,
            nominals,
          });
          return nominals.has(discriminantType);
        });

        if (!selectedArm) {
          return;
        }

        mutableExpressions({ moduleView }).set(
          exprId,
          toEvaluatedValueBlockExpr({
            original: expr,
            moduleView,
            exprId: expr.discriminant,
            value: selectedArm.value,
          }),
        );
        changed = true;
        changedModules.add(moduleView.moduleId);
        simplifiedMatches += 1;
      });
    };

    ctx.ir.modules.forEach((moduleView) => {
      moduleView.hir.items.forEach((item) => {
        if (item.kind === "function") {
          [
            item.body,
            ...item.parameters.flatMap((param) =>
              typeof param.defaultValue === "number"
                ? [param.defaultValue]
                : [],
            ),
          ].forEach((rootExprId) =>
            simplifyRoot({ moduleView, rootExprId, functionItem: item }),
          );
          return;
        }
        if (item.kind !== "module-let") {
          return;
        }
        simplifyRoot({ moduleView, rootExprId: item.initializer });
      });
    });

    return {
      changed,
      invalidates: changed
        ? ([
            "reachable-function-instances",
            "handler-captures",
            "hir-body-topology",
          ] as const)
        : undefined,
      invalidatedHirModuleIds: [...changedModules],
      metrics: { simplified_matches: simplifiedMatches },
    };
  },
};

const effectFastPathEliminationPass: ProgramOptimizationPass = {
  name: "effect-fast-path-elimination",
  run(ctx) {
    let changed = false;
    let eliminatedHandlers = 0;
    const changedModules = new Set<string>();

    ctx.ir.modules.forEach((moduleView) => {
      moduleView.hir.expressions.forEach((expr, exprId) => {
        if (
          expr.exprKind !== "effect-handler" ||
          typeof expr.finallyBranch === "number"
        ) {
          return;
        }
        const handlerInfo = moduleView.effectsInfo.handlers.get(exprId);
        if (!handlerInfo) {
          return;
        }
        const bodyEffectRow =
          moduleView.semantics.typing.effects.getExprEffect(expr.body) ??
          handlerInfo.effectRow;
        const row = ctx.ir.baseProgram.effects.getRow(bodyEffectRow);
        if (row.tailVar) {
          return;
        }
        const handledOps = new Set(
          handlerInfo.clauses
            .map(
              (clause) =>
                moduleView.effectsInfo.operations.get(clause.operation)?.name,
            )
            .filter((name): name is string => typeof name === "string"),
        );
        const canHandle = row.operations.some((operation) =>
          Array.from(handledOps).some(
            (handledName) =>
              operation.name === handledName ||
              operation.name.startsWith(`${handledName}(`),
          ),
        );
        if (canHandle) {
          return;
        }
        mutableExpressions({ moduleView }).set(
          exprId,
          toValueBlockExpr({ original: expr, value: expr.body }),
        );
        changed = true;
        changedModules.add(moduleView.moduleId);
        eliminatedHandlers += 1;
      });
    });

    return {
      changed,
      invalidates: changed
        ? ([
            "reachable-function-instances",
            "handler-captures",
            "trait-dispatch-signatures",
            "hir-body-topology",
          ] as const)
        : undefined,
      invalidatedHirModuleIds: [...changedModules],
      metrics: { eliminated_handlers: eliminatedHandlers },
    };
  },
};

const exactNominalForExpr = ({
  moduleView,
  exprId,
  callerInstanceId,
  program,
  exactParameterTypes,
}: {
  moduleView: ModuleCodegenView;
  exprId: HirExprId;
  callerInstanceId?: ProgramFunctionInstanceId;
  program: ProgramCodegenView;
  exactParameterTypes?: ReadonlyMap<
    ProgramFunctionInstanceId,
    ReadonlyMap<SymbolId, TypeId>
  >;
}): TypeId | undefined => {
  const typeId =
    typeof callerInstanceId === "number"
      ? (program.functions.getInstanceExprType(callerInstanceId, exprId) ??
        exprTypeFor({ moduleView, exprId }))
      : exprTypeFor({ moduleView, exprId });
  const exactStaticType = exactNominalForType({ typeId, program });
  if (typeof exactStaticType === "number") {
    return exactStaticType;
  }

  const expr = moduleView.hir.expressions.get(exprId);
  if (
    expr?.exprKind === "object-literal" &&
    expr.literalKind === "nominal" &&
    typeof expr.targetSymbol === "number"
  ) {
    const template = program.objects.getTemplate(
      program.symbols.idOf({
        moduleId: moduleView.moduleId,
        symbol: expr.targetSymbol,
      }),
    );
    if (typeof template?.nominal === "number") {
      return template.nominal;
    }
  }

  if (expr?.exprKind === "identifier" && typeof callerInstanceId === "number") {
    const exactParam = exactParameterTypes
      ?.get(callerInstanceId)
      ?.get(expr.symbol);
    if (typeof exactParam === "number") {
      return exactParam;
    }
  }

  return undefined;
};

const traitMethodKey = ({
  traitSymbol,
  traitMethodSymbol,
}: {
  traitSymbol: ProgramSymbolId;
  traitMethodSymbol: ProgramSymbolId;
}): string => `${traitSymbol}:${traitMethodSymbol}`;

const functionTypeSubstitution = ({
  signature,
  typeArgs,
  program,
}: {
  signature: NonNullable<
    ReturnType<ProgramCodegenView["functions"]["getSignature"]>
  >;
  typeArgs: readonly TypeId[];
  program: ProgramCodegenView;
}) => {
  if (typeArgs.length === 0) {
    return undefined;
  }
  const paramIds =
    signature.typeParams.length > 0
      ? signature.typeParams.map((param) => param.typeParam)
      : program.types.getScheme(signature.scheme).params;
  return paramIds.length === typeArgs.length
    ? new Map(
        paramIds.map((param, index) => [param, typeArgs[index]!] as const),
      )
    : undefined;
};

const receiverParamNominalForTypeArgs = ({
  signature,
  typeArgs,
  program,
}: {
  signature: NonNullable<
    ReturnType<ProgramCodegenView["functions"]["getSignature"]>
  >;
  typeArgs: readonly TypeId[];
  program: ProgramCodegenView;
}): TypeId | undefined => {
  const receiverType = signature.parameters[0]?.typeId;
  if (typeof receiverType !== "number") {
    return undefined;
  }
  const substitution = functionTypeSubstitution({
    signature,
    typeArgs,
    program,
  });
  const resolvedReceiverType = substitution
    ? program.types.substitute(receiverType, substitution)
    : receiverType;
  return exactNominalForType({ typeId: resolvedReceiverType, program });
};

const exactReceiverTraitTarget = ({
  callInfo,
  callerInstanceId,
  exactReceiver,
  program,
}: {
  callInfo: OptimizedCallInfo;
  callerInstanceId: ProgramFunctionInstanceId;
  exactReceiver: TypeId;
  program: ProgramCodegenView;
}):
  | { functionId: ProgramFunctionId; typeArgs: readonly TypeId[] }
  | undefined => {
  if (program.types.getTypeDesc(exactReceiver).kind !== "nominal-object") {
    return undefined;
  }
  const candidateTargets = new Set(
    Array.from(callInfo.targets?.values() ?? []),
  );
  if (candidateTargets.size === 0) {
    return undefined;
  }

  const candidateTraitMethods = new Set<string>();
  candidateTargets.forEach((target) => {
    const mapping = program.traits.getTraitMethodImpl(
      target as ProgramSymbolId,
    );
    if (!mapping) {
      return;
    }
    candidateTraitMethods.add(traitMethodKey(mapping));
  });

  const matches = new Set<ProgramFunctionId>();
  program.traits.getImplsByNominal(exactReceiver).forEach((impl) => {
    impl.methods.forEach((method) => {
      const methodKey = traitMethodKey({
        traitSymbol: impl.traitSymbol,
        traitMethodSymbol: method.traitMethod,
      });
      if (
        candidateTargets.has(method.implMethod) ||
        candidateTargets.has(method.traitMethod) ||
        candidateTraitMethods.has(methodKey)
      ) {
        matches.add(method.implMethod as ProgramFunctionId);
      }
    });
  });

  if (matches.size !== 1) {
    return undefined;
  }

  const functionId = matches.values().next().value;
  if (typeof functionId !== "number") {
    return undefined;
  }
  const targetRef = program.symbols.refOf(functionId as ProgramSymbolId);
  const signature = program.functions.getSignature(
    targetRef.moduleId,
    targetRef.symbol,
  );
  if (!signature) {
    return undefined;
  }

  const existingTypeArgs = resolveCallTypeArgs({ callInfo, callerInstanceId });
  const existingInstanceId = program.functions.getInstanceId(
    targetRef.moduleId,
    targetRef.symbol,
    existingTypeArgs,
  );
  if (
    typeof existingInstanceId === "number" &&
    receiverParamNominalForTypeArgs({
      signature,
      typeArgs: existingTypeArgs,
      program,
    }) === exactReceiver
  ) {
    return { functionId, typeArgs: existingTypeArgs };
  }

  const matchingInstantiations = Array.from(
    program.functions
      .getInstantiationInfo(targetRef.moduleId, targetRef.symbol)
      ?.values() ?? [],
  ).filter(
    (typeArgs) =>
      receiverParamNominalForTypeArgs({ signature, typeArgs, program }) ===
      exactReceiver,
  );
  if (matchingInstantiations.length !== 1) {
    return undefined;
  }
  return {
    functionId,
    typeArgs: matchingInstantiations[0]!,
  };
};

const devirtualizedCallInfo = ({
  moduleView,
  exprId,
  callInfo,
  program,
  exactParameterTypes,
}: {
  moduleView: OptimizedModuleView;
  exprId: HirExprId;
  callInfo: OptimizedCallInfo;
  program: ProgramCodegenView;
  exactParameterTypes?: ReadonlyMap<
    ProgramFunctionInstanceId,
    ReadonlyMap<SymbolId, TypeId>
  >;
}): OptimizedCallInfo | undefined => {
  if (
    !callInfo.traitDispatch ||
    !callInfo.targets ||
    callInfo.targets.size === 0
  ) {
    return undefined;
  }
  const expr = moduleView.hir.expressions.get(exprId);
  if (!expr || (expr.exprKind !== "call" && expr.exprKind !== "method-call")) {
    return undefined;
  }
  const receiverExprId =
    expr.exprKind === "method-call" ? expr.target : expr.args[0]?.expr;
  if (typeof receiverExprId !== "number") {
    return undefined;
  }
  const narrowedTargets = new Map(callInfo.targets);
  const narrowedTypeArgs = new Map(callInfo.typeArgs ?? []);
  let failedNarrowing = false;
  narrowedTargets.forEach((_target, callerInstanceId) => {
    const exactReceiver = exactNominalForExpr({
      moduleView,
      exprId: receiverExprId,
      callerInstanceId,
      program,
      exactParameterTypes,
    });
    if (typeof exactReceiver !== "number") {
      return;
    }
    const exactTarget = exactReceiverTraitTarget({
      callInfo,
      callerInstanceId,
      exactReceiver,
      program,
    });
    if (!exactTarget) {
      failedNarrowing = true;
      return;
    }
    narrowedTargets.set(callerInstanceId, exactTarget.functionId);
    narrowedTypeArgs.set(callerInstanceId, exactTarget.typeArgs);
  });
  if (failedNarrowing) {
    return undefined;
  }

  const uniqueTargets = new Set(narrowedTargets.values());
  if (uniqueTargets.size !== 1) {
    return undefined;
  }
  const hasConcreteReceiver = Array.from(narrowedTargets.keys()).every(
    (callerInstanceId) =>
      typeof exactNominalForExpr({
        moduleView,
        exprId: receiverExprId,
        callerInstanceId,
        program,
        exactParameterTypes,
      }) === "number",
  );
  if (!hasConcreteReceiver) {
    return undefined;
  }
  const target = uniqueTargets.values().next().value;
  if (typeof target !== "number") {
    return undefined;
  }
  const traitMethodImpl = program.traits.getTraitMethodImpl(
    target as ProgramSymbolId,
  );
  if (!traitMethodImpl) {
    return undefined;
  }
  return {
    ...callInfo,
    targets: narrowedTargets,
    typeArgs: narrowedTypeArgs,
    traitDispatch: false,
  };
};

const traitDispatchDevirtualizationPass: ProgramOptimizationPass = {
  name: "trait-dispatch-devirtualization",
  run(ctx) {
    let changed = false;
    let devirtualizedCalls = 0;

    ctx.ir.calls.forEach((callsByExpr, moduleId) => {
      const moduleView = ctx.ir.modules.get(moduleId);
      if (!moduleView) {
        return;
      }
      callsByExpr.forEach((callInfo, exprId) => {
        const next = devirtualizedCallInfo({
          moduleView,
          exprId,
          callInfo,
          program: ctx.ir.baseProgram,
          exactParameterTypes: ctx.ir.facts.exactParameterTypes,
        });
        if (!next) {
          return;
        }
        (callsByExpr as Map<HirExprId, OptimizedCallInfo>).set(exprId, next);
        changed = true;
        devirtualizedCalls += 1;
      });
    });

    return {
      changed,
      invalidates: changed
        ? ([
            "reachable-function-instances",
            "trait-dispatch-signatures",
          ] as const)
        : undefined,
      metrics: { devirtualized_calls: devirtualizedCalls },
    };
  },
};

const closureEnvironmentShrinkingPass: ProgramOptimizationPass = {
  name: "closure-environment-shrinking",
  run(ctx) {
    let changed = false;
    let removedCaptures = 0;

    ctx.ir.modules.forEach((moduleView) => {
      const beforeLambdas = Array.from(
        moduleView.hir.expressions.values(),
      ).filter(
        (expr): expr is Extract<HirExpression, { exprKind: "lambda" }> =>
          expr.exprKind === "lambda",
      );
      const before = beforeLambdas
        .map(
          (expr) =>
            `${expr.id}:${expr.captures.map((capture) => capture.symbol).join(",")}`,
        )
        .join("|");
      const beforeCaptureCount = beforeLambdas.reduce(
        (count, expr) => count + expr.captures.length,
        0,
      );

      analyzeLambdaCaptures({
        hir: moduleView.hir,
        symbolTable: getSymbolTable(moduleView.semantics),
        scopeByNode: moduleView.semantics.binding.scopeByNode,
      });

      const afterLambdas = Array.from(
        moduleView.hir.expressions.values(),
      ).filter(
        (expr): expr is Extract<HirExpression, { exprKind: "lambda" }> =>
          expr.exprKind === "lambda",
      );
      const after = afterLambdas
        .map(
          (expr) =>
            `${expr.id}:${expr.captures.map((capture) => capture.symbol).join(",")}`,
        )
        .join("|");
      if (before !== after) {
        changed = true;
      }
      const afterCaptureCount = afterLambdas.reduce(
        (count, expr) => count + expr.captures.length,
        0,
      );
      removedCaptures += Math.max(0, beforeCaptureCount - afterCaptureCount);
    });

    return {
      changed,
      invalidates: changed ? (["handler-captures"] as const) : undefined,
      metrics: { removed_captures: removedCaptures },
    };
  },
};

const collectHandlerCaptures = ({
  moduleView,
}: {
  moduleView: OptimizedModuleView;
}): Map<HirExprId, Map<number, readonly SymbolId[]>> => {
  const handlerCaptures = new Map<
    HirExprId,
    Map<number, readonly SymbolId[]>
  >();
  const symbolTable = getSymbolTable(moduleView.semantics);

  moduleView.hir.expressions.forEach((expr) => {
    if (expr.exprKind !== "effect-handler") {
      return;
    }
    const clauseCaptures = new Map<number, readonly SymbolId[]>();
    expr.handlers.forEach((clause, clauseIndex) => {
      const clauseParams = new Set(
        clause.parameters.map((parameter) => parameter.symbol),
      );
      const captures = new Set<SymbolId>();
      walkExpression({
        exprId: clause.body,
        hir: moduleView.hir,
        onEnterExpression: (_exprId, nestedExpr) => {
          if (nestedExpr.exprKind !== "identifier") {
            return;
          }
          if (clauseParams.has(nestedExpr.symbol)) {
            return;
          }
          const symbolRecord = symbolTable.getSymbol(nestedExpr.symbol);
          const metadata = (symbolRecord.metadata ?? {}) as {
            import?: unknown;
          };
          if (metadata.import) {
            return;
          }
          if (symbolRecord.scope === symbolTable.rootScope) {
            return;
          }
          captures.add(nestedExpr.symbol);
        },
      });
      clauseCaptures.set(
        clauseIndex,
        [...captures].sort((a, b) => a - b),
      );
    });
    handlerCaptures.set(expr.id, clauseCaptures);
  });

  return handlerCaptures;
};

const continuationAndHandlerEnvironmentShrinkingPass: ProgramOptimizationPass =
  {
    name: "continuation-handler-environment-shrinking",
    run(ctx) {
      let changed = false;
      let removedCaptures = 0;

      ctx.ir.modules.forEach((moduleView, moduleId) => {
        const captures = collectHandlerCaptures({
          moduleView,
        });
        const existing = ctx.ir.facts.handlerClauseCaptures.get(moduleId);
        const serialize = (
          value?:
            | ReadonlyMap<HirExprId, ReadonlyMap<number, readonly SymbolId[]>>
            | Map<HirExprId, Map<number, readonly SymbolId[]>>,
        ) =>
          JSON.stringify(
            Array.from(value?.entries() ?? []).map(([exprId, clauses]) => [
              exprId,
              Array.from(clauses.entries()),
            ]),
          );
        if (serialize(existing) !== serialize(captures)) {
          const captureCount = (
            value?: ReadonlyMap<
              HirExprId,
              ReadonlyMap<number, readonly SymbolId[]>
            >,
          ): number =>
            Array.from(value?.values() ?? []).reduce(
              (handlerCount, clauses) =>
                handlerCount +
                Array.from(clauses.values()).reduce(
                  (clauseCount, symbols) => clauseCount + symbols.length,
                  0,
                ),
              0,
            );
          removedCaptures += Math.max(
            0,
            captureCount(existing) - captureCount(captures),
          );
          mutableHandlerClauseCaptures({
            ir: ctx.ir as MutableOptimizationIr,
          }).set(moduleId, captures);
          changed = true;
        }
      });

      return { changed, metrics: { removed_captures: removedCaptures } };
    },
  };

const functionItemBySymbol = ({
  ir,
  moduleView,
  symbol,
}: {
  ir: MutableOptimizationIr;
  moduleView: ModuleCodegenView;
  symbol: SymbolId;
}): HirFunction | undefined =>
  ir.index.getFunction(moduleView.moduleId, symbol)?.item;

type IndexedInstanceCallSite = {
  moduleView: OptimizedModuleView;
  exprId: HirExprId;
  expr: Extract<HirExpression, { exprKind: "call" | "method-call" }>;
};

type InstanceCallSiteIndex = ReadonlyMap<
  ProgramFunctionInstanceId,
  readonly IndexedInstanceCallSite[]
>;

const buildInstanceCallSiteIndex = ({
  ir,
}: {
  ir: MutableOptimizationIr;
}): Map<ProgramFunctionInstanceId, IndexedInstanceCallSite[]> => {
  const callSites = new Map<
    ProgramFunctionInstanceId,
    IndexedInstanceCallSite[]
  >();
  ir.facts.reachableFunctionInstances.forEach((instanceId) => {
    const instance = ir.baseProgram.functions.getInstance(instanceId);
    const moduleView = ir.modules.get(instance.symbolRef.moduleId);
    const item = ir.index.getFunction(
      instance.symbolRef.moduleId,
      instance.symbolRef.symbol,
    )?.item;
    if (!moduleView || !item) {
      return;
    }
    const seenExprIds = new Set<HirExprId>();
    const indexed: IndexedInstanceCallSite[] = [];
    const roots = ir.index.getFunctionRootExprIds(
      moduleView.moduleId,
      item.symbol,
    );
    roots.forEach((rootExprId) => {
      ir.index
        .getBodyTopology({ moduleId: moduleView.moduleId, rootExprId })
        .callSiteExprIds.forEach((exprId) => {
          if (seenExprIds.has(exprId)) {
            return;
          }
          seenExprIds.add(exprId);
          const expr = moduleView.hir.expressions.get(exprId);
          if (
            !expr ||
            (expr.exprKind !== "call" && expr.exprKind !== "method-call")
          ) {
            return;
          }
          indexed.push({ moduleView, exprId, expr });
        });
    });
    callSites.set(instanceId, indexed);
  });
  return callSites;
};

type ExactParameterCandidate = TypeId | "conflict";

const callArgumentExprIds = (expr: HirExpression): readonly HirExprId[] =>
  expr.exprKind === "call"
    ? expr.args.map((arg) => arg.expr)
    : expr.exprKind === "method-call"
      ? [expr.target, ...expr.args.map((arg) => arg.expr)]
      : [];

const mergeExactParameterCandidate = ({
  candidates,
  instanceId,
  symbol,
  exactType,
}: {
  candidates: Map<
    ProgramFunctionInstanceId,
    Map<SymbolId, ExactParameterCandidate>
  >;
  instanceId: ProgramFunctionInstanceId;
  symbol: SymbolId;
  exactType: TypeId;
}): void => {
  const bySymbol =
    candidates.get(instanceId) ?? new Map<SymbolId, ExactParameterCandidate>();
  const existing = bySymbol.get(symbol);
  bySymbol.set(
    symbol,
    existing === undefined || existing === exactType ? exactType : "conflict",
  );
  candidates.set(instanceId, bySymbol);
};

const resolveDirectIdentifierCallTarget = ({
  moduleView,
  expr,
  typeArgs,
  ir,
}: {
  moduleView: OptimizedModuleView;
  expr: Extract<HirExpression, { exprKind: "call" | "method-call" }>;
  typeArgs: readonly TypeId[];
  ir: MutableOptimizationIr;
}): readonly {
  functionId: ProgramFunctionId;
  instanceId?: ProgramFunctionInstanceId;
}[] => {
  if (expr.exprKind !== "call") {
    return [];
  }
  const callee = moduleView.hir.expressions.get(expr.callee);
  if (callee?.exprKind !== "identifier") {
    return [];
  }
  const resolved = resolveImportedSymbol({
    moduleId: moduleView.moduleId,
    symbol: callee.symbol,
    ir,
  });
  const module = ir.modules.get(resolved.moduleId);
  if (
    !module ||
    !functionItemBySymbol({ ir, moduleView: module, symbol: resolved.symbol })
  ) {
    return [];
  }
  const functionId = canonicalProgramSymbolIdOf({
    moduleId: resolved.moduleId,
    symbol: resolved.symbol,
    ir,
  });
  return [
    {
      functionId,
      instanceId: ir.baseProgram.functions.getInstanceId(
        resolved.moduleId,
        resolved.symbol,
        typeArgs,
      ),
    },
  ];
};

const resolveTargetsForExactPropagation = ({
  moduleView,
  exprId,
  expr,
  callerInstanceId,
  ir,
}: {
  moduleView: OptimizedModuleView;
  exprId: HirExprId;
  expr: Extract<HirExpression, { exprKind: "call" | "method-call" }>;
  callerInstanceId: ProgramFunctionInstanceId;
  ir: MutableOptimizationIr;
}): readonly {
  functionId: ProgramFunctionId;
  instanceId?: ProgramFunctionInstanceId;
}[] => {
  const resolvedTargets = resolveTargetsForCaller({
    moduleId: moduleView.moduleId,
    exprId,
    callerInstanceId,
    ir,
  });
  if (resolvedTargets.length > 0 || expr.exprKind !== "call") {
    return resolvedTargets;
  }
  const callInfo = ir.calls.get(moduleView.moduleId)?.get(exprId);
  const typeArgs = callInfo
    ? resolveCallTypeArgs({ callInfo, callerInstanceId })
    : [];
  return resolveDirectIdentifierCallTarget({ moduleView, expr, typeArgs, ir });
};

const externallyCallableFunctionInstances = (
  ir: MutableOptimizationIr,
): Set<ProgramFunctionInstanceId> => {
  const external = new Set<ProgramFunctionInstanceId>();
  const addFunctionSymbolInstances = ({
    moduleId,
    symbol,
  }: {
    moduleId: string;
    symbol: SymbolId;
  }): void => {
    const instantiations = ir.functionInstantiations.get(moduleId)?.get(symbol);
    if (instantiations) {
      instantiations.forEach((_typeArgs, instanceId) => {
        external.add(instanceId);
      });
      return;
    }
    const instanceId = ir.baseProgram.functions.getInstanceId(
      moduleId,
      symbol,
      [],
    );
    if (typeof instanceId === "number") {
      external.add(instanceId);
    }
  };

  const externalModuleIds =
    ir.options.testMode && ir.options.testScope === "all"
      ? new Set(ir.modules.keys())
      : new Set([ir.entryModuleId]);
  externalModuleIds.forEach((moduleId) => {
    const moduleView = ir.modules.get(moduleId);
    if (!moduleView) {
      return;
    }
    moduleView.hir.module.exports.forEach((entry) => {
      const resolved = resolveImportedSymbol({
        moduleId,
        symbol: entry.symbol,
        ir,
      });
      const resolvedModule = ir.modules.get(resolved.moduleId);
      if (
        !resolvedModule ||
        !functionItemBySymbol({
          ir,
          moduleView: resolvedModule,
          symbol: resolved.symbol,
        })
      ) {
        return;
      }
      addFunctionSymbolInstances(resolved);
    });
  });

  const markEscapedFunctionValues = ({
    moduleView,
    rootExprId,
  }: {
    moduleView: OptimizedModuleView;
    rootExprId: HirExprId;
  }): void => {
    const directCallCallees = new Set<HirExprId>();
    const exprIds = ir.index.getBodyTopology({
      moduleId: moduleView.moduleId,
      rootExprId,
    }).postOrderExprIds;
    exprIds.forEach((exprId) => {
      const expr = moduleView.hir.expressions.get(exprId);
      if (expr?.exprKind === "call") {
        directCallCallees.add(expr.callee);
      }
    });

    exprIds.forEach((exprId) => {
      if (directCallCallees.has(exprId)) {
        return;
      }
      const expr = moduleView.hir.expressions.get(exprId);
      if (expr?.exprKind !== "identifier") {
        return;
      }
      const resolved = resolveImportedSymbol({
        moduleId: moduleView.moduleId,
        symbol: expr.symbol,
        ir,
      });
      const resolvedModule = ir.modules.get(resolved.moduleId);
      if (
        !resolvedModule ||
        !functionItemBySymbol({
          ir,
          moduleView: resolvedModule,
          symbol: resolved.symbol,
        })
      ) {
        return;
      }
      addFunctionSymbolInstances(resolved);
    });
  };

  ir.facts.reachableFunctionInstances.forEach((instanceId) => {
    const instance = ir.baseProgram.functions.getInstance(instanceId);
    const moduleView = ir.modules.get(instance.symbolRef.moduleId);
    const item = moduleView
      ? functionItemBySymbol({
          ir,
          moduleView,
          symbol: instance.symbolRef.symbol,
        })
      : undefined;
    if (!moduleView || !item) {
      return;
    }
    [
      item.body,
      ...item.parameters.flatMap((parameter) =>
        typeof parameter.defaultValue === "number"
          ? [parameter.defaultValue]
          : [],
      ),
    ].forEach((rootExprId) => {
      markEscapedFunctionValues({ moduleView, rootExprId });
    });
  });

  ir.facts.reachableModuleLets.forEach((symbols, moduleId) => {
    const moduleView = ir.modules.get(moduleId);
    if (!moduleView) {
      return;
    }
    symbols.forEach((symbol) => {
      const moduleLet = moduleLetBySymbol({ ir, moduleView, symbol });
      if (!moduleLet) {
        return;
      }
      markEscapedFunctionValues({
        moduleView,
        rootExprId: moduleLet.initializer,
      });
    });
  });
  return external;
};

const collectExactParameterCandidates = ({
  ir,
  callSites,
  seedFacts,
  externallyCallableInstances,
}: {
  ir: MutableOptimizationIr;
  callSites: InstanceCallSiteIndex;
  seedFacts: ReadonlyMap<
    ProgramFunctionInstanceId,
    ReadonlyMap<SymbolId, TypeId>
  >;
  externallyCallableInstances: ReadonlySet<ProgramFunctionInstanceId>;
}): Map<ProgramFunctionInstanceId, Map<SymbolId, ExactParameterCandidate>> => {
  const candidates = new Map<
    ProgramFunctionInstanceId,
    Map<SymbolId, ExactParameterCandidate>
  >();

  callSites.forEach((sites, callerInstanceId) => {
    sites.forEach(({ moduleView, exprId, expr }) => {
      const argExprIds = callArgumentExprIds(expr);
      const callInfo = ir.calls.get(moduleView.moduleId)?.get(exprId);
      const targets = resolveTargetsForExactPropagation({
        moduleView,
        exprId,
        expr,
        callerInstanceId,
        ir,
      });
      targets.forEach(({ instanceId }) => {
        if (typeof instanceId !== "number") {
          return;
        }
        if (externallyCallableInstances.has(instanceId)) {
          return;
        }
        const target = ir.baseProgram.functions.getInstance(instanceId);
        const signature = ir.baseProgram.functions.getSignature(
          target.symbolRef.moduleId,
          target.symbolRef.symbol,
        );
        if (!signature) {
          return;
        }
        signature.parameters.forEach((parameter, index) => {
          if (typeof parameter.symbol !== "number") {
            return;
          }
          const argExprId = callArgumentExprIdForParameter({
            argExprIds,
            callInfo,
            callerInstanceId,
            parameterIndex: index,
          });
          if (typeof argExprId !== "number") {
            return;
          }
          const exactType = exactNominalForExpr({
            moduleView,
            exprId: argExprId,
            callerInstanceId,
            program: ir.baseProgram,
            exactParameterTypes: seedFacts,
          });
          if (typeof exactType !== "number") {
            return;
          }
          mergeExactParameterCandidate({
            candidates,
            instanceId,
            symbol: parameter.symbol,
            exactType,
          });
        });
      });
    });
  });

  return candidates;
};

const materializeExactParameterFacts = (
  candidates: ReadonlyMap<
    ProgramFunctionInstanceId,
    ReadonlyMap<SymbolId, ExactParameterCandidate>
  >,
): Map<ProgramFunctionInstanceId, Map<SymbolId, TypeId>> => {
  const facts = new Map<ProgramFunctionInstanceId, Map<SymbolId, TypeId>>();
  candidates.forEach((bySymbol, instanceId) => {
    const exactBySymbol = new Map<SymbolId, TypeId>();
    bySymbol.forEach((candidate, symbol) => {
      if (candidate !== "conflict") {
        exactBySymbol.set(symbol, candidate);
      }
    });
    if (exactBySymbol.size > 0) {
      facts.set(instanceId, exactBySymbol);
    }
  });
  return facts;
};

const cloneExactParameterFacts = (
  facts: ReadonlyMap<ProgramFunctionInstanceId, ReadonlyMap<SymbolId, TypeId>>,
): Map<ProgramFunctionInstanceId, Map<SymbolId, TypeId>> =>
  new Map(
    Array.from(facts.entries()).map(([instanceId, bySymbol]) => [
      instanceId,
      new Map(bySymbol),
    ]),
  );

type KnownParameterCandidate = {
  types: Set<TypeId>;
  unknown: boolean;
};

const cloneKnownParameterFacts = (
  facts: ReadonlyMap<
    ProgramFunctionInstanceId,
    ReadonlyMap<SymbolId, ReadonlySet<TypeId>>
  >,
): Map<ProgramFunctionInstanceId, Map<SymbolId, Set<TypeId>>> =>
  new Map(
    Array.from(facts.entries()).map(([instanceId, bySymbol]) => [
      instanceId,
      new Map(
        Array.from(bySymbol.entries()).map(([symbol, types]) => [
          symbol,
          new Set(types),
        ]),
      ),
    ]),
  );

const receiverSpecializationCallSiteKey = ({
  moduleId,
  exprId,
}: {
  moduleId: string;
  exprId: HirExprId;
}): string => `${moduleId}:${exprId}`;

const receiverSpecializationContextKey = ({
  instanceId,
  exactParameterTypes,
}: {
  instanceId: ProgramFunctionInstanceId;
  exactParameterTypes: ReadonlyMap<SymbolId, TypeId> | undefined;
}): string => {
  const serializedFacts = Array.from(exactParameterTypes?.entries() ?? [])
    .sort(([left], [right]) => left - right)
    .map(([symbol, type]) => `${symbol}=${type}`)
    .join(",");
  return `${instanceId}:${serializedFacts}`;
};

const serializeReceiverSpecializationRequests = (
  requests: ReadonlyMap<
    string,
    ReadonlyMap<string, ReadonlyMap<SymbolId, TypeId>>
  >,
): string =>
  JSON.stringify(
    Array.from(requests.entries())
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([callSiteKey, byContext]) => [
        callSiteKey,
        Array.from(byContext.entries())
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([contextKey, exactTypes]) => [
            contextKey,
            Array.from(exactTypes.entries()).sort(
              ([left], [right]) => left - right,
            ),
          ]),
      ]),
  );

const knownNominalsForExpr = ({
  moduleView,
  exprId,
  callerInstanceId,
  program,
  exactParameterTypes,
  knownParameterTypes,
}: {
  moduleView: ModuleCodegenView;
  exprId: HirExprId;
  callerInstanceId?: ProgramFunctionInstanceId;
  program: ProgramCodegenView;
  exactParameterTypes: ReadonlyMap<
    ProgramFunctionInstanceId,
    ReadonlyMap<SymbolId, TypeId>
  >;
  knownParameterTypes: ReadonlyMap<
    ProgramFunctionInstanceId,
    ReadonlyMap<SymbolId, ReadonlySet<TypeId>>
  >;
}): ReadonlySet<TypeId> | undefined => {
  const exact = exactNominalForExpr({
    moduleView,
    exprId,
    callerInstanceId,
    program,
    exactParameterTypes,
  });
  if (typeof exact === "number") {
    return new Set([exact]);
  }
  if (typeof callerInstanceId !== "number") {
    return undefined;
  }
  const expr = moduleView.hir.expressions.get(exprId);
  if (expr?.exprKind !== "identifier") {
    return undefined;
  }
  return knownParameterTypes.get(callerInstanceId)?.get(expr.symbol);
};

const mergeKnownParameterCandidate = ({
  candidates,
  instanceId,
  symbol,
  knownTypes,
}: {
  candidates: Map<
    ProgramFunctionInstanceId,
    Map<SymbolId, KnownParameterCandidate>
  >;
  instanceId: ProgramFunctionInstanceId;
  symbol: SymbolId;
  knownTypes?: ReadonlySet<TypeId>;
}): void => {
  const bySymbol =
    candidates.get(instanceId) ?? new Map<SymbolId, KnownParameterCandidate>();
  const existing = bySymbol.get(symbol) ?? {
    types: new Set<TypeId>(),
    unknown: false,
  };
  if (!knownTypes || knownTypes.size === 0) {
    existing.unknown = true;
  } else {
    knownTypes.forEach((type) => existing.types.add(type));
  }
  bySymbol.set(symbol, existing);
  candidates.set(instanceId, bySymbol);
};

const collectKnownParameterCandidates = ({
  ir,
  callSites,
  exactParameterTypes,
  seedFacts,
  externallyCallableInstances,
}: {
  ir: MutableOptimizationIr;
  callSites: InstanceCallSiteIndex;
  exactParameterTypes: ReadonlyMap<
    ProgramFunctionInstanceId,
    ReadonlyMap<SymbolId, TypeId>
  >;
  seedFacts: ReadonlyMap<
    ProgramFunctionInstanceId,
    ReadonlyMap<SymbolId, ReadonlySet<TypeId>>
  >;
  externallyCallableInstances: ReadonlySet<ProgramFunctionInstanceId>;
}): Map<ProgramFunctionInstanceId, Map<SymbolId, KnownParameterCandidate>> => {
  const candidates = new Map<
    ProgramFunctionInstanceId,
    Map<SymbolId, KnownParameterCandidate>
  >();

  callSites.forEach((sites, callerInstanceId) => {
    sites.forEach(({ moduleView, exprId, expr }) => {
      const argExprIds = callArgumentExprIds(expr);
      const callInfo = ir.calls.get(moduleView.moduleId)?.get(exprId);
      const targets = resolveTargetsForExactPropagation({
        moduleView,
        exprId,
        expr,
        callerInstanceId,
        ir,
      });
      targets.forEach(({ instanceId }) => {
        if (typeof instanceId !== "number") {
          return;
        }
        if (externallyCallableInstances.has(instanceId)) {
          return;
        }
        const target = ir.baseProgram.functions.getInstance(instanceId);
        const signature = ir.baseProgram.functions.getSignature(
          target.symbolRef.moduleId,
          target.symbolRef.symbol,
        );
        if (!signature) {
          return;
        }
        signature.parameters.forEach((parameter, index) => {
          if (typeof parameter.symbol !== "number") {
            return;
          }
          const argExprId = callArgumentExprIdForParameter({
            argExprIds,
            callInfo,
            callerInstanceId,
            parameterIndex: index,
          });
          const knownTypes =
            typeof argExprId === "number"
              ? knownNominalsForExpr({
                  moduleView,
                  exprId: argExprId,
                  callerInstanceId,
                  program: ir.baseProgram,
                  exactParameterTypes,
                  knownParameterTypes: seedFacts,
                })
              : undefined;
          mergeKnownParameterCandidate({
            candidates,
            instanceId,
            symbol: parameter.symbol,
            knownTypes,
          });
        });
      });
    });
  });

  return candidates;
};

const materializeKnownParameterFacts = (
  candidates: ReadonlyMap<
    ProgramFunctionInstanceId,
    ReadonlyMap<SymbolId, KnownParameterCandidate>
  >,
): Map<ProgramFunctionInstanceId, Map<SymbolId, Set<TypeId>>> => {
  const facts = new Map<
    ProgramFunctionInstanceId,
    Map<SymbolId, Set<TypeId>>
  >();
  candidates.forEach((bySymbol, instanceId) => {
    const knownBySymbol = new Map<SymbolId, Set<TypeId>>();
    bySymbol.forEach((candidate, symbol) => {
      if (!candidate.unknown && candidate.types.size > 0) {
        knownBySymbol.set(symbol, new Set(candidate.types));
      }
    });
    if (knownBySymbol.size > 0) {
      facts.set(instanceId, knownBySymbol);
    }
  });
  return facts;
};

const setContainsAll = (
  expected: ReadonlySet<TypeId>,
  actual: ReadonlySet<TypeId>,
): boolean => Array.from(actual).every((type) => expected.has(type));

const validateKnownParameterFacts = ({
  ir,
  callSites,
  exactParameterTypes,
  facts,
}: {
  ir: MutableOptimizationIr;
  callSites: InstanceCallSiteIndex;
  exactParameterTypes: ReadonlyMap<
    ProgramFunctionInstanceId,
    ReadonlyMap<SymbolId, TypeId>
  >;
  facts: Map<ProgramFunctionInstanceId, Map<SymbolId, Set<TypeId>>>;
}): Map<ProgramFunctionInstanceId, Map<SymbolId, Set<TypeId>>> => {
  const validated = cloneKnownParameterFacts(facts);
  let changed = true;

  while (changed) {
    changed = false;
    callSites.forEach((sites, callerInstanceId) => {
      sites.forEach(({ moduleView, exprId, expr }) => {
        const argExprIds = callArgumentExprIds(expr);
        const callInfo = ir.calls.get(moduleView.moduleId)?.get(exprId);
        resolveTargetsForExactPropagation({
          moduleView,
          exprId,
          expr,
          callerInstanceId,
          ir,
        }).forEach(({ instanceId }) => {
          if (typeof instanceId !== "number") {
            return;
          }
          const factsBySymbol = validated.get(instanceId);
          if (!factsBySymbol || factsBySymbol.size === 0) {
            return;
          }
          const target = ir.baseProgram.functions.getInstance(instanceId);
          const signature = ir.baseProgram.functions.getSignature(
            target.symbolRef.moduleId,
            target.symbolRef.symbol,
          );
          signature?.parameters.forEach((parameter, index) => {
            if (typeof parameter.symbol !== "number") {
              return;
            }
            const expected = factsBySymbol.get(parameter.symbol);
            if (!expected) {
              return;
            }
            const argExprId = callArgumentExprIdForParameter({
              argExprIds,
              callInfo,
              callerInstanceId,
              parameterIndex: index,
            });
            const actual =
              typeof argExprId === "number"
                ? knownNominalsForExpr({
                    moduleView,
                    exprId: argExprId,
                    callerInstanceId,
                    program: ir.baseProgram,
                    exactParameterTypes,
                    knownParameterTypes: validated,
                  })
                : undefined;
            if (actual && setContainsAll(expected, actual)) {
              return;
            }
            factsBySymbol.delete(parameter.symbol);
            changed = true;
          });
          if (factsBySymbol.size === 0) {
            validated.delete(instanceId);
          }
        });
      });
    });
  }

  return validated;
};

const serializeKnownParameterFacts = (
  facts: ReadonlyMap<
    ProgramFunctionInstanceId,
    ReadonlyMap<SymbolId, ReadonlySet<TypeId>>
  >,
): string =>
  JSON.stringify(
    Array.from(facts.entries())
      .sort(([left], [right]) => left - right)
      .map(([instanceId, bySymbol]) => [
        instanceId,
        Array.from(bySymbol.entries())
          .sort(([left], [right]) => left - right)
          .map(([symbol, types]) => [
            symbol,
            Array.from(types).sort((left, right) => left - right),
          ]),
      ]),
  );

const validateExactParameterFacts = ({
  ir,
  callSites,
  facts,
}: {
  ir: MutableOptimizationIr;
  callSites: InstanceCallSiteIndex;
  facts: Map<ProgramFunctionInstanceId, Map<SymbolId, TypeId>>;
}): Map<ProgramFunctionInstanceId, Map<SymbolId, TypeId>> => {
  const validated = cloneExactParameterFacts(facts);
  let changed = true;

  while (changed) {
    changed = false;
    callSites.forEach((sites, callerInstanceId) => {
      sites.forEach(({ moduleView, exprId, expr }) => {
        const argExprIds = callArgumentExprIds(expr);
        const callInfo = ir.calls.get(moduleView.moduleId)?.get(exprId);
        resolveTargetsForExactPropagation({
          moduleView,
          exprId,
          expr,
          callerInstanceId,
          ir,
        }).forEach(({ instanceId }) => {
          if (typeof instanceId !== "number") {
            return;
          }
          const factsBySymbol = validated.get(instanceId);
          if (!factsBySymbol || factsBySymbol.size === 0) {
            return;
          }
          const target = ir.baseProgram.functions.getInstance(instanceId);
          const signature = ir.baseProgram.functions.getSignature(
            target.symbolRef.moduleId,
            target.symbolRef.symbol,
          );
          signature?.parameters.forEach((parameter, index) => {
            if (typeof parameter.symbol !== "number") {
              return;
            }
            const expected = factsBySymbol.get(parameter.symbol);
            if (typeof expected !== "number") {
              return;
            }
            const argExprId = callArgumentExprIdForParameter({
              argExprIds,
              callInfo,
              callerInstanceId,
              parameterIndex: index,
            });
            const actual =
              typeof argExprId === "number"
                ? exactNominalForExpr({
                    moduleView,
                    exprId: argExprId,
                    callerInstanceId,
                    program: ir.baseProgram,
                    exactParameterTypes: validated,
                  })
                : undefined;
            if (actual === expected) {
              return;
            }
            factsBySymbol.delete(parameter.symbol);
            changed = true;
          });
          if (factsBySymbol.size === 0) {
            validated.delete(instanceId);
          }
        });
      });
    });
  }

  return validated;
};

const serializeExactParameterFacts = (
  facts: ReadonlyMap<ProgramFunctionInstanceId, ReadonlyMap<SymbolId, TypeId>>,
): string =>
  JSON.stringify(
    Array.from(facts.entries())
      .sort(([left], [right]) => left - right)
      .map(([instanceId, bySymbol]) => [
        instanceId,
        Array.from(bySymbol.entries()).sort(([left], [right]) => left - right),
      ]),
  );

type ReceiverSpecializationContext = {
  instanceId: ProgramFunctionInstanceId;
  exactParameterTypes: Map<SymbolId, TypeId>;
};

const exactParameterFactsForContext = ({
  facts,
  context,
}: {
  facts: ReadonlyMap<ProgramFunctionInstanceId, ReadonlyMap<SymbolId, TypeId>>;
  context: ReceiverSpecializationContext;
}): Map<ProgramFunctionInstanceId, Map<SymbolId, TypeId>> => {
  const merged = cloneExactParameterFacts(facts);
  if (context.exactParameterTypes.size === 0) {
    return merged;
  }
  const existing = new Map(merged.get(context.instanceId) ?? []);
  context.exactParameterTypes.forEach((type, symbol) => {
    existing.set(symbol, type);
  });
  merged.set(context.instanceId, existing);
  return merged;
};

const functionParameterNodeKey = ({
  functionInstanceId,
  parameterSymbol,
}: {
  functionInstanceId: ProgramFunctionInstanceId;
  parameterSymbol: SymbolId;
}): string => `${functionInstanceId}:${parameterSymbol}`;

const computeTraitDispatchReachableParameters = ({
  ir,
  callSites,
}: {
  ir: MutableOptimizationIr;
  callSites: InstanceCallSiteIndex;
}): Set<string> => {
  const reachable = new Set<string>();
  const predecessors = new Map<string, Set<string>>();

  callSites.forEach((sites, functionInstanceId) => {
    sites.forEach(({ moduleView, exprId, expr }) => {
      const callInfo = ir.calls.get(moduleView.moduleId)?.get(exprId);
      if (callInfo?.traitDispatch) {
        const receiverExprId =
          expr.exprKind === "method-call" ? expr.target : expr.args[0]?.expr;
        const receiverExpr =
          typeof receiverExprId === "number"
            ? moduleView.hir.expressions.get(receiverExprId)
            : undefined;
        if (
          receiverExpr?.exprKind === "identifier" &&
          typeof receiverExpr.symbol === "number"
        ) {
          reachable.add(
            functionParameterNodeKey({
              functionInstanceId,
              parameterSymbol: receiverExpr.symbol,
            }),
          );
        }
      }

      const argExprIds = callArgumentExprIds(expr);
      resolveTargetsForExactPropagation({
        moduleView,
        exprId,
        expr,
        callerInstanceId: functionInstanceId,
        ir,
      }).forEach(({ instanceId }) => {
        if (typeof instanceId !== "number") {
          return;
        }
        const target = ir.baseProgram.functions.getInstance(instanceId);
        const signature = ir.baseProgram.functions.getSignature(
          target.symbolRef.moduleId,
          target.symbolRef.symbol,
        );
        signature?.parameters.forEach((targetParam, paramIndex) => {
          if (typeof targetParam.symbol !== "number") {
            return;
          }
          if (
            ir.baseProgram.types.getTypeDesc(targetParam.typeId).kind !==
            "trait"
          ) {
            return;
          }
          const argExprId = callArgumentExprIdForParameter({
            argExprIds,
            callInfo,
            callerInstanceId: functionInstanceId,
            parameterIndex: paramIndex,
          });
          const argExpr =
            typeof argExprId === "number"
              ? moduleView.hir.expressions.get(argExprId)
              : undefined;
          if (argExpr?.exprKind !== "identifier") {
            return;
          }
          const sourceKey = functionParameterNodeKey({
            functionInstanceId,
            parameterSymbol: argExpr.symbol,
          });
          const targetKey = functionParameterNodeKey({
            functionInstanceId: instanceId,
            parameterSymbol: targetParam.symbol,
          });
          const targetPredecessors = predecessors.get(targetKey) ?? new Set();
          targetPredecessors.add(sourceKey);
          predecessors.set(targetKey, targetPredecessors);
        });
      });
    });
  });

  const pending = [...reachable];
  while (pending.length > 0) {
    const targetKey = pending.pop()!;
    predecessors.get(targetKey)?.forEach((sourceKey) => {
      if (reachable.has(sourceKey)) {
        return;
      }
      reachable.add(sourceKey);
      pending.push(sourceKey);
    });
  }

  return reachable;
};

const collectReceiverSpecializationRequests = ({
  ir,
  callSites,
  exactParameterTypes,
}: {
  ir: MutableOptimizationIr;
  callSites: InstanceCallSiteIndex;
  exactParameterTypes: ReadonlyMap<
    ProgramFunctionInstanceId,
    ReadonlyMap<SymbolId, TypeId>
  >;
}): Map<string, Map<string, Map<SymbolId, TypeId>>> => {
  const requests = new Map<string, Map<string, Map<SymbolId, TypeId>>>();
  const queued: ReceiverSpecializationContext[] = [];
  const queuedKeys = new Set<string>();
  const seen = new Set<string>();
  const specializationKeysByFunction = new Map<
    ProgramFunctionInstanceId,
    Set<string>
  >();
  const traitDispatchReachableParameters =
    computeTraitDispatchReachableParameters({ ir, callSites });

  const enqueueContext = ({
    instanceId,
    exactTypes,
    countsAsSpecialization,
  }: {
    instanceId: ProgramFunctionInstanceId;
    exactTypes?: ReadonlyMap<SymbolId, TypeId>;
    countsAsSpecialization: boolean;
  }): void => {
    const exactParameterMap = new Map(exactTypes ?? []);
    const contextKey = receiverSpecializationContextKey({
      instanceId,
      exactParameterTypes: exactParameterMap,
    });
    if (seen.has(contextKey) || queuedKeys.has(contextKey)) {
      return;
    }
    if (countsAsSpecialization) {
      if (
        exactParameterMap.size === 0 ||
        exactParameterMap.size >
          ir.facts.codegenPlan.specializationPolicy
            .receiverExactParametersPerContext
      ) {
        return;
      }
      const knownKeys =
        specializationKeysByFunction.get(instanceId) ?? new Set<string>();
      if (
        !knownKeys.has(contextKey) &&
        knownKeys.size >=
          ir.facts.codegenPlan.specializationPolicy.receiverContextsPerFunction
      ) {
        return;
      }
      knownKeys.add(contextKey);
      specializationKeysByFunction.set(instanceId, knownKeys);
    }
    queuedKeys.add(contextKey);
    queued.push({
      instanceId,
      exactParameterTypes: exactParameterMap,
    });
  };

  ir.facts.reachableFunctionInstances.forEach((instanceId) => {
    enqueueContext({
      instanceId,
      exactTypes: exactParameterTypes.get(instanceId),
      countsAsSpecialization: false,
    });
  });

  while (queued.length > 0) {
    const context = queued.pop()!;
    const callerContextKey = receiverSpecializationContextKey({
      instanceId: context.instanceId,
      exactParameterTypes: context.exactParameterTypes,
    });
    queuedKeys.delete(callerContextKey);
    if (seen.has(callerContextKey)) {
      continue;
    }
    seen.add(callerContextKey);

    const contextExactFacts = exactParameterFactsForContext({
      facts: exactParameterTypes,
      context,
    });
    const sites = callSites.get(context.instanceId) ?? [];
    sites.forEach(({ moduleView, exprId, expr }) => {
      const targets = resolveTargetsForExactPropagation({
        moduleView,
        exprId,
        expr,
        callerInstanceId: context.instanceId,
        ir,
      });
      if (targets.length !== 1 || typeof targets[0]?.instanceId !== "number") {
        return;
      }

      const targetInstanceId = targets[0].instanceId;
      const target = ir.baseProgram.functions.getInstance(targetInstanceId);
      const signature = ir.baseProgram.functions.getSignature(
        target.symbolRef.moduleId,
        target.symbolRef.symbol,
      );
      if (!signature) {
        return;
      }
      const callInfo = ir.calls.get(moduleView.moduleId)?.get(exprId);
      const argExprIds = callArgumentExprIds(expr);
      const requestedExactTypes = new Map<SymbolId, TypeId>();
      signature.parameters.forEach((parameter, paramIndex) => {
        if (typeof parameter.symbol !== "number") {
          return;
        }
        if (
          ir.baseProgram.types.getTypeDesc(parameter.typeId).kind !== "trait"
        ) {
          return;
        }
        const argExprId = callArgumentExprIdForParameter({
          argExprIds,
          callInfo,
          callerInstanceId: context.instanceId,
          parameterIndex: paramIndex,
        });
        if (typeof argExprId !== "number") {
          return;
        }
        const exactType = exactNominalForExpr({
          moduleView,
          exprId: argExprId,
          callerInstanceId: context.instanceId,
          program: ir.baseProgram,
          exactParameterTypes: contextExactFacts,
        });
        if (typeof exactType !== "number") {
          return;
        }
        const existingExact = exactParameterTypes
          .get(targetInstanceId)
          ?.get(parameter.symbol);
        if (existingExact === exactType) {
          return;
        }
        if (
          !traitDispatchReachableParameters.has(
            functionParameterNodeKey({
              functionInstanceId: targetInstanceId,
              parameterSymbol: parameter.symbol,
            }),
          )
        ) {
          return;
        }
        requestedExactTypes.set(parameter.symbol, exactType);
      });

      if (
        requestedExactTypes.size === 0 ||
        requestedExactTypes.size >
          ir.facts.codegenPlan.specializationPolicy
            .receiverExactParametersPerContext
      ) {
        return;
      }

      const callSiteKey = receiverSpecializationCallSiteKey({
        moduleId: moduleView.moduleId,
        exprId,
      });
      const byContext =
        requests.get(callSiteKey) ?? new Map<string, Map<SymbolId, TypeId>>();
      byContext.set(callerContextKey, requestedExactTypes);
      requests.set(callSiteKey, byContext);

      const targetContextExactTypes = new Map(
        exactParameterTypes.get(targetInstanceId) ?? [],
      );
      requestedExactTypes.forEach((type, symbol) => {
        targetContextExactTypes.set(symbol, type);
      });
      enqueueContext({
        instanceId: targetInstanceId,
        exactTypes: targetContextExactTypes,
        countsAsSpecialization: true,
      });
    });
  }

  return requests;
};

const exactReceiverPropagationPass: ProgramOptimizationPass = {
  name: "exact-receiver-propagation",
  run(ctx) {
    const callSites = buildInstanceCallSiteIndex({
      ir: ctx.ir as MutableOptimizationIr,
    });
    const externallyCallableInstances = externallyCallableFunctionInstances(
      ctx.ir as MutableOptimizationIr,
    );
    let exactFacts = new Map<
      ProgramFunctionInstanceId,
      Map<SymbolId, TypeId>
    >();
    let changed = true;

    while (changed) {
      const candidates = collectExactParameterCandidates({
        ir: ctx.ir as MutableOptimizationIr,
        callSites,
        seedFacts: exactFacts,
        externallyCallableInstances,
      });
      const nextFacts = materializeExactParameterFacts(candidates);
      changed =
        serializeExactParameterFacts(nextFacts) !==
        serializeExactParameterFacts(exactFacts);
      exactFacts = nextFacts;
    }

    const validatedExact = validateExactParameterFacts({
      ir: ctx.ir as MutableOptimizationIr,
      callSites,
      facts: exactFacts,
    });

    let knownFacts = new Map<
      ProgramFunctionInstanceId,
      Map<SymbolId, Set<TypeId>>
    >();
    changed = true;
    while (changed) {
      const candidates = collectKnownParameterCandidates({
        ir: ctx.ir as MutableOptimizationIr,
        callSites,
        exactParameterTypes: validatedExact,
        seedFacts: knownFacts,
        externallyCallableInstances,
      });
      const nextFacts = materializeKnownParameterFacts(candidates);
      changed =
        serializeKnownParameterFacts(nextFacts) !==
        serializeKnownParameterFacts(knownFacts);
      knownFacts = nextFacts;
    }

    const validatedKnown = validateKnownParameterFacts({
      ir: ctx.ir as MutableOptimizationIr,
      callSites,
      exactParameterTypes: validatedExact,
      facts: knownFacts,
    });
    const receiverSpecializationRequests =
      collectReceiverSpecializationRequests({
        ir: ctx.ir as MutableOptimizationIr,
        callSites,
        exactParameterTypes: validatedExact,
      });
    const previousExact = ctx.ir.facts.exactParameterTypes;
    const previousKnown = ctx.ir.facts.knownParameterTypes;
    const previousReceiverSpecializationRequests =
      ctx.ir.facts.receiverSpecializationRequests;
    const unchanged =
      serializeExactParameterFacts(previousExact) ===
        serializeExactParameterFacts(validatedExact) &&
      serializeKnownParameterFacts(previousKnown) ===
        serializeKnownParameterFacts(validatedKnown) &&
      serializeReceiverSpecializationRequests(
        previousReceiverSpecializationRequests,
      ) ===
        serializeReceiverSpecializationRequests(receiverSpecializationRequests);
    (ctx.ir as MutableOptimizationIr).facts.exactParameterTypes =
      validatedExact;
    (ctx.ir as MutableOptimizationIr).facts.knownParameterTypes =
      validatedKnown;
    (ctx.ir as MutableOptimizationIr).facts.receiverSpecializationRequests =
      receiverSpecializationRequests;
    const exactParameterFacts = Array.from(validatedExact.values()).reduce(
      (count, bySymbol) => count + bySymbol.size,
      0,
    );
    const knownParameterFacts = Array.from(validatedKnown.values()).reduce(
      (count, bySymbol) => count + bySymbol.size,
      0,
    );
    const specializationRequests = Array.from(
      receiverSpecializationRequests.values(),
    ).reduce((count, byContext) => count + byContext.size, 0);
    return {
      changed: !unchanged,
      metrics: {
        exact_parameter_facts: exactParameterFacts,
        known_parameter_facts: knownParameterFacts,
        receiver_specialization_requests: specializationRequests,
      },
    };
  },
};

const redundantRuntimeTypeCheckEliminationPass: ProgramOptimizationPass = {
  name: "redundant-runtime-type-check-elimination",
  run(ctx) {
    const ir = ctx.ir as MutableOptimizationIr;
    let changed = false;
    let elidedChecks = 0;

    ir.modules.forEach((moduleView, moduleId) => {
      const candidates =
        ir.facts.runtimeTypeCheckElisionFieldAccesses.get(moduleId) ??
        new Set<HirExprId>();

      moduleView.hir.expressions.forEach((expr, exprId) => {
        if (expr.exprKind !== "field-access") {
          return;
        }

        const targetTypeId = exprTypeFor({ moduleView, exprId: expr.target });
        if (
          typeof exactNominalForType({
            typeId: targetTypeId,
            program: ir.baseProgram,
          }) !== "number"
        ) {
          return;
        }

        if (!candidates.has(exprId)) {
          candidates.add(exprId);
          changed = true;
          elidedChecks += 1;
        }
      });

      if (candidates.size > 0) {
        ir.facts.runtimeTypeCheckElisionFieldAccesses.set(moduleId, candidates);
      }
    });

    return { changed, metrics: { elided_checks: elidedChecks } };
  },
};

const semanticCopyForwardingPass: ProgramOptimizationPass = {
  name: "semantic-copy-forwarding",
  run(ctx) {
    const ir = ctx.ir as MutableOptimizationIr;
    let changed = false;
    let forwardedFields = 0;

    ir.modules.forEach((moduleView, moduleId) => {
      const candidates =
        ir.facts.semanticCopyForwardingFieldAccesses.get(moduleId) ??
        new Set<HirExprId>();

      moduleView.hir.expressions.forEach((expr, exprId) => {
        if (expr.exprKind !== "field-access") {
          return;
        }

        const target = moduleView.hir.expressions.get(expr.target);
        if (
          target?.exprKind !== "object-literal" ||
          target.entries.some((entry) => entry.kind !== "field") ||
          !target.entries.some(
            (entry) => entry.kind === "field" && entry.name === expr.field,
          )
        ) {
          return;
        }

        if (!candidates.has(exprId)) {
          candidates.add(exprId);
          changed = true;
          forwardedFields += 1;
        }
      });

      if (candidates.size > 0) {
        ir.facts.semanticCopyForwardingFieldAccesses.set(moduleId, candidates);
      }
    });

    return { changed, metrics: { forwarded_fields: forwardedFields } };
  },
};

const resolveImportedSymbol = ({
  moduleId,
  symbol,
  ir,
}: {
  moduleId: string;
  symbol: SymbolId;
  ir: MutableOptimizationIr;
}): { moduleId: string; symbol: SymbolId } => {
  return ir.index.resolveImportedSymbol(moduleId, symbol);
};

const moduleLetBySymbol = ({
  ir,
  moduleView,
  symbol,
}: {
  ir: MutableOptimizationIr;
  moduleView: OptimizedModuleView;
  symbol: SymbolId;
}): HirModuleLet | undefined =>
  ir.index.getModuleLet(moduleView.moduleId, symbol)?.item;

const canonicalProgramSymbolIdOf = ({
  moduleId,
  symbol,
  ir,
}: {
  moduleId: string;
  symbol: SymbolId;
  ir: MutableOptimizationIr;
}): ProgramSymbolId =>
  ir.baseProgram.symbols.canonicalIdOf(moduleId, symbol) as ProgramSymbolId;

const resolveIntrinsicFunction = ({
  ir,
  intrinsicName,
}: {
  ir: MutableOptimizationIr;
  intrinsicName: string;
}): { moduleId: string; symbol: SymbolId } | undefined => {
  const matched = ir.index.resolveIntrinsicFunction(intrinsicName);
  return matched
    ? { moduleId: matched.moduleId, symbol: matched.symbol }
    : undefined;
};

const serializerForType = ({
  ir,
  typeId,
}: {
  ir: MutableOptimizationIr;
  typeId: TypeId;
}): ReturnType<ProgramCodegenView["symbols"]["getSerializer"]> => {
  const serializers = [
    ...ir.baseProgram.types
      .getAliasSymbols(typeId)
      .map((symbol) => ir.baseProgram.symbols.getSerializer(symbol)),
    (() => {
      const owner = ir.baseProgram.types.getNominalOwner(typeId);
      return typeof owner === "number"
        ? ir.baseProgram.symbols.getSerializer(owner)
        : undefined;
    })(),
  ].filter((serializer): serializer is NonNullable<typeof serializer> =>
    Boolean(serializer),
  );
  if (serializers.length === 0) {
    return undefined;
  }
  const reference = serializers[0]!;
  const mismatch = serializers.find(
    (serializer) =>
      serializer.formatId !== reference.formatId ||
      serializer.encode.moduleId !== reference.encode.moduleId ||
      serializer.encode.symbol !== reference.encode.symbol ||
      serializer.decode.moduleId !== reference.decode.moduleId ||
      serializer.decode.symbol !== reference.decode.symbol,
  );
  if (mismatch) {
    throw new Error(`conflicting serializers for type ${typeId}`);
  }
  return reference;
};

const serializerForTypes = ({
  ir,
  typeIds,
}: {
  ir: MutableOptimizationIr;
  typeIds: readonly TypeId[];
}): ReturnType<ProgramCodegenView["symbols"]["getSerializer"]> => {
  const serializers = typeIds
    .map((typeId) => serializerForType({ ir, typeId }))
    .filter((serializer): serializer is NonNullable<typeof serializer> =>
      Boolean(serializer),
    );
  if (serializers.length === 0) {
    return undefined;
  }
  const reference = serializers[0]!;
  const mismatch = serializers.find(
    (serializer) =>
      serializer.formatId !== reference.formatId ||
      serializer.encode.moduleId !== reference.encode.moduleId ||
      serializer.encode.symbol !== reference.encode.symbol ||
      serializer.decode.moduleId !== reference.decode.moduleId ||
      serializer.decode.symbol !== reference.decode.symbol,
  );
  if (mismatch) {
    throw new Error(`conflicting serializers for exported type list`);
  }
  return reference;
};

const shouldConsiderBoundaryExportForOptimization = ({
  exportName,
  boundaryExports,
}: {
  exportName: string;
  boundaryExports: CodegenOptions["boundaryExports"] | undefined;
}): boolean => {
  if (!boundaryExports || boundaryExports === "off") {
    return false;
  }
  if (boundaryExports === "auto") {
    return true;
  }
  if (boundaryExports.mode === "off") {
    return false;
  }
  if (
    boundaryExports.include &&
    !boundaryExports.include.includes(exportName)
  ) {
    return false;
  }
  if (boundaryExports.mode === "only") {
    return boundaryExports.include?.includes(exportName) ?? false;
  }
  return true;
};

const setEquals = <T>(left: ReadonlySet<T>, right: ReadonlySet<T>): boolean =>
  left.size === right.size &&
  Array.from(left).every((value) => right.has(value));

const mapOfSetEquals = <K, V>(
  left: ReadonlyMap<K, ReadonlySet<V>>,
  right: ReadonlyMap<K, ReadonlySet<V>>,
): boolean =>
  left.size === right.size &&
  Array.from(left.entries()).every(([key, values]) => {
    const other = right.get(key);
    return other ? setEquals(values, other) : false;
  });

const traitDispatchSignatureKey = ({
  traitSymbol,
  traitMethodSymbol,
}: {
  traitSymbol: ProgramSymbolId;
  traitMethodSymbol: ProgramSymbolId;
}): string => `${traitSymbol}:${traitMethodSymbol}`;

const isPrimitiveDirectSwitchType = ({
  typeId,
  ir,
}: {
  typeId: TypeId;
  ir: MutableOptimizationIr;
}): boolean =>
  typeId !== ir.baseProgram.primitives.void &&
  ir.baseProgram.types.getTypeDesc(typeId).kind === "primitive";

const isPureSignature = ({
  effectRow,
  ir,
}: {
  effectRow: number;
  ir: MutableOptimizationIr;
}): boolean => ir.baseProgram.effects.getRow(effectRow).operations.length === 0;

const traitMethodMatches = ({
  traitMethod,
  implMethod,
  traitMethodImpl,
  ir,
}: {
  traitMethod: ProgramSymbolId;
  implMethod: ProgramSymbolId;
  traitMethodImpl: {
    traitSymbol: ProgramSymbolId;
    traitMethodSymbol: ProgramSymbolId;
  };
  ir: MutableOptimizationIr;
}): boolean => {
  const mapping = ir.baseProgram.traits.getTraitMethodImpl(implMethod);
  const mappedTraitSymbol = mapping?.traitSymbol ?? traitMethodImpl.traitSymbol;
  const mappedTraitMethod = mapping?.traitMethodSymbol ?? traitMethod;
  return (
    mappedTraitSymbol === traitMethodImpl.traitSymbol &&
    mappedTraitMethod === traitMethodImpl.traitMethodSymbol
  );
};

const directSwitchOmittedMethodTableImpls = ({
  moduleView,
  expr,
  callerInstanceId,
  functionId,
  traitMethodImpl,
  ir,
}: {
  moduleView: OptimizedModuleView;
  expr: Extract<HirExpression, { exprKind: "call" | "method-call" }>;
  callerInstanceId: ProgramFunctionInstanceId;
  functionId: ProgramFunctionId;
  traitMethodImpl: {
    traitSymbol: ProgramSymbolId;
    traitMethodSymbol: ProgramSymbolId;
  };
  ir: MutableOptimizationIr;
}): readonly { moduleId: string; symbol: SymbolId }[] | undefined => {
  const targetRef = ir.baseProgram.symbols.refOf(functionId as ProgramSymbolId);
  if (targetRef.moduleId !== moduleView.moduleId) {
    return undefined;
  }
  const traitSignature = ir.baseProgram.functions.getSignature(
    targetRef.moduleId,
    targetRef.symbol,
  );
  if (
    !traitSignature ||
    !isPureSignature({ effectRow: traitSignature.effectRow, ir })
  ) {
    return undefined;
  }
  if (!isPrimitiveDirectSwitchType({ typeId: traitSignature.returnType, ir })) {
    return undefined;
  }
  if (
    traitSignature.parameters
      .slice(1)
      .some(
        (parameter) =>
          !isPrimitiveDirectSwitchType({ typeId: parameter.typeId, ir }),
      )
  ) {
    return undefined;
  }

  const receiverExprId =
    expr.exprKind === "method-call" ? expr.target : expr.args[0]?.expr;
  if (typeof receiverExprId !== "number") {
    return undefined;
  }
  const knownReceiverTypes = knownNominalsForExpr({
    moduleView,
    exprId: receiverExprId,
    callerInstanceId,
    program: ir.baseProgram,
    exactParameterTypes: ir.facts.exactParameterTypes,
    knownParameterTypes: ir.facts.knownParameterTypes,
  });
  if (
    !knownReceiverTypes ||
    knownReceiverTypes.size === 0 ||
    knownReceiverTypes.size >
      ir.facts.codegenPlan.specializationPolicy.directTraitSwitchImplementations
  ) {
    return undefined;
  }
  if (
    Array.from(knownReceiverTypes).some(
      (receiverType) =>
        ir.baseProgram.types.getTypeDesc(receiverType).kind !==
        "nominal-object",
    )
  ) {
    return undefined;
  }

  const seenImpls = new Set<ProgramSymbolId>();
  const impls = Array.from(knownReceiverTypes).flatMap((receiverType) =>
    ir.baseProgram.traits
      .getImplsByNominal(receiverType)
      .filter((impl) => impl.traitSymbol === traitMethodImpl.traitSymbol)
      .filter((impl) => {
        if (seenImpls.has(impl.implSymbol)) {
          return false;
        }
        seenImpls.add(impl.implSymbol);
        return true;
      }),
  );
  if (
    impls.length === 0 ||
    impls.length >
      ir.facts.codegenPlan.specializationPolicy.directTraitSwitchImplementations
  ) {
    return undefined;
  }

  const implMethods = impls.map((impl) => {
    const method = impl.methods.find(({ traitMethod, implMethod }) =>
      traitMethodMatches({
        traitMethod,
        implMethod,
        traitMethodImpl,
        ir,
      }),
    );
    if (!method) {
      return undefined;
    }
    const implRef = ir.baseProgram.symbols.refOf(
      method.implMethod as ProgramSymbolId,
    );
    const resolvedImpl = resolveImportedSymbol({
      moduleId: implRef.moduleId,
      symbol: implRef.symbol,
      ir,
    });
    const implSignature = ir.baseProgram.functions.getSignature(
      resolvedImpl.moduleId,
      resolvedImpl.symbol,
    );
    const supported = Boolean(
      implSignature &&
      isPureSignature({ effectRow: implSignature.effectRow, ir }) &&
      isPrimitiveDirectSwitchType({ typeId: implSignature.returnType, ir }) &&
      implSignature.parameters.length === traitSignature.parameters.length &&
      implSignature.parameters
        .slice(1)
        .every(
          (parameter, index) =>
            isPrimitiveDirectSwitchType({ typeId: parameter.typeId, ir }) &&
            parameter.typeId === traitSignature.parameters[index + 1]?.typeId,
        ),
    );
    return supported ? resolvedImpl : undefined;
  });

  return implMethods.every(Boolean)
    ? (implMethods as { moduleId: string; symbol: SymbolId }[])
    : undefined;
};

const traitDispatchOmittedMethodTableImpls = ({
  callerInstanceId,
  functionId,
  moduleView,
  expr,
  traitMethodImpl,
  ir,
}: {
  moduleView: OptimizedModuleView;
  expr: Extract<HirExpression, { exprKind: "call" | "method-call" }>;
  callerInstanceId?: ProgramFunctionInstanceId;
  functionId: ProgramFunctionId;
  traitMethodImpl: {
    traitSymbol: ProgramSymbolId;
    traitMethodSymbol: ProgramSymbolId;
  };
  ir: MutableOptimizationIr;
}): readonly { moduleId: string; symbol: SymbolId }[] | undefined => {
  if (typeof callerInstanceId !== "number") {
    return undefined;
  }
  return directSwitchOmittedMethodTableImpls({
    moduleView,
    expr,
    callerInstanceId,
    functionId,
    traitMethodImpl,
    ir,
  });
};

const resolveTargetsForCaller = ({
  moduleId,
  exprId,
  callerInstanceId,
  ir,
}: {
  moduleId: string;
  exprId: HirExprId;
  callerInstanceId?: ProgramFunctionInstanceId;
  ir: MutableOptimizationIr;
}): readonly {
  functionId: ProgramFunctionId;
  instanceId?: ProgramFunctionInstanceId;
}[] => {
  const callInfo = ir.calls.get(moduleId)?.get(exprId);
  if (!callInfo) {
    return [];
  }
  const resolveTypeArgsForCaller = (
    typeArgs: readonly TypeId[],
  ): readonly TypeId[] => {
    if (typeof callerInstanceId !== "number" || typeArgs.length === 0) {
      return typeArgs;
    }
    const caller = ir.baseProgram.functions.getInstance(callerInstanceId);
    const signature = ir.baseProgram.functions.getSignature(
      caller.symbolRef.moduleId,
      caller.symbolRef.symbol,
    );
    if (!signature) {
      return typeArgs;
    }
    const substitution = functionTypeSubstitution({
      signature,
      typeArgs: caller.typeArgs,
      program: ir.baseProgram,
    });
    return substitution
      ? typeArgs.map((typeArg) =>
          ir.baseProgram.types.substitute(typeArg, substitution),
        )
      : typeArgs;
  };
  const exactTarget =
    typeof callerInstanceId === "number"
      ? callInfo.targets?.get(callerInstanceId)
      : undefined;
  const exactTypeArgs =
    typeof callerInstanceId === "number"
      ? callInfo.typeArgs?.get(callerInstanceId)
      : undefined;
  const candidateEntries =
    typeof exactTarget === "number"
      ? [
          {
            functionId: exactTarget,
            typeArgs: resolveTypeArgsForCaller(exactTypeArgs ?? []),
          },
        ]
      : callInfo.targets
        ? Array.from(callInfo.targets.entries()).map(
            ([targetCallerInstanceId, functionId]) => ({
              functionId,
              typeArgs: resolveTypeArgsForCaller(
                callInfo.typeArgs?.get(targetCallerInstanceId) ?? [],
              ),
            }),
          )
        : [];

  return Array.from(
    new Map(
      candidateEntries.map((entry) => {
        const ref = ir.baseProgram.symbols.refOf(
          entry.functionId as ProgramSymbolId,
        );
        const instanceId = ir.baseProgram.functions.getInstanceId(
          ref.moduleId,
          ref.symbol,
          entry.typeArgs,
        );
        return [
          `${entry.functionId}:${entry.typeArgs.join(",")}`,
          {
            functionId: entry.functionId,
            instanceId,
          },
        ] as const;
      }),
    ).values(),
  );
};

const wholeProgramSpecializationPruningPass: ProgramOptimizationPass = {
  name: "whole-program-specialization-pruning",
  run(ctx) {
    const reachableInstances = new Set<ProgramFunctionInstanceId>();
    const reachableSymbols = new Set<ProgramSymbolId>();
    const reachableModuleLets = new Map<string, Set<SymbolId>>();
    const usedTraitDispatchSignatures = new Set<string>();
    const queuedInstances: ProgramFunctionInstanceId[] = [];
    const queuedInstanceIds = new Set<ProgramFunctionInstanceId>();
    const queuedModuleLets: { moduleId: string; symbol: SymbolId }[] = [];
    const queuedModuleLetKeys = new Set<string>();
    const traitInstancesByDispatchSignature = new Map<
      string,
      ProgramFunctionInstanceId[]
    >();
    let enqueuedInstances = 0;
    let processedInstances = 0;
    let enqueuedModuleLets = 0;

    ctx.ir.functionInstantiations.forEach((bySymbol) => {
      bySymbol.forEach((instantiations) => {
        instantiations.forEach((_typeArgs, instanceId) => {
          const info = ctx.ir.baseProgram.functions.getInstance(instanceId);
          const traitMethodImpl = ctx.ir.baseProgram.traits.getTraitMethodImpl(
            info.functionId as ProgramSymbolId,
          );
          if (!traitMethodImpl) {
            return;
          }
          const key = traitDispatchSignatureKey({
            traitSymbol: traitMethodImpl.traitSymbol,
            traitMethodSymbol: traitMethodImpl.traitMethodSymbol,
          });
          const instances = traitInstancesByDispatchSignature.get(key) ?? [];
          instances.push(instanceId);
          traitInstancesByDispatchSignature.set(key, instances);
        });
      });
    });

    const enqueueInstance = (
      instanceId: ProgramFunctionInstanceId | undefined,
    ): void => {
      if (
        typeof instanceId !== "number" ||
        reachableInstances.has(instanceId) ||
        queuedInstanceIds.has(instanceId)
      ) {
        return;
      }
      queuedInstances.push(instanceId);
      queuedInstanceIds.add(instanceId);
      enqueuedInstances += 1;
    };

    const recordUsedTraitDispatchSignature = (key: string): void => {
      if (usedTraitDispatchSignatures.has(key)) {
        return;
      }
      usedTraitDispatchSignatures.add(key);
      traitInstancesByDispatchSignature
        .get(key)
        ?.forEach((instanceId) => enqueueInstance(instanceId));
    };

    const enqueueModuleLet = ({
      moduleId,
      symbol,
    }: {
      moduleId: string;
      symbol: SymbolId;
    }): void => {
      const known = reachableModuleLets.get(moduleId);
      if (known?.has(symbol)) {
        return;
      }
      const key = `${moduleId}:${symbol}`;
      if (queuedModuleLetKeys.has(key)) {
        return;
      }
      queuedModuleLets.push({ moduleId, symbol });
      queuedModuleLetKeys.add(key);
      enqueuedModuleLets += 1;
    };

    const enqueueKnownFunctionInstances = ({
      moduleId,
      symbol,
    }: {
      moduleId: string;
      symbol: SymbolId;
    }): void => {
      reachableSymbols.add(
        canonicalProgramSymbolIdOf({
          moduleId,
          symbol,
          ir: ctx.ir as MutableOptimizationIr,
        }),
      );
      const knownInstances =
        ctx.ir.baseProgram.functions.getInstantiationInfo(moduleId, symbol) ??
        ctx.ir.functionInstantiations.get(moduleId)?.get(symbol);
      if (knownInstances && knownInstances.size > 0) {
        knownInstances.forEach((_, instanceId) => enqueueInstance(instanceId));
        return;
      }
      enqueueInstance(
        ctx.ir.baseProgram.functions.getInstanceId(moduleId, symbol, []),
      );
    };

    const enqueueCompilerFunctionContract = (
      contractId: CompilerFunctionContractId,
    ): void => {
      const symbolId =
        ctx.ir.baseProgram.symbols.resolveCompilerFunctionContract(contractId);
      if (typeof symbolId !== "number") {
        // Boundary auto mode is allowed to fall back to a direct export when
        // the typed wrapper is unavailable. Actual MsgPack use performs a
        // strict contract lookup and reports the missing role from codegen.
        return;
      }
      enqueueKnownFunctionInstances(ctx.ir.baseProgram.symbols.refOf(symbolId));
    };

    const enqueueMsgPackFunctions = (): void => {
      Object.values(BOUNDARY_MSGPACK_CONTRACT_IDS).forEach(
        enqueueCompilerFunctionContract,
      );
    };

    const enqueueSerializersForTypes = (typeIds: readonly TypeId[]): void => {
      typeIds.forEach((typeId) => {
        const serializer = serializerForType({
          ir: ctx.ir as MutableOptimizationIr,
          typeId,
        });
        if (!serializer) {
          return;
        }
        enqueueKnownFunctionInstances(serializer.encode);
        enqueueKnownFunctionInstances(serializer.decode);
      });
    };

    const exportedFunctionTypeLists = ({
      moduleId,
      symbol,
    }: {
      moduleId: string;
      symbol: SymbolId;
    }): readonly (readonly TypeId[])[] => {
      const resolved = resolveImportedSymbol({
        moduleId,
        symbol,
        ir: ctx.ir as MutableOptimizationIr,
      });
      const signature = ctx.ir.baseProgram.functions.getSignature(
        resolved.moduleId,
        resolved.symbol,
      );
      if (!signature) {
        return [];
      }
      const scheme = ctx.ir.baseProgram.types.getScheme(signature.scheme);
      const instantiations = ctx.ir.functionInstantiations
        .get(resolved.moduleId)
        ?.get(resolved.symbol);
      const typeArgLists =
        instantiations && instantiations.size > 0
          ? Array.from(instantiations.values())
          : scheme.params.length === 0
            ? [[] as readonly TypeId[]]
            : [];

      return typeArgLists.flatMap((typeArgs) => {
        const typeId = ctx.ir.baseProgram.types.instantiate(
          signature.scheme,
          typeArgs,
        );
        const desc = ctx.ir.baseProgram.types.getTypeDesc(typeId);
        if (desc.kind !== "function") {
          return [];
        }
        return [
          [...desc.parameters.map((param) => param.type), desc.returnType],
        ];
      });
    };

    const enqueueSerializedExportDependencies = ({
      moduleId,
      symbol,
    }: {
      moduleId: string;
      symbol: SymbolId;
    }): void => {
      exportedFunctionTypeLists({ moduleId, symbol }).forEach((typeIds) => {
        const serializer = serializerForTypes({
          ir: ctx.ir as MutableOptimizationIr,
          typeIds,
        });
        if (!serializer) {
          return;
        }
        enqueueSerializersForTypes(typeIds);
        if (serializer.formatId === "msgpack") {
          enqueueMsgPackFunctions();
        }
      });
    };

    const enqueueBoundaryExportDependencies = ({
      moduleId,
      symbol,
    }: {
      moduleId: string;
      symbol: SymbolId;
    }): void => {
      enqueueMsgPackFunctions();
      exportedFunctionTypeLists({ moduleId, symbol }).forEach((typeIds) => {
        enqueueSerializersForTypes(typeIds);
      });
    };

    const exportedFunctionUsesEffectsHostBoundary = ({
      moduleId,
      symbol,
    }: {
      moduleId: string;
      symbol: SymbolId;
    }): boolean => {
      const resolved = resolveImportedSymbol({
        moduleId,
        symbol,
        ir: ctx.ir as MutableOptimizationIr,
      });
      const signature = ctx.ir.baseProgram.functions.getSignature(
        resolved.moduleId,
        resolved.symbol,
      );
      return Boolean(
        signature &&
        !isPureSignature({
          effectRow: signature.effectRow,
          ir: ctx.ir as MutableOptimizationIr,
        }),
      );
    };

    const recordResolvedSymbolReachability = ({
      moduleId,
      symbol,
    }: {
      moduleId: string;
      symbol: SymbolId;
    }): void => {
      const resolved = resolveImportedSymbol({
        moduleId,
        symbol,
        ir: ctx.ir as MutableOptimizationIr,
      });
      const resolvedModule = ctx.ir.modules.get(resolved.moduleId);
      if (!resolvedModule) {
        return;
      }
      if (
        moduleLetBySymbol({
          ir: ctx.ir as MutableOptimizationIr,
          moduleView: resolvedModule,
          symbol: resolved.symbol,
        })
      ) {
        enqueueModuleLet(resolved);
        return;
      }
      if (
        functionItemBySymbol({
          ir: ctx.ir as MutableOptimizationIr,
          moduleView: resolvedModule,
          symbol: resolved.symbol,
        })
      ) {
        enqueueKnownFunctionInstances(resolved);
      }
    };

    const walkReachabilityRoot = ({
      moduleId,
      rootExprId,
      callerInstanceId,
    }: {
      moduleId: string;
      rootExprId: HirExprId;
      callerInstanceId?: ProgramFunctionInstanceId;
    }): void => {
      const moduleView = ctx.ir.modules.get(moduleId);
      if (!moduleView) {
        return;
      }

      (ctx.ir as MutableOptimizationIr).index
        .getBodyTopology({ moduleId, rootExprId })
        .postOrderExprIds.forEach((exprId) => {
          const expr = moduleView.hir.expressions.get(exprId);
          if (!expr) {
            return;
          }

          if (expr.exprKind === "call" || expr.exprKind === "method-call") {
            const resolvedTargets = resolveTargetsForCaller({
              moduleId,
              exprId,
              callerInstanceId,
              ir: ctx.ir as MutableOptimizationIr,
            });
            resolvedTargets.forEach(({ functionId, instanceId }) => {
              const targetRef = ctx.ir.baseProgram.symbols.refOf(
                functionId as ProgramSymbolId,
              );
              reachableSymbols.add(
                canonicalProgramSymbolIdOf({
                  moduleId: targetRef.moduleId,
                  symbol: targetRef.symbol,
                  ir: ctx.ir as MutableOptimizationIr,
                }),
              );
              enqueueInstance(instanceId);

              const callInfo = ctx.ir.calls.get(moduleId)?.get(exprId);
              if (!callInfo?.traitDispatch) {
                return;
              }
              const traitMethodImpl =
                ctx.ir.baseProgram.traits.getTraitMethodImpl(
                  functionId as ProgramSymbolId,
                );
              if (!traitMethodImpl) {
                return;
              }
              const omittedMethodTableImpls =
                traitDispatchOmittedMethodTableImpls({
                  moduleView,
                  expr,
                  callerInstanceId,
                  functionId,
                  traitMethodImpl,
                  ir: ctx.ir as MutableOptimizationIr,
                });
              if (omittedMethodTableImpls) {
                omittedMethodTableImpls.forEach((impl) =>
                  enqueueKnownFunctionInstances(impl),
                );
                return;
              }
              recordUsedTraitDispatchSignature(
                traitDispatchSignatureKey({
                  traitSymbol: traitMethodImpl.traitSymbol,
                  traitMethodSymbol: traitMethodImpl.traitMethodSymbol,
                }),
              );
            });

            if (expr.exprKind === "call") {
              const callee = moduleView.hir.expressions.get(expr.callee);
              if (callee?.exprKind === "identifier") {
                const calleeId = canonicalProgramSymbolIdOf({
                  moduleId,
                  symbol: callee.symbol,
                  ir: ctx.ir as MutableOptimizationIr,
                });
                const intrinsicName =
                  ctx.ir.baseProgram.symbols.getIntrinsicName(calleeId);
                if (
                  intrinsicName &&
                  BOUNDARY_MSGPACK_DEPENDENT_INTRINSICS.has(intrinsicName)
                ) {
                  enqueueMsgPackFunctions();
                }
                recordResolvedSymbolReachability({
                  moduleId,
                  symbol: callee.symbol,
                });
              }
            }
          }

          if (expr.exprKind === "identifier") {
            recordResolvedSymbolReachability({
              moduleId,
              symbol: expr.symbol,
            });
          }

          if (expr.exprKind === "literal" && expr.literalKind === "string") {
            const dependency = resolveIntrinsicFunction({
              ir: ctx.ir as MutableOptimizationIr,
              intrinsicName: "__string_new",
            });
            if (dependency) {
              enqueueKnownFunctionInstances(dependency);
            }
          }
        });
    };

    const rootModules =
      ctx.ir.options.testMode && ctx.ir.options.testScope === "all"
        ? Array.from(ctx.ir.modules.values())
        : [ctx.ir.modules.get(ctx.ir.entryModuleId)].filter(
            (module): module is OptimizedModuleView => Boolean(module),
          );
    const entryModule = ctx.ir.modules.get(ctx.ir.entryModuleId);
    rootModules.forEach((rootModule) => {
      rootModule.hir.module.exports.forEach((entry) => {
        recordResolvedSymbolReachability({
          moduleId: rootModule.moduleId,
          symbol: entry.symbol,
        });
        enqueueSerializedExportDependencies({
          moduleId: rootModule.moduleId,
          symbol: entry.symbol,
        });
        const exportName =
          entry.alias ??
          ctx.ir.baseProgram.symbols.getName(
            canonicalProgramSymbolIdOf({
              moduleId: rootModule.moduleId,
              symbol: entry.symbol,
              ir: ctx.ir as MutableOptimizationIr,
            }),
          ) ??
          `${entry.symbol}`;
        if (
          !ctx.ir.options.testMode &&
          ctx.ir.options.effectsHostBoundary !== "off" &&
          exportedFunctionUsesEffectsHostBoundary({
            moduleId: rootModule.moduleId,
            symbol: entry.symbol,
          })
        ) {
          enqueueMsgPackFunctions();
        }
        if (
          !ctx.ir.options.testMode &&
          shouldConsiderBoundaryExportForOptimization({
            exportName,
            boundaryExports: ctx.ir.options.boundaryExports,
          })
        ) {
          enqueueBoundaryExportDependencies({
            moduleId: rootModule.moduleId,
            symbol: entry.symbol,
          });
        }
      });
    });

    if (
      entryModule &&
      queuedInstances.length === 0 &&
      queuedModuleLets.length === 0
    ) {
      entryModule.hir.items.forEach((item) => {
        if (item.kind === "function") {
          enqueueKnownFunctionInstances({
            moduleId: entryModule.moduleId,
            symbol: item.symbol,
          });
          return;
        }
        if (item.kind !== "module-let") {
          return;
        }
        enqueueModuleLet({
          moduleId: entryModule.moduleId,
          symbol: item.symbol,
        });
      });
    }

    while (queuedInstances.length > 0 || queuedModuleLets.length > 0) {
      const instanceId = queuedInstances.pop();
      if (typeof instanceId === "number") {
        queuedInstanceIds.delete(instanceId);
        if (reachableInstances.has(instanceId)) {
          continue;
        }
        reachableInstances.add(instanceId);
        processedInstances += 1;
        const instance = ctx.ir.baseProgram.functions.getInstance(instanceId);
        reachableSymbols.add(
          canonicalProgramSymbolIdOf({
            moduleId: instance.symbolRef.moduleId,
            symbol: instance.symbolRef.symbol,
            ir: ctx.ir as MutableOptimizationIr,
          }),
        );
        const moduleView = ctx.ir.modules.get(instance.symbolRef.moduleId);
        if (!moduleView) {
          continue;
        }
        const item = functionItemBySymbol({
          ir: ctx.ir as MutableOptimizationIr,
          moduleView,
          symbol: instance.symbolRef.symbol,
        });
        if (!item) {
          continue;
        }

        const walkRoots = [
          item.body,
          ...item.parameters.flatMap((parameter) =>
            typeof parameter.defaultValue === "number"
              ? [parameter.defaultValue]
              : [],
          ),
        ];
        walkRoots.forEach((rootExprId) =>
          walkReachabilityRoot({
            moduleId: moduleView.moduleId,
            rootExprId,
            callerInstanceId: instanceId,
          }),
        );
        continue;
      }

      const nextModuleLet = queuedModuleLets.pop();
      if (!nextModuleLet) {
        continue;
      }
      queuedModuleLetKeys.delete(
        `${nextModuleLet.moduleId}:${nextModuleLet.symbol}`,
      );
      const knownModuleLets =
        reachableModuleLets.get(nextModuleLet.moduleId) ?? new Set<SymbolId>();
      if (knownModuleLets.has(nextModuleLet.symbol)) {
        continue;
      }
      knownModuleLets.add(nextModuleLet.symbol);
      reachableModuleLets.set(nextModuleLet.moduleId, knownModuleLets);

      const moduleView = ctx.ir.modules.get(nextModuleLet.moduleId);
      const moduleLet = moduleView
        ? moduleLetBySymbol({
            ir: ctx.ir as MutableOptimizationIr,
            moduleView,
            symbol: nextModuleLet.symbol,
          })
        : undefined;
      if (!moduleView || !moduleLet) {
        continue;
      }
      walkReachabilityRoot({
        moduleId: nextModuleLet.moduleId,
        rootExprId: moduleLet.initializer,
      });
    }

    const survivingInstances = ctx.ir.baseProgram.instances
      .getAll()
      .filter((instance) => reachableInstances.has(instance.instanceId));

    const nextInstantiations = new Map<
      string,
      Map<SymbolId, Map<ProgramFunctionInstanceId, readonly TypeId[]>>
    >();
    normalizeFunctionInstantiations({ program: ctx.ir.baseProgram }).forEach(
      (bySymbol, moduleId) => {
        const nextBySymbol = new Map<
          SymbolId,
          Map<ProgramFunctionInstanceId, readonly TypeId[]>
        >();
        bySymbol.forEach((instantiations, symbol) => {
          const nextInstances = new Map<
            ProgramFunctionInstanceId,
            readonly TypeId[]
          >();
          instantiations.forEach((typeArgs, instanceId) => {
            if (reachableInstances.has(instanceId)) {
              nextInstances.set(instanceId, typeArgs);
            }
          });
          nextBySymbol.set(symbol, nextInstances);
        });
        nextInstantiations.set(moduleId, nextBySymbol);
      },
    );

    const previousInstanceIds = new Set(
      ctx.ir.survivingInstances.map((instance) => instance.instanceId),
    );
    const nextSurvivingInstanceIds = new Set(
      survivingInstances.map((instance) => instance.instanceId),
    );
    const survivingInstancesChanged =
      survivingInstances.length !== ctx.ir.survivingInstances.length ||
      Array.from(nextSurvivingInstanceIds).some(
        (instanceId) => !previousInstanceIds.has(instanceId),
      );
    const reachableInstancesChanged = !setEquals(
      reachableInstances,
      ctx.ir.facts.reachableFunctionInstances,
    );
    const reachableSymbolsChanged = !setEquals(
      reachableSymbols,
      ctx.ir.facts.reachableFunctionSymbols,
    );
    const reachableModuleLetsChanged = !mapOfSetEquals(
      reachableModuleLets,
      ctx.ir.facts.reachableModuleLets,
    );
    const traitDispatchSignaturesChanged = !setEquals(
      usedTraitDispatchSignatures,
      ctx.ir.facts.usedTraitDispatchSignatures,
    );
    const changed =
      survivingInstancesChanged ||
      reachableInstancesChanged ||
      reachableSymbolsChanged ||
      reachableModuleLetsChanged ||
      traitDispatchSignaturesChanged;
    const prunedInstances = Math.max(
      0,
      ctx.ir.survivingInstances.length - survivingInstances.length,
    );

    (ctx.ir as MutableOptimizationIr).survivingInstances = survivingInstances;
    (ctx.ir as MutableOptimizationIr).functionInstantiations =
      nextInstantiations;
    ctx.ir.facts.reachableFunctionInstances = reachableInstances;
    ctx.ir.facts.reachableFunctionSymbols = reachableSymbols;
    ctx.ir.facts.reachableModuleLets = reachableModuleLets;
    ctx.ir.facts.usedTraitDispatchSignatures = usedTraitDispatchSignatures;

    return {
      changed,
      metrics: {
        pruned_instances: prunedInstances,
        worklist_instance_enqueues: enqueuedInstances,
        worklist_instance_pops: processedInstances,
        worklist_module_let_enqueues: enqueuedModuleLets,
        changed_surviving_instances: Number(survivingInstancesChanged),
        changed_reachable_instances: Number(reachableInstancesChanged),
        changed_reachable_symbols: Number(reachableSymbolsChanged),
        changed_reachable_module_lets: Number(reachableModuleLetsChanged),
        changed_trait_dispatch_signatures: Number(
          traitDispatchSignaturesChanged,
        ),
      },
    };
  },
};

type MutableEscapeOriginFact = {
  originKind: EscapeAnalysisOriginKind;
  typeId?: TypeId;
  escapes: boolean;
  escapeReasons: Set<EscapeAnalysisEscapeReason>;
  directLocalSymbols: Set<SymbolId>;
  useExprIds: Set<HirExprId>;
};

type MutableEscapeParameterFact = {
  escapes: boolean;
  escapeReasons: Set<EscapeAnalysisEscapeReason>;
  useExprIds: Set<HirExprId>;
};

type EscapeUseContext = {
  reason?: EscapeAnalysisEscapeReason;
  traitBoundary?: boolean;
};

type StructuralEscapeField = {
  name: string;
  typeId: TypeId;
  optional: boolean;
};

type EscapeAnalysisState = {
  ir: MutableOptimizationIr;
  moduleView: OptimizedModuleView;
  callerInstanceId?: ProgramFunctionInstanceId;
  parameterSymbols: ReadonlySet<SymbolId>;
  parameterFacts: ReadonlyMap<
    ProgramFunctionInstanceId,
    ReadonlyMap<SymbolId, MutableEscapeParameterFact>
  >;
  mutableParameterFacts?: Map<SymbolId, MutableEscapeParameterFact>;
  mutableOriginFacts?: Map<string, Map<HirExprId, MutableEscapeOriginFact>>;
  localOrigins: Map<SymbolId, Set<HirExprId>>;
  localParameterAliases: Map<SymbolId, Set<SymbolId>>;
};

const emptyEscapeUseContext: EscapeUseContext = {};

const serializeMutableParameterFacts = (
  facts: ReadonlyMap<
    ProgramFunctionInstanceId,
    ReadonlyMap<SymbolId, MutableEscapeParameterFact>
  >,
): string =>
  JSON.stringify(
    Array.from(facts.entries())
      .sort(([left], [right]) => left - right)
      .map(([instanceId, bySymbol]) => [
        instanceId,
        Array.from(bySymbol.entries())
          .sort(([left], [right]) => left - right)
          .map(([symbol, fact]) => [
            symbol,
            fact.escapes,
            Array.from(fact.escapeReasons).sort(),
            Array.from(fact.useExprIds).sort((left, right) => left - right),
          ]),
      ]),
  );

const toImmutableParameterFacts = (
  facts: ReadonlyMap<
    ProgramFunctionInstanceId,
    ReadonlyMap<SymbolId, MutableEscapeParameterFact>
  >,
): Map<ProgramFunctionInstanceId, Map<SymbolId, EscapeAnalysisParameterFact>> =>
  new Map(
    Array.from(facts.entries()).map(([instanceId, bySymbol]) => [
      instanceId,
      new Map(
        Array.from(bySymbol.entries()).map(([symbol, fact]) => [
          symbol,
          {
            escapes: fact.escapes,
            escapeReasons: Array.from(fact.escapeReasons).sort(),
            useExprIds: Array.from(fact.useExprIds).sort(
              (left, right) => left - right,
            ),
          },
        ]),
      ),
    ]),
  );

const toImmutableOriginFacts = (
  facts: ReadonlyMap<string, ReadonlyMap<HirExprId, MutableEscapeOriginFact>>,
): Map<string, Map<HirExprId, EscapeAnalysisOriginFact>> =>
  new Map(
    Array.from(facts.entries()).map(([moduleId, byExpr]) => [
      moduleId,
      new Map(
        Array.from(byExpr.entries()).map(([exprId, fact]) => [
          exprId,
          {
            originKind: fact.originKind,
            typeId: fact.typeId,
            escapes: fact.escapes,
            escapeReasons: Array.from(fact.escapeReasons).sort(),
            directLocalSymbols: Array.from(fact.directLocalSymbols).sort(
              (left, right) => left - right,
            ),
            useExprIds: Array.from(fact.useExprIds).sort(
              (left, right) => left - right,
            ),
          },
        ]),
      ),
    ]),
  );

const mutableParameterFactFor = ({
  facts,
  instanceId,
  symbol,
}: {
  facts: Map<
    ProgramFunctionInstanceId,
    Map<SymbolId, MutableEscapeParameterFact>
  >;
  instanceId: ProgramFunctionInstanceId;
  symbol: SymbolId;
}): MutableEscapeParameterFact => {
  const bySymbol =
    facts.get(instanceId) ?? new Map<SymbolId, MutableEscapeParameterFact>();
  const fact = bySymbol.get(symbol) ?? {
    escapes: false,
    escapeReasons: new Set<EscapeAnalysisEscapeReason>(),
    useExprIds: new Set<HirExprId>(),
  };
  bySymbol.set(symbol, fact);
  facts.set(instanceId, bySymbol);
  return fact;
};

const markParameterUse = ({
  fact,
  exprId,
  reason,
}: {
  fact: MutableEscapeParameterFact;
  exprId: HirExprId;
  reason?: EscapeAnalysisEscapeReason;
}): void => {
  fact.useExprIds.add(exprId);
  if (!reason) {
    return;
  }
  fact.escapes = true;
  fact.escapeReasons.add(reason);
};

const markOriginUse = ({
  fact,
  exprId,
  reason,
  traitBoundary,
}: {
  fact: MutableEscapeOriginFact;
  exprId: HirExprId;
  reason?: EscapeAnalysisEscapeReason;
  traitBoundary?: boolean;
}): void => {
  fact.useExprIds.add(exprId);
  if (traitBoundary && fact.originKind === "aggregate") {
    fact.originKind = "trait-object";
  }
  const effectiveReason =
    fact.originKind === "effect-environment" &&
    reason !== "handler-resumption-escape"
      ? undefined
      : reason;
  if (!effectiveReason) {
    return;
  }
  fact.escapes = true;
  fact.escapeReasons.add(effectiveReason);
};

const originKindForExpr = ({
  moduleView,
  exprId,
  ir,
}: {
  moduleView: OptimizedModuleView;
  exprId: HirExprId;
  ir: MutableOptimizationIr;
}): EscapeAnalysisOriginKind | undefined => {
  const expr = moduleView.hir.expressions.get(exprId);
  if (!expr) {
    return undefined;
  }
  if (expr.exprKind === "lambda") {
    return "closure-environment";
  }
  if (expr.exprKind === "effect-handler") {
    return "effect-environment";
  }
  if (expr.exprKind !== "object-literal" && expr.exprKind !== "tuple") {
    return undefined;
  }

  const typeId = exprTypeFor({ moduleView, exprId });
  if (typeof typeId !== "number") {
    return "aggregate";
  }
  const desc = ir.baseProgram.types.getTypeDesc(typeId);
  return desc.kind === "trait" ||
    (desc.kind === "intersection" && (desc.traits?.length ?? 0) > 0)
    ? "trait-object"
    : "aggregate";
};

const ensureOriginFact = ({
  state,
  exprId,
}: {
  state: EscapeAnalysisState;
  exprId: HirExprId;
}): MutableEscapeOriginFact | undefined => {
  const originKind = originKindForExpr({
    moduleView: state.moduleView,
    exprId,
    ir: state.ir,
  });
  if (!originKind || !state.mutableOriginFacts) {
    return undefined;
  }
  const byModule =
    state.mutableOriginFacts.get(state.moduleView.moduleId) ??
    new Map<HirExprId, MutableEscapeOriginFact>();
  const existing = byModule.get(exprId);
  if (existing) {
    return existing;
  }
  const typeId = exprTypeFor({ moduleView: state.moduleView, exprId });
  const fact: MutableEscapeOriginFact = {
    originKind,
    typeId,
    escapes: false,
    escapeReasons: new Set(),
    directLocalSymbols: new Set(),
    useExprIds: new Set(),
  };
  byModule.set(exprId, fact);
  state.mutableOriginFacts.set(state.moduleView.moduleId, byModule);
  return fact;
};

const localOriginsForSymbol = ({
  state,
  symbol,
}: {
  state: EscapeAnalysisState;
  symbol: SymbolId;
}): ReadonlySet<HirExprId> | undefined => state.localOrigins.get(symbol);

const bindLocalOrigin = ({
  state,
  symbol,
  originExprId,
}: {
  state: EscapeAnalysisState;
  symbol: SymbolId;
  originExprId: HirExprId;
}): void => {
  const origins = state.localOrigins.get(symbol) ?? new Set<HirExprId>();
  origins.add(originExprId);
  state.localOrigins.set(symbol, origins);
  const fact = ensureOriginFact({ state, exprId: originExprId });
  fact?.directLocalSymbols.add(symbol);
};

const localParameterAliasesForSymbol = ({
  state,
  symbol,
}: {
  state: EscapeAnalysisState;
  symbol: SymbolId;
}): ReadonlySet<SymbolId> | undefined =>
  state.localParameterAliases.get(symbol);

const unionInto = <T>(
  target: Set<T>,
  values: Iterable<T> | undefined,
): void => {
  if (!values) {
    return;
  }
  Array.from(values).forEach((value) => target.add(value));
};

const parameterAliasesForInitializer = ({
  state,
  exprId,
}: {
  state: EscapeAnalysisState;
  exprId: HirExprId;
}): Set<SymbolId> => {
  const expr = state.moduleView.hir.expressions.get(exprId);
  if (!expr) {
    return new Set();
  }
  if (expr.exprKind === "identifier") {
    return new Set([
      ...(state.parameterSymbols.has(expr.symbol) ? [expr.symbol] : []),
      ...(localParameterAliasesForSymbol({ state, symbol: expr.symbol }) ?? []),
    ]);
  }
  if (expr.exprKind === "block") {
    return typeof expr.value === "number"
      ? parameterAliasesForInitializer({ state, exprId: expr.value })
      : new Set();
  }
  if (expr.exprKind === "if" || expr.exprKind === "cond") {
    const aliases = new Set<SymbolId>();
    expr.branches.forEach((branch) => {
      unionInto(
        aliases,
        parameterAliasesForInitializer({ state, exprId: branch.value }),
      );
    });
    if (typeof expr.defaultBranch === "number") {
      unionInto(
        aliases,
        parameterAliasesForInitializer({ state, exprId: expr.defaultBranch }),
      );
    }
    return aliases;
  }
  if (expr.exprKind === "match") {
    const aliases = new Set<SymbolId>();
    expr.arms.forEach((arm) => {
      unionInto(
        aliases,
        parameterAliasesForInitializer({ state, exprId: arm.value }),
      );
    });
    return aliases;
  }
  if (expr.exprKind === "effect-handler") {
    const aliases = parameterAliasesForInitializer({
      state,
      exprId: expr.body,
    });
    expr.handlers.forEach((handler) => {
      unionInto(
        aliases,
        parameterAliasesForInitializer({ state, exprId: handler.body }),
      );
    });
    if (typeof expr.finallyBranch === "number") {
      unionInto(
        aliases,
        parameterAliasesForInitializer({ state, exprId: expr.finallyBranch }),
      );
    }
    return aliases;
  }
  return new Set();
};

const bindLocalParameterAliases = ({
  state,
  symbol,
  parameterSymbols,
}: {
  state: EscapeAnalysisState;
  symbol: SymbolId;
  parameterSymbols: ReadonlySet<SymbolId>;
}): void => {
  if (parameterSymbols.size === 0) {
    return;
  }
  const aliases =
    state.localParameterAliases.get(symbol) ?? new Set<SymbolId>();
  parameterSymbols.forEach((parameterSymbol) => aliases.add(parameterSymbol));
  state.localParameterAliases.set(symbol, aliases);
};

const markSymbolUse = ({
  state,
  symbol,
  exprId,
  context,
}: {
  state: EscapeAnalysisState;
  symbol: SymbolId;
  exprId: HirExprId;
  context: EscapeUseContext;
}): void => {
  const origins = localOriginsForSymbol({ state, symbol });
  origins?.forEach((originExprId) => {
    const fact = ensureOriginFact({ state, exprId: originExprId });
    if (!fact) {
      return;
    }
    markOriginUse({
      fact,
      exprId,
      reason: context.reason,
      traitBoundary: context.traitBoundary,
    });
  });

  const parameterSymbols = new Set([
    ...(state.parameterSymbols.has(symbol) ? [symbol] : []),
    ...(localParameterAliasesForSymbol({ state, symbol }) ?? []),
  ]);
  parameterSymbols.forEach((parameterSymbol) => {
    const fact = state.mutableParameterFacts?.get(parameterSymbol);
    if (!fact) {
      return;
    }
    markParameterUse({
      fact,
      exprId,
      reason: context.reason,
    });
  });
};

const markSymbolSetUse = ({
  state,
  symbols,
  exprId,
  reason,
}: {
  state: EscapeAnalysisState;
  symbols: Iterable<SymbolId>;
  exprId: HirExprId;
  reason: EscapeAnalysisEscapeReason;
}): void => {
  Array.from(symbols).forEach((symbol) =>
    markSymbolUse({
      state,
      symbol,
      exprId,
      context: { reason },
    }),
  );
};

const originExprIdsForInitializer = ({
  state,
  exprId,
}: {
  state: EscapeAnalysisState;
  exprId: HirExprId;
}): Set<HirExprId> => {
  const expr = state.moduleView.hir.expressions.get(exprId);
  if (!expr) {
    return new Set();
  }
  if (expr.exprKind === "effect-handler") {
    const origins = new Set<HirExprId>([exprId]);
    unionInto(
      origins,
      originExprIdsForInitializer({ state, exprId: expr.body }),
    );
    expr.handlers.forEach((handler) => {
      unionInto(
        origins,
        originExprIdsForInitializer({ state, exprId: handler.body }),
      );
    });
    if (typeof expr.finallyBranch === "number") {
      unionInto(
        origins,
        originExprIdsForInitializer({ state, exprId: expr.finallyBranch }),
      );
    }
    return origins;
  }
  if (
    originKindForExpr({ moduleView: state.moduleView, exprId, ir: state.ir })
  ) {
    return new Set([exprId]);
  }
  if (expr.exprKind === "identifier") {
    return new Set(localOriginsForSymbol({ state, symbol: expr.symbol }) ?? []);
  }
  if (expr.exprKind === "block") {
    return typeof expr.value === "number"
      ? originExprIdsForInitializer({ state, exprId: expr.value })
      : new Set();
  }
  if (expr.exprKind === "if" || expr.exprKind === "cond") {
    const origins = new Set<HirExprId>();
    expr.branches.forEach((branch) => {
      unionInto(
        origins,
        originExprIdsForInitializer({ state, exprId: branch.value }),
      );
    });
    if (typeof expr.defaultBranch === "number") {
      unionInto(
        origins,
        originExprIdsForInitializer({ state, exprId: expr.defaultBranch }),
      );
    }
    return origins;
  }
  if (expr.exprKind === "match") {
    const origins = new Set<HirExprId>();
    expr.arms.forEach((arm) => {
      unionInto(
        origins,
        originExprIdsForInitializer({ state, exprId: arm.value }),
      );
    });
    return origins;
  }
  return new Set();
};

const isTraitType = ({
  typeId,
  ir,
}: {
  typeId: TypeId | undefined;
  ir: MutableOptimizationIr;
}): boolean => {
  if (typeof typeId !== "number") {
    return false;
  }
  const desc = ir.baseProgram.types.getTypeDesc(typeId);
  return (
    desc.kind === "trait" ||
    (desc.kind === "intersection" && (desc.traits?.length ?? 0) > 0)
  );
};

const targetParameterIsMutable = ({
  state,
  moduleId,
  symbol,
  parameterIndex,
  parameter,
}: {
  state: EscapeAnalysisState;
  moduleId: string;
  symbol: SymbolId;
  parameterIndex: number;
  parameter: CodegenFunctionSignature["parameters"][number];
}): boolean => {
  if (parameter.bindingKind === "mutable-ref") {
    return true;
  }
  const moduleView = state.ir.modules.get(moduleId);
  const item = moduleView
    ? functionItemBySymbol({ ir: state.ir, moduleView, symbol })
    : undefined;
  return item?.parameters[parameterIndex]?.mutable === true;
};

const structuralEscapeFieldsForType = ({
  typeId,
  state,
  seen = new Set<TypeId>(),
}: {
  typeId: TypeId;
  state: EscapeAnalysisState;
  seen?: Set<TypeId>;
}): readonly StructuralEscapeField[] | undefined => {
  if (seen.has(typeId)) {
    return undefined;
  }
  seen.add(typeId);

  const layout = state.ir.baseProgram.types.getStructuralLayout(typeId);
  if (layout?.kind === "structural-object") {
    return layout.fields;
  }

  const objectInfo = state.ir.baseProgram.objects.getInfoByNominal(typeId);
  if (objectInfo) {
    return objectInfo.fields.map((field) => ({
      name: field.name,
      typeId: field.type,
      optional: field.optional === true,
    }));
  }

  const desc = state.ir.baseProgram.types.getTypeDesc(typeId);
  if (desc.kind === "intersection") {
    const structural =
      typeof desc.structural === "number"
        ? structuralEscapeFieldsForType({
            typeId: desc.structural,
            state,
            seen,
          })
        : undefined;
    if (structural) {
      return structural;
    }
    return typeof desc.nominal === "number"
      ? structuralEscapeFieldsForType({ typeId: desc.nominal, state, seen })
      : undefined;
  }

  return undefined;
};

const parameterCanBeOmittedAtCallSite = ({
  parameter,
  moduleId,
  state,
}: {
  parameter: CodegenFunctionSignature["parameters"][number];
  moduleId: string;
  state: EscapeAnalysisState;
}): boolean =>
  parameter.optional === true ||
  parameter.synthetic === "stable-callsite-id" ||
  state.ir.baseProgram.optionals.getOptionalInfo(moduleId, parameter.typeId) !==
    undefined;

const callLabelsCompatible = ({
  parameter,
  argLabel,
}: {
  parameter: CodegenFunctionSignature["parameters"][number];
  argLabel: string | undefined;
}): boolean =>
  parameter.label ? argLabel === parameter.label : argLabel === undefined;

const fallbackContainerFieldParameterIndexesForCallArgument = ({
  expr,
  argIndex,
  signature,
  moduleId,
  state,
}: {
  expr: Extract<HirExpression, { exprKind: "call" | "method-call" }>;
  argIndex: number;
  signature: CodegenFunctionSignature;
  moduleId: string;
  state: EscapeAnalysisState;
}): readonly number[] | undefined => {
  if (expr.exprKind !== "call") {
    return undefined;
  }

  const targetArg = expr.args[argIndex];
  if (!targetArg || targetArg.label !== undefined) {
    return undefined;
  }

  const targetArgTypeId = exprTypeFor({
    moduleView: state.moduleView,
    exprId: targetArg.expr,
  });
  if (typeof targetArgTypeId !== "number") {
    return undefined;
  }

  const targetFields = structuralEscapeFieldsForType({
    typeId: targetArgTypeId,
    state,
  });
  if (!targetFields) {
    return undefined;
  }
  const fieldsByName = new Map(
    targetFields.map((field) => [field.name, field]),
  );

  const parameterIndexes: number[] = [];
  let cursorArgIndex = 0;
  let cursorParameterIndex = 0;

  while (cursorParameterIndex < signature.parameters.length) {
    const parameter = signature.parameters[cursorParameterIndex]!;
    const arg = expr.args[cursorArgIndex];

    if (!arg) {
      if (parameterCanBeOmittedAtCallSite({ parameter, moduleId, state })) {
        cursorParameterIndex += 1;
        continue;
      }
      return undefined;
    }

    if (parameter.label && arg.label === undefined) {
      const argTypeId = exprTypeFor({
        moduleView: state.moduleView,
        exprId: arg.expr,
      });
      if (typeof argTypeId !== "number") {
        return undefined;
      }

      const fields = structuralEscapeFieldsForType({
        typeId: argTypeId,
        state,
      });
      const fieldMap = fields
        ? new Map(fields.map((field) => [field.name, field]))
        : undefined;
      if (fieldMap) {
        let nextParameterIndex = cursorParameterIndex;
        const containerParameterIndexes: number[] = [];
        while (nextParameterIndex < signature.parameters.length) {
          const runParameter = signature.parameters[nextParameterIndex]!;
          if (!runParameter.label) {
            break;
          }

          if (fieldMap.has(runParameter.label)) {
            containerParameterIndexes.push(nextParameterIndex);
            nextParameterIndex += 1;
            continue;
          }

          if (
            parameterCanBeOmittedAtCallSite({
              parameter: runParameter,
              moduleId,
              state,
            })
          ) {
            nextParameterIndex += 1;
            continue;
          }

          return undefined;
        }

        if (nextParameterIndex > cursorParameterIndex) {
          if (cursorArgIndex === argIndex) {
            if (containerParameterIndexes.length === 0) {
              return undefined;
            }
            parameterIndexes.push(...containerParameterIndexes);
          }
          cursorParameterIndex = nextParameterIndex;
          cursorArgIndex += 1;
          continue;
        }
      }
    }

    if (callLabelsCompatible({ parameter, argLabel: arg.label })) {
      if (cursorArgIndex === argIndex) {
        return undefined;
      }
      cursorParameterIndex += 1;
      cursorArgIndex += 1;
      continue;
    }

    if (parameterCanBeOmittedAtCallSite({ parameter, moduleId, state })) {
      cursorParameterIndex += 1;
      continue;
    }

    return undefined;
  }

  if (cursorArgIndex < expr.args.length) {
    return undefined;
  }

  return parameterIndexes.length > 0 &&
    parameterIndexes.every((index) =>
      fieldsByName.has(signature.parameters[index]!.label!),
    )
    ? parameterIndexes
    : undefined;
};

const contextForCallArgument = ({
  moduleView,
  exprId,
  expr,
  argExprId,
  argIndex,
  state,
}: {
  moduleView: OptimizedModuleView;
  exprId: HirExprId;
  expr: Extract<HirExpression, { exprKind: "call" | "method-call" }>;
  argExprId: HirExprId;
  argIndex: number;
  state: EscapeAnalysisState;
}): EscapeUseContext => {
  const callInfo = state.ir.calls.get(moduleView.moduleId)?.get(exprId);
  if (callInfo?.traitDispatch) {
    return {
      reason: argIndex === 0 ? "dynamic-dispatch" : "call-boundary",
      traitBoundary: argIndex === 0,
    };
  }

  const resolvedTargets =
    typeof state.callerInstanceId === "number"
      ? resolveTargetsForExactPropagation({
          moduleView,
          exprId,
          expr,
          callerInstanceId: state.callerInstanceId,
          ir: state.ir,
        })
      : resolveTargetsForCaller({
          moduleId: moduleView.moduleId,
          exprId,
          callerInstanceId: state.callerInstanceId,
          ir: state.ir,
        });
  const targets =
    resolvedTargets.length > 0
      ? resolvedTargets
      : resolveDirectIdentifierCallTarget({
          moduleView,
          expr,
          typeArgs: callInfo
            ? resolveCallTypeArgs({
                callInfo,
                callerInstanceId: state.callerInstanceId,
              })
            : [],
          ir: state.ir,
        });
  if (targets.length === 0) {
    return { reason: "unknown" };
  }

  const argPlan = callInfo
    ? resolveCallArgPlan({ callInfo, callerInstanceId: state.callerInstanceId })
    : undefined;
  const containerFieldEntries =
    argPlan?.flatMap((entry, parameterIndex) =>
      entry.kind === "container-field" && entry.containerArgIndex === argIndex
        ? [{ entry, parameterIndex }]
        : [],
    ) ?? [];
  const argIsOnlyContainerFields =
    containerFieldEntries.length > 0 &&
    argPlan?.every((entry) =>
      entry.kind === "container-field"
        ? entry.containerArgIndex === argIndex ||
          entry.containerArgIndex !== argIndex
        : entry.kind !== "direct" || entry.argIndex !== argIndex,
    ) === true;
  if (argIsOnlyContainerFields) {
    let unsafeReason: EscapeAnalysisEscapeReason | undefined;
    targets.forEach(({ instanceId }) => {
      if (unsafeReason || typeof instanceId !== "number") {
        unsafeReason = unsafeReason ?? "unknown";
        return;
      }
      const target = state.ir.baseProgram.functions.getInstance(instanceId);
      const signature = state.ir.baseProgram.functions.getSignature(
        target.symbolRef.moduleId,
        target.symbolRef.symbol,
      );
      if (!signature) {
        unsafeReason = "unknown";
        return;
      }
      if (!state.ir.baseProgram.effects.isEmpty(signature.effectRow)) {
        unsafeReason = "effectful-call";
        return;
      }
      containerFieldEntries.forEach(({ parameterIndex }) => {
        if (unsafeReason) {
          return;
        }
        const parameter = signature.parameters[parameterIndex];
        if (!parameter || typeof parameter.symbol !== "number") {
          unsafeReason = "unknown";
          return;
        }
        if (
          targetParameterIsMutable({
            state,
            moduleId: target.symbolRef.moduleId,
            symbol: target.symbolRef.symbol,
            parameterIndex,
            parameter,
          })
        ) {
          unsafeReason = "mutable-call-argument";
          return;
        }
      });
    });
    if (!unsafeReason) {
      return {};
    }
  }
  if (!argPlan) {
    let unsafeReason: EscapeAnalysisEscapeReason | undefined;
    targets.forEach(({ instanceId }) => {
      if (unsafeReason || typeof instanceId !== "number") {
        unsafeReason = unsafeReason ?? "unknown";
        return;
      }
      const target = state.ir.baseProgram.functions.getInstance(instanceId);
      const signature = state.ir.baseProgram.functions.getSignature(
        target.symbolRef.moduleId,
        target.symbolRef.symbol,
      );
      if (!signature) {
        unsafeReason = "unknown";
        return;
      }
      if (!state.ir.baseProgram.effects.isEmpty(signature.effectRow)) {
        unsafeReason = "effectful-call";
        return;
      }
      const parameterIndexes =
        fallbackContainerFieldParameterIndexesForCallArgument({
          expr,
          argIndex,
          signature,
          moduleId: target.symbolRef.moduleId,
          state,
        });
      if (!parameterIndexes) {
        unsafeReason = "unknown";
        return;
      }
      parameterIndexes.forEach((parameterIndex) => {
        if (unsafeReason) {
          return;
        }
        const parameter = signature.parameters[parameterIndex];
        if (!parameter || typeof parameter.symbol !== "number") {
          unsafeReason = "unknown";
          return;
        }
        if (
          targetParameterIsMutable({
            state,
            moduleId: target.symbolRef.moduleId,
            symbol: target.symbolRef.symbol,
            parameterIndex,
            parameter,
          })
        ) {
          unsafeReason = "mutable-call-argument";
          return;
        }
      });
    });
    if (!unsafeReason) {
      return {};
    }
  }

  let traitBoundary = false;
  let unsafeReason: EscapeAnalysisEscapeReason | undefined;
  targets.forEach(({ instanceId }) => {
    if (unsafeReason || typeof instanceId !== "number") {
      unsafeReason = unsafeReason ?? "unknown";
      return;
    }
    const target = state.ir.baseProgram.functions.getInstance(instanceId);
    const signature = state.ir.baseProgram.functions.getSignature(
      target.symbolRef.moduleId,
      target.symbolRef.symbol,
    );
    if (!signature) {
      unsafeReason = "unknown";
      return;
    }
    if (!state.ir.baseProgram.effects.isEmpty(signature.effectRow)) {
      unsafeReason = "effectful-call";
      return;
    }

    const parameterIndex =
      typeof state.callerInstanceId === "number"
        ? signature.parameters.findIndex((_parameter, index) => {
            const mappedArgExprId = callArgumentExprIdForParameter({
              argExprIds: callArgumentExprIds(expr),
              callInfo,
              callerInstanceId: state.callerInstanceId!,
              parameterIndex: index,
            });
            return mappedArgExprId === argExprId;
          })
        : argIndex;
    const parameter = signature.parameters[parameterIndex];
    if (!parameter || typeof parameter.symbol !== "number") {
      unsafeReason = "unknown";
      return;
    }
    traitBoundary =
      traitBoundary || isTraitType({ typeId: parameter.typeId, ir: state.ir });
    if (
      targetParameterIsMutable({
        state,
        moduleId: target.symbolRef.moduleId,
        symbol: target.symbolRef.symbol,
        parameterIndex,
        parameter,
      })
    ) {
      unsafeReason = "mutable-call-argument";
      return;
    }
    const targetFact = state.parameterFacts
      .get(instanceId)
      ?.get(parameter.symbol);
    if (!targetFact || targetFact.escapes) {
      unsafeReason = "call-boundary";
    }
  });

  return unsafeReason
    ? { reason: unsafeReason, traitBoundary }
    : { traitBoundary };
};

const analyzeEscapeExpression = ({
  exprId,
  context,
  state,
}: {
  exprId: HirExprId;
  context: EscapeUseContext;
  state: EscapeAnalysisState;
}): void => {
  const expr = state.moduleView.hir.expressions.get(exprId);
  if (!expr) {
    return;
  }

  const originFact = ensureOriginFact({ state, exprId });
  if (originFact) {
    markOriginUse({
      fact: originFact,
      exprId,
      reason: context.reason,
      traitBoundary: context.traitBoundary,
    });
  }

  switch (expr.exprKind) {
    case "literal":
    case "overload-set":
    case "continue":
      return;
    case "identifier":
      markSymbolUse({ state, symbol: expr.symbol, exprId, context });
      return;
    case "block": {
      expr.statements.forEach((statementId) =>
        analyzeEscapeStatement({ statementId, state }),
      );
      if (typeof expr.value === "number") {
        analyzeEscapeExpression({ exprId: expr.value, context, state });
      }
      return;
    }
    case "tuple":
      expr.elements.forEach((element) =>
        analyzeEscapeExpression({
          exprId: element,
          context: { reason: "stored-in-aggregate" },
          state,
        }),
      );
      return;
    case "object-literal":
      expr.entries.forEach((entry) =>
        analyzeEscapeExpression({
          exprId: entry.value,
          context: { reason: "stored-in-aggregate" },
          state,
        }),
      );
      return;
    case "field-access":
      analyzeEscapeExpression({
        exprId: expr.target,
        context: emptyEscapeUseContext,
        state,
      });
      return;
    case "assign": {
      if (typeof expr.target === "number") {
        const target = state.moduleView.hir.expressions.get(expr.target);
        if (target?.exprKind === "field-access") {
          analyzeEscapeExpression({
            exprId: target.target,
            context: emptyEscapeUseContext,
            state,
          });
        } else {
          analyzeEscapeExpression({
            exprId: expr.target,
            context: { reason: "assignment" },
            state,
          });
        }
      }
      analyzeEscapeExpression({
        exprId: expr.value,
        context: { reason: "assignment" },
        state,
      });
      return;
    }
    case "call":
    case "method-call": {
      if (expr.exprKind === "call") {
        analyzeEscapeExpression({
          exprId: expr.callee,
          context: emptyEscapeUseContext,
          state,
        });
      }
      callArgumentExprIds(expr).forEach((argExprId, argIndex) =>
        analyzeEscapeExpression({
          exprId: argExprId,
          context: contextForCallArgument({
            moduleView: state.moduleView,
            exprId,
            expr,
            argExprId,
            argIndex,
            state,
          }),
          state,
        }),
      );
      return;
    }
    case "lambda":
      markSymbolSetUse({
        state,
        symbols: expr.captures.map((capture) => capture.symbol),
        exprId,
        reason: "closure-capture",
      });
      return;
    case "effect-handler": {
      analyzeEscapeExpression({ exprId: expr.body, context, state });
      const captures = collectHandlerCaptures({
        moduleView: state.moduleView,
      }).get(expr.id);
      captures?.forEach((symbols) =>
        markSymbolSetUse({
          state,
          symbols,
          exprId: expr.id,
          reason: "effect-handler-capture",
        }),
      );
      expr.handlers.forEach((handler) => {
        if (handler.tailResumption?.escapes) {
          const fact = ensureOriginFact({ state, exprId: expr.id });
          if (fact) {
            markOriginUse({
              fact,
              exprId: expr.id,
              reason: "handler-resumption-escape",
            });
          }
        }
        analyzeEscapeExpression({
          exprId: handler.body,
          context: emptyEscapeUseContext,
          state,
        });
      });
      if (typeof expr.finallyBranch === "number") {
        analyzeEscapeExpression({
          exprId: expr.finallyBranch,
          context: emptyEscapeUseContext,
          state,
        });
      }
      return;
    }
    case "loop":
      analyzeEscapeExpression({
        exprId: expr.body,
        context: emptyEscapeUseContext,
        state,
      });
      return;
    case "while":
      analyzeEscapeExpression({
        exprId: expr.condition,
        context: emptyEscapeUseContext,
        state,
      });
      analyzeEscapeExpression({
        exprId: expr.body,
        context: emptyEscapeUseContext,
        state,
      });
      return;
    case "if":
    case "cond":
      expr.branches.forEach((branch) => {
        analyzeEscapeExpression({
          exprId: branch.condition,
          context: emptyEscapeUseContext,
          state,
        });
        analyzeEscapeExpression({ exprId: branch.value, context, state });
      });
      if (typeof expr.defaultBranch === "number") {
        analyzeEscapeExpression({ exprId: expr.defaultBranch, context, state });
      }
      return;
    case "match":
      analyzeEscapeExpression({
        exprId: expr.discriminant,
        context: emptyEscapeUseContext,
        state,
      });
      expr.arms.forEach((arm) => {
        if (typeof arm.guard === "number") {
          analyzeEscapeExpression({
            exprId: arm.guard,
            context: emptyEscapeUseContext,
            state,
          });
        }
        analyzeEscapeExpression({ exprId: arm.value, context, state });
      });
      return;
    case "break":
      if (typeof expr.value === "number") {
        analyzeEscapeExpression({
          exprId: expr.value,
          context: emptyEscapeUseContext,
          state,
        });
      }
      return;
  }
};

const analyzeEscapeStatement = ({
  statementId,
  state,
}: {
  statementId: number;
  state: EscapeAnalysisState;
}): void => {
  const statement = state.moduleView.hir.statements.get(statementId);
  if (!statement) {
    return;
  }
  if (statement.kind === "expr-stmt") {
    analyzeEscapeExpression({
      exprId: statement.expr,
      context: emptyEscapeUseContext,
      state,
    });
    return;
  }
  if (statement.kind === "return") {
    if (typeof statement.value === "number") {
      analyzeEscapeExpression({
        exprId: statement.value,
        context: { reason: "return" },
        state,
      });
    }
    return;
  }

  if (statement.pattern.kind === "identifier") {
    const boundSymbol = statement.pattern.symbol;
    analyzeEscapeExpression({
      exprId: statement.initializer,
      context: emptyEscapeUseContext,
      state,
    });

    const boundOrigins = originExprIdsForInitializer({
      state,
      exprId: statement.initializer,
    });
    boundOrigins.forEach((originExprId) => {
      bindLocalOrigin({
        state,
        symbol: boundSymbol,
        originExprId,
      });
    });
    bindLocalParameterAliases({
      state,
      symbol: boundSymbol,
      parameterSymbols: parameterAliasesForInitializer({
        state,
        exprId: statement.initializer,
      }),
    });
    return;
  }

  analyzeEscapeExpression({
    exprId: statement.initializer,
    context: emptyEscapeUseContext,
    state,
  });
};

const parameterSymbolsForFunction = (item: HirFunction): Set<SymbolId> =>
  new Set(item.parameters.map((parameter) => parameter.symbol));

const seedParameterFacts = ({
  ir,
  externalInstances,
}: {
  ir: MutableOptimizationIr;
  externalInstances: ReadonlySet<ProgramFunctionInstanceId>;
}): Map<
  ProgramFunctionInstanceId,
  Map<SymbolId, MutableEscapeParameterFact>
> => {
  const facts = new Map<
    ProgramFunctionInstanceId,
    Map<SymbolId, MutableEscapeParameterFact>
  >();
  ir.facts.reachableFunctionInstances.forEach((instanceId) => {
    const instance = ir.baseProgram.functions.getInstance(instanceId);
    const signature = ir.baseProgram.functions.getSignature(
      instance.symbolRef.moduleId,
      instance.symbolRef.symbol,
    );
    signature?.parameters.forEach((parameter) => {
      if (typeof parameter.symbol !== "number") {
        return;
      }
      const fact = mutableParameterFactFor({
        facts,
        instanceId,
        symbol: parameter.symbol,
      });
      if (externalInstances.has(instanceId)) {
        fact.escapes = true;
        fact.escapeReasons.add("public-boundary");
      }
    });
  });
  return facts;
};

const analyzeParameterEscapes = ({
  ir,
  instanceId,
  facts,
}: {
  ir: MutableOptimizationIr;
  instanceId: ProgramFunctionInstanceId;
  facts: Map<
    ProgramFunctionInstanceId,
    Map<SymbolId, MutableEscapeParameterFact>
  >;
}): void => {
  const instance = ir.baseProgram.functions.getInstance(instanceId);
  const moduleView = ir.modules.get(instance.symbolRef.moduleId);
  const item = moduleView
    ? functionItemBySymbol({
        ir,
        moduleView,
        symbol: instance.symbolRef.symbol,
      })
    : undefined;
  const mutableParameterFacts = facts.get(instanceId);
  if (!moduleView || !item || !mutableParameterFacts) {
    return;
  }
  analyzeEscapeExpression({
    exprId: item.body,
    context: { reason: "return" },
    state: {
      ir,
      moduleView,
      callerInstanceId: instanceId,
      parameterSymbols: parameterSymbolsForFunction(item),
      parameterFacts: facts,
      mutableParameterFacts,
      localOrigins: new Map(),
      localParameterAliases: new Map(),
    },
  });
};

const serializeMutableParameterFactsForInstance = (
  instanceId: ProgramFunctionInstanceId,
  bySymbol: ReadonlyMap<SymbolId, MutableEscapeParameterFact> | undefined,
): string =>
  serializeMutableParameterFacts(
    bySymbol ? new Map([[instanceId, bySymbol]]) : new Map(),
  );

const buildParameterEscapeCallers = ({
  ir,
  callSites,
}: {
  ir: MutableOptimizationIr;
  callSites: InstanceCallSiteIndex;
}): Map<ProgramFunctionInstanceId, Set<ProgramFunctionInstanceId>> => {
  const callersByTarget = new Map<
    ProgramFunctionInstanceId,
    Set<ProgramFunctionInstanceId>
  >();
  callSites.forEach((sites, callerInstanceId) => {
    sites.forEach(({ moduleView, exprId, expr }) => {
      resolveTargetsForExactPropagation({
        moduleView,
        exprId,
        expr,
        callerInstanceId,
        ir,
      }).forEach(({ instanceId: targetInstanceId }) => {
        if (typeof targetInstanceId !== "number") {
          return;
        }
        const callers = callersByTarget.get(targetInstanceId) ?? new Set();
        callers.add(callerInstanceId);
        callersByTarget.set(targetInstanceId, callers);
      });
    });
  });
  return callersByTarget;
};

const computeParameterEscapeFacts = ({
  ir,
}: {
  ir: MutableOptimizationIr;
}): {
  facts: Map<
    ProgramFunctionInstanceId,
    Map<SymbolId, MutableEscapeParameterFact>
  >;
  worklistPops: number;
  worklistRequeues: number;
} => {
  const externalInstances = externallyCallableFunctionInstances(ir);
  const facts = seedParameterFacts({ ir, externalInstances });
  const callSites = buildInstanceCallSiteIndex({ ir });
  const callersByTarget = buildParameterEscapeCallers({ ir, callSites });
  const queued = Array.from(ir.facts.reachableFunctionInstances);
  const queuedInstances = new Set(queued);
  let worklistPops = 0;
  let worklistRequeues = 0;

  const enqueue = (instanceId: ProgramFunctionInstanceId): void => {
    if (queuedInstances.has(instanceId)) {
      return;
    }
    queued.push(instanceId);
    queuedInstances.add(instanceId);
    worklistRequeues += 1;
  };

  while (queued.length > 0) {
    const instanceId = queued.pop()!;
    queuedInstances.delete(instanceId);
    worklistPops += 1;
    const before = serializeMutableParameterFactsForInstance(
      instanceId,
      facts.get(instanceId),
    );
    analyzeParameterEscapes({ ir, instanceId, facts });
    const after = serializeMutableParameterFactsForInstance(
      instanceId,
      facts.get(instanceId),
    );
    if (before === after) {
      continue;
    }
    callersByTarget
      .get(instanceId)
      ?.forEach((callerInstanceId) => enqueue(callerInstanceId));
  }

  return { facts, worklistPops, worklistRequeues };
};

const computeOriginEscapeFacts = ({
  ir,
  parameterFacts,
}: {
  ir: MutableOptimizationIr;
  parameterFacts: ReadonlyMap<
    ProgramFunctionInstanceId,
    ReadonlyMap<SymbolId, MutableEscapeParameterFact>
  >;
}): Map<string, Map<HirExprId, MutableEscapeOriginFact>> => {
  const originFacts = new Map<
    string,
    Map<HirExprId, MutableEscapeOriginFact>
  >();

  ir.facts.reachableFunctionInstances.forEach((instanceId) => {
    const instance = ir.baseProgram.functions.getInstance(instanceId);
    const moduleView = ir.modules.get(instance.symbolRef.moduleId);
    const item = moduleView
      ? functionItemBySymbol({
          ir,
          moduleView,
          symbol: instance.symbolRef.symbol,
        })
      : undefined;
    if (!moduleView || !item) {
      return;
    }
    analyzeEscapeExpression({
      exprId: item.body,
      context: { reason: "return" },
      state: {
        ir,
        moduleView,
        callerInstanceId: instanceId,
        parameterSymbols: parameterSymbolsForFunction(item),
        parameterFacts,
        mutableOriginFacts: originFacts,
        localOrigins: new Map(),
        localParameterAliases: new Map(),
      },
    });
  });

  ir.facts.reachableModuleLets.forEach((symbols, moduleId) => {
    const moduleView = ir.modules.get(moduleId);
    if (!moduleView) {
      return;
    }
    symbols.forEach((symbol) => {
      const moduleLet = moduleLetBySymbol({ ir, moduleView, symbol });
      if (!moduleLet) {
        return;
      }
      analyzeEscapeExpression({
        exprId: moduleLet.initializer,
        context: { reason: "module-let" },
        state: {
          ir,
          moduleView,
          parameterSymbols: new Set(),
          parameterFacts,
          mutableOriginFacts: originFacts,
          localOrigins: new Map(),
          localParameterAliases: new Map(),
        },
      });
    });
  });

  return originFacts;
};

const serializeOriginFacts = (
  facts: ReadonlyMap<string, ReadonlyMap<HirExprId, EscapeAnalysisOriginFact>>,
): string =>
  JSON.stringify(
    Array.from(facts.entries())
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([moduleId, byExpr]) => [
        moduleId,
        Array.from(byExpr.entries())
          .sort(([left], [right]) => left - right)
          .map(([exprId, fact]) => [
            exprId,
            fact.originKind,
            fact.typeId,
            fact.escapes,
            fact.escapeReasons,
            fact.directLocalSymbols,
            fact.useExprIds,
          ]),
      ]),
  );

const escapeAnalysisPass: ProgramOptimizationPass = {
  name: "whole-program-escape-analysis",
  run(ctx) {
    const ir = ctx.ir as MutableOptimizationIr;
    const {
      facts: parameterFacts,
      worklistPops,
      worklistRequeues,
    } = computeParameterEscapeFacts({ ir });
    const originFacts = computeOriginEscapeFacts({ ir, parameterFacts });
    const immutableParameters = toImmutableParameterFacts(parameterFacts);
    const immutableOrigins = toImmutableOriginFacts(originFacts);
    const previous = ir.facts.escapeAnalysis;
    const changed =
      serializeMutableParameterFacts(parameterFacts) !==
        JSON.stringify(
          Array.from(previous.parameters.entries())
            .sort(([left], [right]) => left - right)
            .map(([instanceId, bySymbol]) => [
              instanceId,
              Array.from(bySymbol.entries())
                .sort(([left], [right]) => left - right)
                .map(([symbol, fact]) => [
                  symbol,
                  fact.escapes,
                  fact.escapeReasons,
                  fact.useExprIds,
                ]),
            ]),
        ) ||
      serializeOriginFacts(immutableOrigins) !==
        serializeOriginFacts(previous.origins);

    ir.facts.escapeAnalysis = {
      origins: immutableOrigins,
      parameters: immutableParameters,
    };

    const originValues = Array.from(immutableOrigins.values()).flatMap(
      (byExpr) => Array.from(byExpr.values()),
    );
    const parameterValues = Array.from(immutableParameters.values()).flatMap(
      (bySymbol) => Array.from(bySymbol.values()),
    );
    const metrics: Record<string, number> = {
      escaping_origins: originValues.filter((fact) => fact.escapes).length,
      non_escaping_origins: originValues.filter((fact) => !fact.escapes).length,
      escaping_parameters: parameterValues.filter((fact) => fact.escapes)
        .length,
      non_escaping_parameters: parameterValues.filter((fact) => !fact.escapes)
        .length,
      parameter_worklist_pops: worklistPops,
      parameter_worklist_requeues: worklistRequeues,
    };
    [...originValues, ...parameterValues].forEach((fact) => {
      fact.escapeReasons.forEach((reason) => {
        const metric = `escape_reason.${reason}`;
        metrics[metric] = (metrics[metric] ?? 0) + 1;
      });
    });

    return { changed, metrics };
  },
};

type CallShapeCandidate = {
  callSiteKey: string;
  callerInstanceId: ProgramFunctionInstanceId;
  request: CallShapeSpecializationRequest;
};

const callShapeParameterState = (
  entry: NonNullable<ReturnType<typeof resolveCallArgPlan>>[number],
): CallShapeParameterState =>
  entry.kind === "missing"
    ? "omitted"
    : entry.kind === "stable-callsite-id"
      ? "stable-callsite-id"
      : "provided";

const serializeCallShapeSpecializationRequests = (
  requests: ReadonlyMap<
    string,
    ReadonlyMap<ProgramFunctionInstanceId, CallShapeSpecializationRequest>
  >,
): string =>
  JSON.stringify(
    Array.from(requests.entries())
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([callSiteKey, byCaller]) => [
        callSiteKey,
        Array.from(byCaller.entries())
          .sort(([left], [right]) => left - right)
          .map(([callerInstanceId, request]) => [
            callerInstanceId,
            request.calleeInstanceId,
            request.keyTokens,
          ]),
      ]),
  );

const collectCallShapeCandidates = ({
  ir,
}: {
  ir: MutableOptimizationIr;
}): {
  candidates: CallShapeCandidate[];
  skipped: Readonly<Record<string, number>>;
} => {
  const candidates: CallShapeCandidate[] = [];
  const skipped: Record<string, number> = {};
  const skip = (reason: string): void => {
    skipped[reason] = (skipped[reason] ?? 0) + 1;
  };

  buildInstanceCallSiteIndex({ ir }).forEach((sites, callerInstanceId) => {
    sites.forEach(({ moduleView, exprId, expr }) => {
      const callInfo = ir.calls.get(moduleView.moduleId)?.get(exprId);
      if (!callInfo || callInfo.traitDispatch) {
        skip("dynamic_or_unresolved");
        return;
      }
      const plan = resolveCallArgPlan({ callInfo, callerInstanceId });
      if (!plan) {
        skip("missing_typed_plan");
        return;
      }
      const targets = resolveTargetsForExactPropagation({
        moduleView,
        exprId,
        expr,
        callerInstanceId,
        ir,
      }).filter(
        (
          target,
        ): target is typeof target & {
          instanceId: ProgramFunctionInstanceId;
        } => typeof target.instanceId === "number",
      );
      if (targets.length !== 1) {
        skip("non_unique_target");
        return;
      }
      const target = targets[0]!;
      const targetInstance = ir.baseProgram.functions.getInstance(
        target.instanceId,
      );
      const targetItem = ir.index.getFunction(
        targetInstance.symbolRef.moduleId,
        targetInstance.symbolRef.symbol,
      )?.item;
      const signature = ir.baseProgram.functions.getSignature(
        targetInstance.symbolRef.moduleId,
        targetInstance.symbolRef.symbol,
      );
      if (
        !targetItem ||
        !signature ||
        plan.length !== targetItem.parameters.length
      ) {
        skip("unsupported_target");
        return;
      }
      if (
        ir.baseProgram.symbols.getIntrinsicFunctionFlags(
          target.functionId as ProgramSymbolId,
        ).intrinsic
      ) {
        skip("intrinsic");
        return;
      }

      const states = plan.map(callShapeParameterState);
      const valid = states.every((state, index) => {
        const parameter = targetItem.parameters[index];
        const signatureParameter = signature.parameters[index];
        if (!parameter || !signatureParameter) {
          return false;
        }
        if (
          typeof parameter.defaultValue === "number" &&
          signatureParameter.bindingKind !== undefined &&
          signatureParameter.bindingKind !== "value"
        ) {
          return false;
        }
        if (state === "provided") {
          return true;
        }
        if (state === "stable-callsite-id") {
          return (
            typeof parameter.defaultValue === "number" &&
            signatureParameter.synthetic === "stable-callsite-id"
          );
        }
        return (
          typeof parameter.defaultValue === "number" ||
          signatureParameter.optional === true
        );
      });
      if (!valid) {
        skip("invalid_plan");
        return;
      }
      const beneficial = states.some(
        (state, index) =>
          state !== "provided" ||
          typeof targetItem.parameters[index]?.defaultValue === "number",
      );
      if (!beneficial) {
        skip("identity_shape");
        return;
      }

      const keyTokens = Object.freeze(["v1", ...states]);
      candidates.push({
        callSiteKey: receiverSpecializationCallSiteKey({
          moduleId: moduleView.moduleId,
          exprId,
        }),
        callerInstanceId,
        request: Object.freeze({
          calleeInstanceId: target.instanceId,
          keyTokens,
        }),
      });
    });
  });

  return { candidates, skipped };
};

const callShapeSpecializationPlanningPass: ProgramOptimizationPass = {
  name: "call-shape-specialization-planning",
  run(ctx) {
    const ir = ctx.ir as MutableOptimizationIr;
    const { candidates, skipped } = collectCallShapeCandidates({ ir });
    const candidatesByCallee = new Map<
      ProgramFunctionInstanceId,
      Map<string, CallShapeCandidate[]>
    >();
    candidates.forEach((candidate) => {
      const byShape =
        candidatesByCallee.get(candidate.request.calleeInstanceId) ?? new Map();
      const shapeKey = candidate.request.keyTokens.join("|");
      byShape.set(shapeKey, [...(byShape.get(shapeKey) ?? []), candidate]);
      candidatesByCallee.set(candidate.request.calleeInstanceId, byShape);
    });

    const selected = new Map<
      string,
      Map<ProgramFunctionInstanceId, CallShapeSpecializationRequest>
    >();
    let uniqueShapes = 0;
    let rejectedByPlannerBudget = 0;
    candidatesByCallee.forEach((byShape) => {
      const ranked = Array.from(byShape.entries()).sort(
        ([leftKey, left], [rightKey, right]) =>
          right.length - left.length || leftKey.localeCompare(rightKey),
      );
      const admitted = ranked.slice(
        0,
        ir.facts.codegenPlan.specializationPolicy.callShapeContextsPerFunction,
      );
      uniqueShapes += admitted.length;
      rejectedByPlannerBudget += ranked.length - admitted.length;
      admitted.forEach(([, shapeCandidates]) => {
        shapeCandidates.forEach((candidate) => {
          const byCaller = selected.get(candidate.callSiteKey) ?? new Map();
          byCaller.set(candidate.callerInstanceId, candidate.request);
          selected.set(candidate.callSiteKey, byCaller);
        });
      });
    });

    const changed =
      serializeCallShapeSpecializationRequests(
        ir.facts.callShapeSpecializationRequests,
      ) !== serializeCallShapeSpecializationRequests(selected);
    ir.facts.callShapeSpecializationRequests = selected;
    return {
      changed,
      metrics: {
        candidate_calls: candidates.length,
        selected_calls: Array.from(selected.values()).reduce(
          (count, byCaller) => count + byCaller.size,
          0,
        ),
        unique_shapes: uniqueShapes,
        rejected_by_planner_budget: rejectedByPlannerBudget,
        ...Object.fromEntries(
          Object.entries(skipped).map(([reason, count]) => [
            `skipped.${reason}`,
            count,
          ]),
        ),
      },
    };
  },
};

const OPTIMIZATION_SCHEDULE = createOptimizationSchedule({
  pureCompileTimeEvaluation: pureCompileTimeEvaluationPass,
  booleanBranchSimplification: simplifyBooleanBranchPass,
  constructorKnownSimplification: constructorKnownSimplificationPass,
  effectFastPathElimination: effectFastPathEliminationPass,
  reachabilityPruning: wholeProgramSpecializationPruningPass,
  exactReceiverPropagation: exactReceiverPropagationPass,
  traitDispatchDevirtualization: traitDispatchDevirtualizationPass,
  closureEnvironmentShrinking: closureEnvironmentShrinkingPass,
  handlerEnvironmentShrinking: continuationAndHandlerEnvironmentShrinkingPass,
  runtimeTypeCheckElimination: redundantRuntimeTypeCheckEliminationPass,
  semanticCopyForwarding: semanticCopyForwardingPass,
  escapeAnalysis: escapeAnalysisPass,
  callShapeSpecialization: callShapeSpecializationPlanningPass,
});

export const optimizeProgram = ({
  program,
  modules,
  entryModuleId,
  options,
}: {
  program: ProgramCodegenView;
  modules: readonly SemanticsPipelineResult[];
  entryModuleId: string;
  options?: CodegenOptions;
}): ProgramOptimizationResult => {
  const ir = buildOptimizationIr({ program, modules, entryModuleId, options });
  const context = new MutableOptimizationContext(ir);
  void entryModuleId;
  void options;

  const initial = runOptimizationPassSequence({
    context,
    passes: OPTIMIZATION_SCHEDULE.initial,
  });
  const fixedPoint = runOptimizationPassesToFixedPoint({
    context,
    passes: OPTIMIZATION_SCHEDULE.fixedPoint,
    maxIterations: optimizationFixedPointIterationBudget({
      ir,
      minimumIterations: OPTIMIZATION_SCHEDULE.minimumFixedPointIterations,
    }),
    startOrdinal: initial.nextOrdinal,
  });
  runOptimizationPassSequence({
    context,
    passes: OPTIMIZATION_SCHEDULE.final,
    startOrdinal: fixedPoint.nextOrdinal,
  });
  recordOptimizationBodyIndexCounters(ir.index.getBodyIndexCounters());

  return finalizeOptimization({ ir });
};
