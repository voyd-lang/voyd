import type { ProgramCodegenView } from "../../semantics/codegen-view/index.js";
import type {
  HirExprId,
  ProgramFunctionId,
  ProgramFunctionInstanceId,
  ProgramSymbolId,
  SymbolId,
  TypeId,
} from "../../semantics/ids.js";
import { type ProgramOptimizationPass } from "../pass.js";
import type { OptimizedCallInfo, ReadonlyOptimizedModuleView } from "../ir.js";
import {
  exactNominalForType,
  resolveCallTypeArgs,
  exactNominalForExpr,
  functionTypeSubstitution,
} from "./shared.js";

export const traitMethodKey = ({
  traitSymbol,
  traitMethodSymbol,
}: {
  traitSymbol: ProgramSymbolId;
  traitMethodSymbol: ProgramSymbolId;
}): string => `${traitSymbol}:${traitMethodSymbol}`;

export const receiverParamNominalForTypeArgs = ({
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

export const exactReceiverTraitTarget = ({
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

export const devirtualizedCallInfo = ({
  moduleView,
  exprId,
  callInfo,
  program,
  exactParameterTypes,
}: {
  moduleView: ReadonlyOptimizedModuleView;
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

export const traitDispatchDevirtualizationPass: ProgramOptimizationPass = {
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
        ctx.mutateCallResolution((mutation) =>
          mutation.setCallInfo(moduleId, exprId, next),
        );
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
