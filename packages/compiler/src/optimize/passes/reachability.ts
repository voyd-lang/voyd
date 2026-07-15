import type { HirExpression } from "../../semantics/hir/index.js";
import type { ProgramCodegenView } from "../../semantics/codegen-view/index.js";
import type {
  HirExprId,
  ProgramFunctionId,
  ProgramFunctionInstanceId,
  ProgramSymbolId,
  SymbolId,
  TypeId,
} from "../../semantics/ids.js";
import type { CodegenOptions } from "../../codegen/context.js";
import {
  BOUNDARY_MSGPACK_CONTRACT_IDS,
  type CompilerFunctionContractId,
} from "../../compiler-contracts/index.js";
import { type ProgramOptimizationPass } from "../pass.js";
import type {
  ReadonlyOptimizedModuleView,
  ProgramOptimizationIR,
} from "../ir.js";
import { normalizeFunctionInstantiations } from "../state.js";
import {
  functionItemBySymbol,
  knownNominalsForExpr,
  resolveImportedSymbol,
  moduleLetBySymbol,
  canonicalProgramSymbolIdOf,
  resolveTargetsForCaller,
} from "./shared.js";

export const BOUNDARY_MSGPACK_DEPENDENT_INTRINSICS = new Set([
  "__retain_callback",
  "__boundary_retain_callback",
  "__render_retain_callback",
  "__boundary_value_to_msgpack",
  "__boundary_msgpack_to_value",
]);

export const resolveIntrinsicFunction = ({
  ir,
  intrinsicName,
}: {
  ir: ProgramOptimizationIR;
  intrinsicName: string;
}): { moduleId: string; symbol: SymbolId } | undefined => {
  const matched = ir.index.resolveIntrinsicFunction(intrinsicName);
  return matched
    ? { moduleId: matched.moduleId, symbol: matched.symbol }
    : undefined;
};

export const serializerForType = ({
  ir,
  typeId,
}: {
  ir: ProgramOptimizationIR;
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

export const serializerForTypes = ({
  ir,
  typeIds,
}: {
  ir: ProgramOptimizationIR;
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

export const shouldConsiderBoundaryExportForOptimization = ({
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

export const setEquals = <T>(
  left: ReadonlySet<T>,
  right: ReadonlySet<T>,
): boolean =>
  left.size === right.size &&
  Array.from(left).every((value) => right.has(value));

export const mapOfSetEquals = <K, V>(
  left: ReadonlyMap<K, ReadonlySet<V>>,
  right: ReadonlyMap<K, ReadonlySet<V>>,
): boolean =>
  left.size === right.size &&
  Array.from(left.entries()).every(([key, values]) => {
    const other = right.get(key);
    return other ? setEquals(values, other) : false;
  });

export const traitDispatchSignatureKey = ({
  traitSymbol,
  traitMethodSymbol,
}: {
  traitSymbol: ProgramSymbolId;
  traitMethodSymbol: ProgramSymbolId;
}): string => `${traitSymbol}:${traitMethodSymbol}`;

export const isPrimitiveDirectSwitchType = ({
  typeId,
  ir,
}: {
  typeId: TypeId;
  ir: ProgramOptimizationIR;
}): boolean =>
  typeId !== ir.baseProgram.primitives.void &&
  ir.baseProgram.types.getTypeDesc(typeId).kind === "primitive";

export const isPureSignature = ({
  effectRow,
  ir,
}: {
  effectRow: number;
  ir: ProgramOptimizationIR;
}): boolean => ir.baseProgram.effects.getRow(effectRow).operations.length === 0;

export const traitMethodMatches = ({
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
  ir: ProgramOptimizationIR;
}): boolean => {
  const mapping = ir.baseProgram.traits.getTraitMethodImpl(implMethod);
  const mappedTraitSymbol = mapping?.traitSymbol ?? traitMethodImpl.traitSymbol;
  const mappedTraitMethod = mapping?.traitMethodSymbol ?? traitMethod;
  return (
    mappedTraitSymbol === traitMethodImpl.traitSymbol &&
    mappedTraitMethod === traitMethodImpl.traitMethodSymbol
  );
};

export const directSwitchOmittedMethodTableImpls = ({
  moduleView,
  expr,
  callerInstanceId,
  functionId,
  traitMethodImpl,
  ir,
}: {
  moduleView: ReadonlyOptimizedModuleView;
  expr: Extract<HirExpression, { exprKind: "call" | "method-call" }>;
  callerInstanceId: ProgramFunctionInstanceId;
  functionId: ProgramFunctionId;
  traitMethodImpl: {
    traitSymbol: ProgramSymbolId;
    traitMethodSymbol: ProgramSymbolId;
  };
  ir: ProgramOptimizationIR;
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

export const traitDispatchOmittedMethodTableImpls = ({
  callerInstanceId,
  functionId,
  moduleView,
  expr,
  traitMethodImpl,
  ir,
}: {
  moduleView: ReadonlyOptimizedModuleView;
  expr: Extract<HirExpression, { exprKind: "call" | "method-call" }>;
  callerInstanceId?: ProgramFunctionInstanceId;
  functionId: ProgramFunctionId;
  traitMethodImpl: {
    traitSymbol: ProgramSymbolId;
    traitMethodSymbol: ProgramSymbolId;
  };
  ir: ProgramOptimizationIR;
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

export const wholeProgramSpecializationPruningPass: ProgramOptimizationPass = {
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
          ir: ctx.ir,
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
          ir: ctx.ir,
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
        ir: ctx.ir,
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
          ir: ctx.ir,
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
        ir: ctx.ir,
      });
      const signature = ctx.ir.baseProgram.functions.getSignature(
        resolved.moduleId,
        resolved.symbol,
      );
      return Boolean(
        signature &&
        !isPureSignature({
          effectRow: signature.effectRow,
          ir: ctx.ir,
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
        ir: ctx.ir,
      });
      const resolvedModule = ctx.ir.modules.get(resolved.moduleId);
      if (!resolvedModule) {
        return;
      }
      if (
        moduleLetBySymbol({
          ir: ctx.ir,
          moduleView: resolvedModule,
          symbol: resolved.symbol,
        })
      ) {
        enqueueModuleLet(resolved);
        return;
      }
      if (
        functionItemBySymbol({
          ir: ctx.ir,
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

      ctx.ir.index
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
              ir: ctx.ir,
            });
            resolvedTargets.forEach(({ functionId, instanceId }) => {
              const targetRef = ctx.ir.baseProgram.symbols.refOf(
                functionId as ProgramSymbolId,
              );
              reachableSymbols.add(
                canonicalProgramSymbolIdOf({
                  moduleId: targetRef.moduleId,
                  symbol: targetRef.symbol,
                  ir: ctx.ir,
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
                  ir: ctx.ir,
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
                  ir: ctx.ir,
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
              ir: ctx.ir,
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
            (module): module is ReadonlyOptimizedModuleView => Boolean(module),
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
              ir: ctx.ir,
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
            ir: ctx.ir,
          }),
        );
        const moduleView = ctx.ir.modules.get(instance.symbolRef.moduleId);
        if (!moduleView) {
          continue;
        }
        const item = functionItemBySymbol({
          ir: ctx.ir,
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
            ir: ctx.ir,
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

    ctx.mutateReachability((mutation) =>
      mutation.replaceProgramReachability({
        survivingInstances,
        functionInstantiations: nextInstantiations,
        reachableFunctionInstances: reachableInstances,
        reachableFunctionSymbols: reachableSymbols,
        reachableModuleLets,
        usedTraitDispatchSignatures,
      }),
    );

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
