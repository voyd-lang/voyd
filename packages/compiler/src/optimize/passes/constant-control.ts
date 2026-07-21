import type {
  HirExpression,
  HirFunction,
  HirStatement,
} from "../../semantics/hir/index.js";
import { walkExpression } from "../../semantics/hir/index.js";
import type { ProgramCodegenView } from "../../semantics/codegen-view/index.js";
import type {
  HirExprId,
  ProgramFunctionId,
  ProgramFunctionInstanceId,
  ProgramSymbolId,
  SymbolId,
  TypeId,
} from "../../semantics/ids.js";
import type {
  HirTopologyMutation,
  ProgramOptimizationContext,
  ProgramOptimizationPass,
} from "../pass.js";
import type { OptimizedCallInfo, ReadonlyOptimizedModuleView } from "../ir.js";
import type { ProgramOptimizationIR } from "../ir.js";
import {
  exactNominalForType,
  exprTypeFor,
  resolveCallTypeArgs,
  exactNominalForExpr,
} from "./shared.js";

export type ConstantValue =
  | { literalKind: "i32" | "f32" | "f64"; value: number }
  | { literalKind: "i64"; value: bigint }
  | { literalKind: "boolean"; value: boolean }
  | { literalKind: "string"; value: string }
  | { literalKind: "void"; value: "" };

const replaceExpression = ({
  ctx,
  moduleView,
  exprId,
  build,
}: {
  ctx: ProgramOptimizationContext;
  moduleView: ReadonlyOptimizedModuleView;
  exprId: HirExprId;
  build: (mutation: HirTopologyMutation) => HirExpression;
}): void => {
  ctx.mutateHirTopology([moduleView.moduleId], (mutation) =>
    mutation.setExpression(moduleView.moduleId, exprId, build(mutation)),
  );
};

export const exprLiteralBoolean = (
  expr: HirExpression | undefined,
): boolean | undefined =>
  expr?.exprKind === "literal" && expr.literalKind === "boolean"
    ? expr.value === "true"
    : undefined;

export const toLiteralExpr = ({
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

export const toValueBlockExpr = ({
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

export const nextHirId = ({
  moduleView,
}: {
  moduleView: ReadonlyOptimizedModuleView;
}): number =>
  Math.max(
    moduleView.hir.module.id,
    ...moduleView.hir.items.keys(),
    ...moduleView.hir.statements.keys(),
    ...moduleView.hir.expressions.keys(),
  ) + 1;

export const toEvaluatedValueBlockExpr = ({
  original,
  moduleView,
  exprId,
  value,
  setStatement,
}: {
  original: HirExpression;
  moduleView: ReadonlyOptimizedModuleView;
  exprId: HirExprId;
  value: HirExprId;
  setStatement(statementId: number, statement: HirStatement): void;
}): HirExpression => {
  const statementId = nextHirId({ moduleView });
  setStatement(statementId, {
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

export const collectPostOrderExprIds = ({
  rootExprId,
  moduleView,
}: {
  rootExprId: HirExprId;
  moduleView: ReadonlyOptimizedModuleView;
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

export const collectModuleRootExprIds = ({
  moduleView,
}: {
  moduleView: ReadonlyOptimizedModuleView;
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

export const collectNominals = ({
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

export const I32_MIN = -(1n << 31n);

export const I64_MIN = -(1n << 63n);

export const wrapI32 = (value: bigint): number =>
  Number(BigInt.asIntN(32, value));

export const wrapI64 = (value: bigint): bigint => BigInt.asIntN(64, value);

export const normalizeI32ShiftCount = (value: bigint): bigint =>
  BigInt.asUintN(32, value) & 31n;

export const normalizeI64ShiftCount = (value: bigint): bigint =>
  BigInt.asUintN(64, value) & 63n;

export const normalizeF32 = (value: number): number => Math.fround(value);

export const constantF32Op = (
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

export const constantFloatOp = (
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

export const constantI32Op = (
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

export const constantI64Op = (
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

export const constantNumberCompareOp = (
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

export const constantI64CompareOp = (
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

export const constantBooleanOp = (
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

export const parseConstantLiteral = (
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

export const resolveCallTarget = ({
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

export const isPureHelperCandidate = ({
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

export const evaluateIntrinsic = ({
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

export const evaluateConstantExpr = ({
  exprId,
  moduleView,
  ir,
  localEnv,
  callerInstanceId,
  visited,
}: {
  exprId: HirExprId;
  moduleView: ReadonlyOptimizedModuleView;
  ir: ProgramOptimizationIR;
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

export const pureCompileTimeEvaluationPass: ProgramOptimizationPass = {
  name: "pure-compile-time-evaluation",
  run(ctx) {
    let changed = false;
    let foldedCalls = 0;

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
              ir: ctx.ir,
              localEnv: new Map(),
              visited: new Set(),
            });
            if (!constant) {
              return;
            }
            replaceExpression({
              ctx,
              moduleView,
              exprId,
              build: () => toLiteralExpr({ original: expr, constant }),
            });
            changed = true;
            foldedCalls += 1;
          },
        );
      });
    });

    return {
      changed,
      metrics: { folded_calls: foldedCalls },
    };
  },
};

export const simplifyBooleanBranchPass: ProgramOptimizationPass = {
  name: "boolean-branch-simplification",
  run(ctx) {
    let changed = false;
    let removedBranches = 0;
    let simplifiedBranches = 0;

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
                removedBranches += 1;
                continue;
              }
              if (constant === true && !sawUnknown) {
                selectedValue = branch.value;
                changed = true;
                simplifiedBranches += 1;
                break;
              }
              sawUnknown = true;
              nextBranches.push(branch);
            }

            if (typeof selectedValue === "number") {
              replaceExpression({
                ctx,
                moduleView,
                exprId,
                build: () =>
                  toValueBlockExpr({ original: expr, value: selectedValue }),
              });
              return;
            }

            if (
              nextBranches.length === 0 &&
              typeof expr.defaultBranch === "number"
            ) {
              const defaultBranch = expr.defaultBranch;
              replaceExpression({
                ctx,
                moduleView,
                exprId,
                build: () =>
                  toValueBlockExpr({
                    original: expr,
                    value: defaultBranch,
                  }),
              });
              changed = true;
              simplifiedBranches += 1;
              return;
            }

            if (nextBranches.length !== expr.branches.length) {
              replaceExpression({
                ctx,
                moduleView,
                exprId,
                build: () => ({ ...expr, branches: nextBranches }),
              });
            }
          },
        );
      });
    });

    return {
      changed,
      metrics: {
        removed_branches: removedBranches,
        simplified_branches: simplifiedBranches,
      },
    };
  },
};

export const constructorKnownSimplificationPass: ProgramOptimizationPass = {
  name: "constructor-known-simplification",
  run(ctx) {
    let changed = false;
    let simplifiedMatches = 0;

    const exactDiscriminantType = ({
      moduleView,
      expr,
      functionItem,
    }: {
      moduleView: ReadonlyOptimizedModuleView;
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
        const discriminant = moduleView.hir.expressions.get(expr.discriminant);
        const parameterIndex =
          discriminant?.exprKind === "identifier"
            ? functionItem.parameters.findIndex(
                (parameter) => parameter.symbol === discriminant.symbol,
              )
            : -1;
        const parameterType =
          parameterIndex >= 0
            ? ctx.ir.baseProgram.functions
                .getSignature(moduleView.moduleId, functionItem.symbol)
                ?.parameters[parameterIndex]?.typeId
            : undefined;
        const optionalInfo =
          typeof parameterType === "number"
            ? ctx.ir.baseProgram.optionals.getOptionalInfo(
                moduleView.moduleId,
                parameterType,
              )
            : undefined;
        const optionalSomeType = optionalInfo
          ? exactNominalForType({
              typeId: optionalInfo.someType,
              program: ctx.ir.baseProgram,
            })
          : undefined;
        const optionalNoneType = optionalInfo
          ? exactNominalForType({
              typeId: optionalInfo.noneType,
              program: ctx.ir.baseProgram,
            })
          : undefined;
        const promotedExactType =
          optionalInfo &&
          exactType !== optionalSomeType &&
          exactType !== optionalNoneType
            ? (optionalSomeType ?? exactType)
            : exactType;
        instanceTypes.add(promotedExactType);
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
      moduleView: ReadonlyOptimizedModuleView;
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

        replaceExpression({
          ctx,
          moduleView,
          exprId,
          build: (mutation) =>
            toEvaluatedValueBlockExpr({
              original: expr,
              moduleView,
              exprId: expr.discriminant,
              value: selectedArm.value,
              setStatement: (statementId, statement) =>
                mutation.setStatement(
                  moduleView.moduleId,
                  statementId,
                  statement,
                ),
            }),
        });
        changed = true;
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
      metrics: { simplified_matches: simplifiedMatches },
    };
  },
};

export const effectFastPathEliminationPass: ProgramOptimizationPass = {
  name: "effect-fast-path-elimination",
  run(ctx) {
    let changed = false;
    let eliminatedHandlers = 0;

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
        replaceExpression({
          ctx,
          moduleView,
          exprId,
          build: () => toValueBlockExpr({ original: expr, value: expr.body }),
        });
        changed = true;
        eliminatedHandlers += 1;
      });
    });

    return {
      changed,
      metrics: { eliminated_handlers: eliminatedHandlers },
    };
  },
};
