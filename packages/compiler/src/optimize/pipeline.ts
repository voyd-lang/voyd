import type { HirExpression, HirFunction, HirModuleLet } from "../semantics/hir/index.js";
import { walkExpression } from "../semantics/hir/index.js";
import type {
  CallLoweringInfo,
  ModuleCodegenView,
  MonomorphizedInstanceInfo,
  ProgramCodegenView,
} from "../semantics/codegen-view/index.js";
import { buildEffectsLoweringInfo } from "../semantics/effects/analysis.js";
import { getSymbolTable } from "../semantics/_internal/symbol-table.js";
import {
  analyzeLambdaCaptures,
} from "../semantics/lowering/captures.js";
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
  type ProgramOptimizationContext,
  type ProgramOptimizationPass,
  type OptimizationAnalysisKey,
} from "./pass.js";
import type {
  OptimizedCallInfo,
  OptimizedModuleView,
  ProgramOptimizationResult,
} from "./ir.js";

type MutableOptimizationIr = {
  baseProgram: ProgramCodegenView;
  entryModuleId: string;
  modules: Map<string, OptimizedModuleView>;
  calls: Map<string, Map<HirExprId, OptimizedCallInfo>>;
  functionInstantiations: Map<
    string,
    Map<SymbolId, Map<ProgramFunctionInstanceId, readonly TypeId[]>>
  >;
  survivingInstances: MonomorphizedInstanceInfo[];
  facts: {
    handlerClauseCaptures: Map<
      string,
      Map<HirExprId, Map<number, readonly SymbolId[]>>
    >;
    reachableFunctionInstances: Set<ProgramFunctionInstanceId>;
    reachableFunctionSymbols: Set<ProgramSymbolId>;
    reachableModuleLets: Map<string, Set<SymbolId>>;
    usedTraitDispatchSignatures: Set<string>;
  };
};

type ConstantValue =
  | { literalKind: "i32" | "i64" | "f32" | "f64"; value: number }
  | { literalKind: "boolean"; value: boolean }
  | { literalKind: "string"; value: string }
  | { literalKind: "void"; value: "" };

const cloneHir = <T>(value: T): T => structuredClone(value);

const mutableExpressions = ({
  moduleView,
}: {
  moduleView: OptimizedModuleView;
}): Map<HirExprId, HirExpression> =>
  moduleView.hir.expressions as Map<HirExprId, HirExpression>;

const mutableHandlerClauseCaptures = ({
  ir,
}: {
  ir: MutableOptimizationIr;
}): Map<string, Map<HirExprId, Map<number, readonly SymbolId[]>>> =>
  ir.facts.handlerClauseCaptures as Map<
    string,
    Map<HirExprId, Map<number, readonly SymbolId[]>>
  >;

const cloneCallInfo = (callInfo: CallLoweringInfo): OptimizedCallInfo => ({
  targets: callInfo.targets ? new Map(callInfo.targets) : undefined,
  argPlans: callInfo.argPlans ? new Map(callInfo.argPlans) : undefined,
  typeArgs: callInfo.typeArgs ? new Map(callInfo.typeArgs) : undefined,
  traitDispatch: callInfo.traitDispatch,
});

const exprLiteralBoolean = (expr: HirExpression | undefined): boolean | undefined =>
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

const normalizeFunctionInstantiations = ({
  program,
}: {
  program: ProgramCodegenView;
}): Map<string, Map<SymbolId, Map<ProgramFunctionInstanceId, readonly TypeId[]>>> => {
  const byModule = new Map<
    string,
    Map<SymbolId, Map<ProgramFunctionInstanceId, readonly TypeId[]>>
  >();

  program.modules.forEach((moduleView, moduleId) => {
    const bySymbol = new Map<SymbolId, Map<ProgramFunctionInstanceId, readonly TypeId[]>>();
    moduleView.hir.items.forEach((item) => {
      if (item.kind !== "function") {
        return;
      }
      const instantiationInfo = program.functions.getInstantiationInfo(moduleId, item.symbol);
      if (!instantiationInfo) {
        return;
      }
      bySymbol.set(item.symbol, new Map(instantiationInfo));
    });
    byModule.set(moduleId, bySymbol);
  });

  return byModule;
};

const normalizeCalls = ({
  program,
}: {
  program: ProgramCodegenView;
}): Map<string, Map<HirExprId, OptimizedCallInfo>> => {
  const byModule = new Map<string, Map<HirExprId, OptimizedCallInfo>>();

  program.modules.forEach((moduleView, moduleId) => {
    const calls = new Map<HirExprId, OptimizedCallInfo>();
    moduleView.hir.expressions.forEach((expr, exprId) => {
      if (expr.exprKind !== "call" && expr.exprKind !== "method-call") {
        return;
      }
      calls.set(exprId, cloneCallInfo(program.calls.getCallInfo(moduleId, exprId)));
    });
    byModule.set(moduleId, calls);
  });

  return byModule;
};

const buildOptimizationIr = ({
  program,
  modules,
  entryModuleId,
}: {
  program: ProgramCodegenView;
  modules: readonly SemanticsPipelineResult[];
  entryModuleId: string;
}): MutableOptimizationIr => {
  const semanticsByModuleId = new Map(modules.map((module) => [module.moduleId, module] as const));
  const optimizedModules = new Map<string, OptimizedModuleView>();

  program.modules.forEach((moduleView, moduleId) => {
    const semantics = semanticsByModuleId.get(moduleId);
    if (!semantics) {
      return;
    }
    optimizedModules.set(moduleId, {
      ...moduleView,
      semantics,
      hir: cloneHir(moduleView.hir),
      effectsInfo: cloneHir(moduleView.effectsInfo),
    });
  });

  return {
    baseProgram: program,
    entryModuleId,
    modules: optimizedModules,
    calls: normalizeCalls({ program }),
    functionInstantiations: normalizeFunctionInstantiations({ program }),
    survivingInstances: [...program.instances.getAll()],
    facts: {
      handlerClauseCaptures: new Map(),
      reachableFunctionInstances: new Set(),
      reachableFunctionSymbols: new Set(),
      reachableModuleLets: new Map(),
      usedTraitDispatchSignatures: new Set(),
    },
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
      roots.push(item.body, ...item.parameters.flatMap((param) =>
        typeof param.defaultValue === "number" ? [param.defaultValue] : [],
      ));
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
  if (desc.kind === "nominal-object") {
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
  moduleView.types.getResolvedExprType(exprId) ?? moduleView.types.getExprType(exprId);

const constantNumberOp = (
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
    case "__shift_l":
      return left << right;
    case "__shift_ru":
      return left >>> right;
    case "__bit_and":
      return left & right;
    case "__bit_or":
      return left | right;
    case "__bit_xor":
      return left ^ right;
    default:
      return undefined;
  }
};

const constantCompareOp = (
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

const parseConstantLiteral = (expr: HirExpression): ConstantValue | undefined => {
  if (expr.exprKind !== "literal") {
    return undefined;
  }
  switch (expr.literalKind) {
    case "i32":
    case "i64":
    case "f32":
    case "f64": {
      const parsed = Number(expr.value);
      return Number.isFinite(parsed)
        ? { literalKind: expr.literalKind, value: parsed }
        : undefined;
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
  return callInfo.targets?.size === 1 ? callInfo.targets.values().next().value : undefined;
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
  return callInfo.typeArgs?.size === 1 ? callInfo.typeArgs.values().next().value ?? [] : [];
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
    (item): item is HirFunction => item.kind === "function" && item.symbol === symbol,
  );
};

const evaluateIntrinsic = ({
  name,
  args,
}: {
  name: string;
  args: readonly ConstantValue[];
}): ConstantValue | undefined => {
  if (args.length === 1 && name === "not" && args[0]?.literalKind === "boolean") {
    return { literalKind: "boolean", value: !args[0].value };
  }

  if (args.length === 2) {
    const [left, right] = args;
    if (
      left &&
      right &&
      left.literalKind === right.literalKind &&
      ["i32", "i64", "f32", "f64"].includes(left.literalKind)
    ) {
      const leftNumber = left.value as number;
      const rightNumber = right.value as number;
      const compare = constantCompareOp(leftNumber, rightNumber, name);
      if (typeof compare === "boolean") {
        return { literalKind: "boolean", value: compare };
      }
      const computed = constantNumberOp(leftNumber, rightNumber, name);
      if (typeof computed === "number") {
        return {
          literalKind: left.literalKind as "i32" | "i64" | "f32" | "f64",
          value: computed,
        };
      }
    }

    if (
      left?.literalKind === "boolean" &&
      right?.literalKind === "boolean"
    ) {
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
  if (
    expr.exprKind !== "call" &&
    expr.exprKind !== "method-call"
  ) {
    return undefined;
  }

  const args = (expr.exprKind === "call"
    ? expr.args
    : [{ expr: expr.target }, ...expr.args]
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
  if (intrinsicFlags.intrinsic === true && intrinsicFlags.intrinsicUsesSignature !== true) {
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

    ctx.ir.modules.forEach((moduleView) => {
      const rootExprIds = collectModuleRootExprIds({ moduleView });
      rootExprIds.forEach((rootExprId) => {
        collectPostOrderExprIds({ rootExprId, moduleView }).forEach((exprId) => {
          const expr = moduleView.hir.expressions.get(exprId);
          if (!expr || (expr.exprKind !== "call" && expr.exprKind !== "method-call")) {
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
        });
      });
    });

    return {
      changed,
      invalidates: changed
        ? (["reachable-function-instances", "handler-captures", "trait-dispatch-signatures"] as const)
        : undefined,
    };
  },
};

const simplifyBooleanBranchPass: ProgramOptimizationPass = {
  name: "boolean-branch-simplification",
  run(ctx) {
    let changed = false;

    ctx.ir.modules.forEach((moduleView) => {
      const rootExprIds = collectModuleRootExprIds({ moduleView });
      rootExprIds.forEach((rootExprId) => {
        collectPostOrderExprIds({ rootExprId, moduleView }).forEach((exprId) => {
          const expr = moduleView.hir.expressions.get(exprId);
          if (!expr || (expr.exprKind !== "if" && expr.exprKind !== "cond")) {
            return;
          }

          let sawUnknown = false;
          const nextBranches: Array<(typeof expr.branches)[number]> = [];
          let selectedValue: HirExprId | undefined;

          for (const branch of expr.branches) {
            const conditionExpr = moduleView.hir.expressions.get(branch.condition);
            const constant = exprLiteralBoolean(conditionExpr);
            if (constant === false && !sawUnknown) {
              changed = true;
              continue;
            }
            if (constant === true && !sawUnknown) {
              selectedValue = branch.value;
              changed = true;
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

          if (nextBranches.length === 0 && typeof expr.defaultBranch === "number") {
            mutableExpressions({ moduleView }).set(
              exprId,
              toValueBlockExpr({ original: expr, value: expr.defaultBranch }),
            );
            changed = true;
            return;
          }

          if (nextBranches.length !== expr.branches.length) {
            mutableExpressions({ moduleView }).set(exprId, {
              ...expr,
              branches: nextBranches,
            });
          }
        });
      });
    });

    return {
      changed,
      invalidates: changed
        ? (["reachable-function-instances", "handler-captures"] as const)
        : undefined,
    };
  },
};

const constructorKnownSimplificationPass: ProgramOptimizationPass = {
  name: "constructor-known-simplification",
  run(ctx) {
    let changed = false;

    ctx.ir.modules.forEach((moduleView) => {
      const rootExprIds = collectModuleRootExprIds({ moduleView });
      rootExprIds.forEach((rootExprId) => {
        collectPostOrderExprIds({ rootExprId, moduleView }).forEach((exprId) => {
          const expr = moduleView.hir.expressions.get(exprId);
          if (!expr || expr.exprKind !== "match") {
            return;
          }

          const discriminantType = exactNominalForType({
            typeId: exprTypeFor({ moduleView, exprId: expr.discriminant }),
            program: ctx.ir.baseProgram,
          });
          if (typeof discriminantType !== "number") {
            return;
          }

          const selectedArm = expr.arms.find((arm) => {
            if (
              arm.pattern.kind === "type" &&
              arm.pattern.binding
            ) {
              return false;
            }
            if (arm.pattern.kind !== "wildcard" && arm.pattern.kind !== "type") {
              return false;
            }
            if (arm.pattern.kind === "wildcard") {
              return true;
            }
            const patternTypeId =
              typeof arm.pattern.typeId === "number" ? arm.pattern.typeId : undefined;
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
            toValueBlockExpr({ original: expr, value: selectedArm.value }),
          );
          changed = true;
        });
      });
    });

    return {
      changed,
      invalidates: changed
        ? (["reachable-function-instances", "handler-captures"] as const)
        : undefined,
    };
  },
};

const effectFastPathEliminationPass: ProgramOptimizationPass = {
  name: "effect-fast-path-elimination",
  run(ctx) {
    let changed = false;

    ctx.ir.modules.forEach((moduleView) => {
      moduleView.hir.expressions.forEach((expr, exprId) => {
        if (expr.exprKind !== "effect-handler" || typeof expr.finallyBranch === "number") {
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
            .map((clause) => moduleView.effectsInfo.operations.get(clause.operation)?.name)
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
      });
    });

    return {
      changed,
      invalidates: changed
        ? (["reachable-function-instances", "handler-captures", "trait-dispatch-signatures"] as const)
        : undefined,
    };
  },
};

const devirtualizedCallInfo = ({
  moduleView,
  exprId,
  callInfo,
  program,
}: {
  moduleView: OptimizedModuleView;
  exprId: HirExprId;
  callInfo: OptimizedCallInfo;
  program: ProgramCodegenView;
}): OptimizedCallInfo | undefined => {
  if (!callInfo.traitDispatch || !callInfo.targets || callInfo.targets.size === 0) {
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
  const uniqueTargets = new Set(callInfo.targets.values());
  if (uniqueTargets.size !== 1) {
    return undefined;
  }
  const hasConcreteReceiver = Array.from(callInfo.targets.keys()).every((callerInstanceId) => {
    const receiverType =
      program.functions.getInstanceExprType(callerInstanceId, receiverExprId) ??
      exprTypeFor({ moduleView, exprId: receiverExprId });
    return typeof exactNominalForType({ typeId: receiverType, program }) === "number";
  });
  if (!hasConcreteReceiver) {
    return undefined;
  }
  const target = uniqueTargets.values().next().value;
  if (typeof target !== "number") {
    return undefined;
  }
  const traitMethodImpl = program.traits.getTraitMethodImpl(target as ProgramSymbolId);
  if (!traitMethodImpl) {
    return undefined;
  }
  return {
    ...callInfo,
    traitDispatch: false,
  };
};

const traitDispatchDevirtualizationPass: ProgramOptimizationPass = {
  name: "trait-dispatch-devirtualization",
  run(ctx) {
    let changed = false;

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
        });
        if (!next) {
          return;
        }
        (callsByExpr as Map<HirExprId, OptimizedCallInfo>).set(exprId, next);
        changed = true;
      });
    });

    return {
      changed,
      invalidates: changed
        ? (["reachable-function-instances", "trait-dispatch-signatures"] as const)
        : undefined,
    };
  },
};

const closureEnvironmentShrinkingPass: ProgramOptimizationPass = {
  name: "closure-environment-shrinking",
  run(ctx) {
    let changed = false;

    ctx.ir.modules.forEach((moduleView) => {
      const before = Array.from(moduleView.hir.expressions.values())
        .filter((expr): expr is Extract<HirExpression, { exprKind: "lambda" }> => expr.exprKind === "lambda")
        .map((expr) => `${expr.id}:${expr.captures.map((capture) => capture.symbol).join(",")}`)
        .join("|");

      analyzeLambdaCaptures({
        hir: moduleView.hir,
        symbolTable: getSymbolTable(moduleView.semantics),
        scopeByNode: moduleView.semantics.binding.scopeByNode,
      });

      const after = Array.from(moduleView.hir.expressions.values())
        .filter((expr): expr is Extract<HirExpression, { exprKind: "lambda" }> => expr.exprKind === "lambda")
        .map((expr) => `${expr.id}:${expr.captures.map((capture) => capture.symbol).join(",")}`)
        .join("|");
      if (before !== after) {
        changed = true;
      }
    });

    return {
      changed,
      invalidates: changed ? (["handler-captures"] as const) : undefined,
    };
  },
};

const collectHandlerCaptures = ({
  moduleView,
}: {
  moduleView: OptimizedModuleView;
}): Map<HirExprId, Map<number, readonly SymbolId[]>> => {
  const handlerCaptures = new Map<HirExprId, Map<number, readonly SymbolId[]>>();
  const symbolTable = getSymbolTable(moduleView.semantics);

  moduleView.hir.expressions.forEach((expr) => {
    if (expr.exprKind !== "effect-handler") {
      return;
    }
    const clauseCaptures = new Map<number, readonly SymbolId[]>();
    expr.handlers.forEach((clause, clauseIndex) => {
      const clauseParams = new Set(clause.parameters.map((parameter) => parameter.symbol));
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
          const metadata = (symbolRecord.metadata ?? {}) as { import?: unknown };
          if (metadata.import) {
            return;
          }
          if (symbolRecord.scope === symbolTable.rootScope) {
            return;
          }
          captures.add(nestedExpr.symbol);
        },
      });
      clauseCaptures.set(clauseIndex, [...captures].sort((a, b) => a - b));
    });
    handlerCaptures.set(expr.id, clauseCaptures);
  });

  return handlerCaptures;
};

const continuationAndHandlerEnvironmentShrinkingPass: ProgramOptimizationPass = {
  name: "continuation-handler-environment-shrinking",
  run(ctx) {
    let changed = false;

    ctx.ir.modules.forEach((moduleView, moduleId) => {
      const captures = collectHandlerCaptures({
        moduleView,
      });
      const existing = ctx.ir.facts.handlerClauseCaptures.get(moduleId);
      const serialize = (
        value?:
          | ReadonlyMap<HirExprId, ReadonlyMap<number, readonly SymbolId[]>>
          | Map<HirExprId, Map<number, readonly SymbolId[]>>
      ) =>
        JSON.stringify(
          Array.from(value?.entries() ?? []).map(([exprId, clauses]) => [
            exprId,
            Array.from(clauses.entries()),
          ]),
        );
      if (serialize(existing) !== serialize(captures)) {
        mutableHandlerClauseCaptures({ ir: ctx.ir as MutableOptimizationIr }).set(
          moduleId,
          captures,
        );
        changed = true;
      }
    });

    return { changed };
  },
};

const functionItemBySymbol = ({
  moduleView,
  symbol,
}: {
  moduleView: OptimizedModuleView;
  symbol: SymbolId;
}): HirFunction | undefined =>
  Array.from(moduleView.hir.items.values()).find(
    (item): item is HirFunction => item.kind === "function" && item.symbol === symbol,
  );

const moduleLetItems = ({
  moduleView,
}: {
  moduleView: OptimizedModuleView;
}): readonly HirModuleLet[] =>
  Array.from(moduleView.hir.items.values()).filter(
    (item): item is HirModuleLet => item.kind === "module-let",
  );

const resolveImportedSymbol = ({
  moduleId,
  symbol,
  ir,
}: {
  moduleId: string;
  symbol: SymbolId;
  ir: MutableOptimizationIr;
}): { moduleId: string; symbol: SymbolId } => {
  const seen = new Set<string>();
  let currentModuleId = moduleId;
  let currentSymbol = symbol;

  while (true) {
    const key = `${currentModuleId}:${currentSymbol}`;
    if (seen.has(key)) {
      return { moduleId: currentModuleId, symbol: currentSymbol };
    }
    seen.add(key);

    const currentModule = ir.modules.get(currentModuleId);
    if (!currentModule) {
      return { moduleId: currentModuleId, symbol: currentSymbol };
    }
    const importMeta = currentModule.meta.imports.find(
      (entry) => entry.local === currentSymbol,
    );
    if (!importMeta) {
      return { moduleId: currentModuleId, symbol: currentSymbol };
    }
    const targetId = ir.baseProgram.imports.getTarget(currentModuleId, currentSymbol);
    if (typeof targetId !== "number") {
      return { moduleId: currentModuleId, symbol: currentSymbol };
    }
    const targetRef = ir.baseProgram.symbols.refOf(targetId);
    currentModuleId = targetRef.moduleId;
    currentSymbol = targetRef.symbol;
  }
};

const moduleLetBySymbol = ({
  moduleView,
  symbol,
}: {
  moduleView: OptimizedModuleView;
  symbol: SymbolId;
}): HirModuleLet | undefined =>
  moduleLetItems({ moduleView }).find((item) => item.symbol === symbol);

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

const setEquals = <T>(left: ReadonlySet<T>, right: ReadonlySet<T>): boolean =>
  left.size === right.size && Array.from(left).every((value) => right.has(value));

const mapOfSetEquals = <K, V>(
  left: ReadonlyMap<K, ReadonlySet<V>>,
  right: ReadonlyMap<K, ReadonlySet<V>>,
): boolean =>
  left.size === right.size &&
  Array.from(left.entries()).every(([key, values]) => {
    const other = right.get(key);
    return other ? setEquals(values, other) : false;
  });

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
}): readonly { functionId: ProgramFunctionId; instanceId?: ProgramFunctionInstanceId }[] => {
  const callInfo = ir.calls.get(moduleId)?.get(exprId);
  if (!callInfo) {
    return [];
  }
  const exactTarget =
    typeof callerInstanceId === "number" ? callInfo.targets?.get(callerInstanceId) : undefined;
  const exactTypeArgs =
    typeof callerInstanceId === "number" ? callInfo.typeArgs?.get(callerInstanceId) : undefined;
  const candidateEntries =
    typeof exactTarget === "number"
      ? [{ functionId: exactTarget, typeArgs: exactTypeArgs ?? [] }]
      : callInfo.targets
        ? Array.from(callInfo.targets.entries()).map(([targetCallerInstanceId, functionId]) => ({
            functionId,
            typeArgs: callInfo.typeArgs?.get(targetCallerInstanceId) ?? [],
          }))
        : [];

  return Array.from(
    new Map(
      candidateEntries.map((entry) => {
        const ref = ir.baseProgram.symbols.refOf(entry.functionId as ProgramSymbolId);
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
    const queuedModuleLets: { moduleId: string; symbol: SymbolId }[] = [];

    const enqueueInstance = (instanceId: ProgramFunctionInstanceId | undefined): void => {
      if (typeof instanceId !== "number" || reachableInstances.has(instanceId)) {
        return;
      }
      queuedInstances.push(instanceId);
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
      if (
        queuedModuleLets.some(
          (entry) => entry.moduleId === moduleId && entry.symbol === symbol,
        )
      ) {
        return;
      }
      queuedModuleLets.push({ moduleId, symbol });
    };

    const enqueueKnownFunctionInstances = ({
      moduleId,
      symbol,
    }: {
      moduleId: string;
      symbol: SymbolId;
    }): void => {
      reachableSymbols.add(canonicalProgramSymbolIdOf({ moduleId, symbol, ir: ctx.ir as MutableOptimizationIr }));
      const knownInstances =
        ctx.ir.functionInstantiations.get(moduleId)?.get(symbol);
      if (knownInstances && knownInstances.size > 0) {
        knownInstances.forEach((_, instanceId) => enqueueInstance(instanceId));
        return;
      }
      enqueueInstance(
        ctx.ir.baseProgram.functions.getInstanceId(moduleId, symbol, []),
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
      if (moduleLetBySymbol({ moduleView: resolvedModule, symbol: resolved.symbol })) {
        enqueueModuleLet(resolved);
        return;
      }
      if (functionItemBySymbol({ moduleView: resolvedModule, symbol: resolved.symbol })) {
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

      collectPostOrderExprIds({ rootExprId, moduleView }).forEach((exprId) => {
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
            const traitMethodImpl = ctx.ir.baseProgram.traits.getTraitMethodImpl(
              functionId as ProgramSymbolId,
            );
            if (!traitMethodImpl) {
              return;
            }
            usedTraitDispatchSignatures.add(
              `${traitMethodImpl.traitSymbol}:${traitMethodImpl.traitMethodSymbol}`,
            );
          });

          if (expr.exprKind === "call") {
            const callee = moduleView.hir.expressions.get(expr.callee);
            if (callee?.exprKind === "identifier") {
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
      });
    };

    const entryModule = ctx.ir.modules.get(ctx.ir.entryModuleId);
    if (entryModule) {
      entryModule.hir.module.exports.forEach((entry) => {
        recordResolvedSymbolReachability({
          moduleId: entryModule.moduleId,
          symbol: entry.symbol,
        });
      });

      if (queuedInstances.length === 0 && queuedModuleLets.length === 0) {
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
    }

    while (queuedInstances.length > 0 || queuedModuleLets.length > 0) {
      const instanceId = queuedInstances.pop();
      if (typeof instanceId === "number") {
        if (reachableInstances.has(instanceId)) {
          continue;
        }
        reachableInstances.add(instanceId);
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
          moduleView,
          symbol: instance.symbolRef.symbol,
        });
        if (!item) {
          continue;
        }

        const walkRoots = [item.body, ...item.parameters.flatMap((parameter) =>
          typeof parameter.defaultValue === "number" ? [parameter.defaultValue] : [],
        )];
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

    ctx.ir.baseProgram.instances.getAll().forEach((instance) => {
      const info = ctx.ir.baseProgram.functions.getInstance(instance.instanceId);
      const traitMethodImpl = ctx.ir.baseProgram.traits.getTraitMethodImpl(
        info.functionId as ProgramSymbolId,
      );
      if (!traitMethodImpl) {
        return;
      }
      const key = `${traitMethodImpl.traitSymbol}:${traitMethodImpl.traitMethodSymbol}`;
      if (usedTraitDispatchSignatures.has(key)) {
        reachableInstances.add(instance.instanceId);
      }
    });

    const survivingInstances = ctx.ir.baseProgram.instances
      .getAll()
      .filter((instance) => reachableInstances.has(instance.instanceId));

    const nextInstantiations = new Map<
      string,
      Map<SymbolId, Map<ProgramFunctionInstanceId, readonly TypeId[]>>
    >();
    ctx.ir.functionInstantiations.forEach((bySymbol, moduleId) => {
      const nextBySymbol = new Map<SymbolId, Map<ProgramFunctionInstanceId, readonly TypeId[]>>();
      bySymbol.forEach((instantiations, symbol) => {
        const nextInstances = new Map<ProgramFunctionInstanceId, readonly TypeId[]>();
        instantiations.forEach((typeArgs, instanceId) => {
          if (reachableInstances.has(instanceId)) {
            nextInstances.set(instanceId, typeArgs);
          }
        });
        nextBySymbol.set(symbol, nextInstances);
      });
      nextInstantiations.set(moduleId, nextBySymbol);
    });

    const changed =
      survivingInstances.length !== ctx.ir.survivingInstances.length ||
      Array.from(reachableInstances).some(
        (instanceId) =>
          !ctx.ir.survivingInstances.some((instance) => instance.instanceId === instanceId),
      ) ||
      !setEquals(reachableInstances, ctx.ir.facts.reachableFunctionInstances) ||
      !setEquals(reachableSymbols, ctx.ir.facts.reachableFunctionSymbols) ||
      !mapOfSetEquals(reachableModuleLets, ctx.ir.facts.reachableModuleLets);

    (ctx.ir as MutableOptimizationIr).survivingInstances = survivingInstances;
    (ctx.ir as MutableOptimizationIr).functionInstantiations = nextInstantiations;
    ctx.ir.facts.reachableFunctionInstances = reachableInstances;
    ctx.ir.facts.reachableFunctionSymbols = reachableSymbols;
    ctx.ir.facts.reachableModuleLets = reachableModuleLets;
    ctx.ir.facts.usedTraitDispatchSignatures = usedTraitDispatchSignatures;

    return { changed };
  },
};

const rebuildEffectsInfo = ({
  moduleView,
}: {
  moduleView: OptimizedModuleView;
}): void => {
  moduleView.effectsInfo = buildEffectsLoweringInfo({
    binding: moduleView.semantics.binding,
    symbolTable: getSymbolTable(moduleView.semantics),
    hir: moduleView.hir,
    typing: moduleView.semantics.typing,
  });
};

class OptimizationContextImpl implements ProgramOptimizationContext {
  readonly analyses = new Map<OptimizationAnalysisKey, unknown>();

  constructor(readonly ir: MutableOptimizationIr) {}

  getAnalysis<T>(key: OptimizationAnalysisKey, build: () => T): T {
    if (this.analyses.has(key)) {
      return this.analyses.get(key) as T;
    }
    const analysis = build();
    this.analyses.set(key, analysis);
    return analysis;
  }

  invalidateAnalyses(keys: readonly OptimizationAnalysisKey[]): void {
    keys.forEach((key) => this.analyses.delete(key));
  }
}

const finalizeOptimization = ({
  ir,
}: {
  ir: MutableOptimizationIr;
}): ProgramOptimizationResult => {
  ir.modules.forEach((moduleView) => rebuildEffectsInfo({ moduleView }));

  const optimizedProgram: ProgramCodegenView = {
    ...ir.baseProgram,
    calls: {
      getCallInfo: (moduleId, exprId) =>
        ir.calls.get(moduleId)?.get(exprId) ??
        ir.baseProgram.calls.getCallInfo(moduleId, exprId),
    },
    functions: {
      ...ir.baseProgram.functions,
      getInstantiationInfo: (moduleId, symbol) =>
        ir.functionInstantiations.get(moduleId)?.get(symbol) ??
        ir.baseProgram.functions.getInstantiationInfo(moduleId, symbol),
    },
    instances: {
      getAll: () => ir.survivingInstances,
      getById: (instanceId) =>
        ir.survivingInstances.find((instance) => instance.instanceId === instanceId),
    },
    modules: new Map(
      Array.from(ir.modules.entries()).map(([moduleId, moduleView]) => {
        const { semantics, ...rest } = moduleView;
        void semantics;
        return [moduleId, rest];
      }),
    ),
  };

  return {
    program: optimizedProgram,
    facts: {
      handlerClauseCaptures: new Map(
        Array.from(ir.facts.handlerClauseCaptures.entries()).map(([moduleId, byHandler]) => [
          moduleId,
          new Map(
            Array.from(byHandler.entries()).map(([handlerExprId, byClause]) => [
              handlerExprId,
              new Map(byClause),
            ]),
          ),
        ]),
      ),
      reachableFunctionInstances: new Set(ir.facts.reachableFunctionInstances),
      reachableFunctionSymbols: new Set(ir.facts.reachableFunctionSymbols),
      reachableModuleLets: new Map(
        Array.from(ir.facts.reachableModuleLets.entries()).map(([moduleId, symbols]) => [
          moduleId,
          new Set(symbols),
        ]),
      ),
      usedTraitDispatchSignatures: new Set(ir.facts.usedTraitDispatchSignatures),
    },
  };
};

const OPTIMIZATION_PASSES: readonly ProgramOptimizationPass[] = [
  pureCompileTimeEvaluationPass,
  simplifyBooleanBranchPass,
  constructorKnownSimplificationPass,
  effectFastPathEliminationPass,
  closureEnvironmentShrinkingPass,
  traitDispatchDevirtualizationPass,
  continuationAndHandlerEnvironmentShrinkingPass,
  wholeProgramSpecializationPruningPass,
];

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
  const ir = buildOptimizationIr({ program, modules, entryModuleId });
  const context = new OptimizationContextImpl(ir);
  void entryModuleId;
  void options;

  OPTIMIZATION_PASSES.forEach((pass) => {
    const result = pass.run(context);
    if (result.invalidates?.length) {
      context.invalidateAnalyses(result.invalidates);
    }
  });

  return finalizeOptimization({ ir });
};
