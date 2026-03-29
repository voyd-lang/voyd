import binaryen from "binaryen";
import { refCast, structGetFieldValue } from "@voyd-lang/lib/binaryen-gc/index.js";
import type {
  CodegenContext,
  FunctionContext,
  FunctionMetadata,
  HirFunction,
  TypeId,
} from "./context.js";
import type {
  ProgramFunctionInstanceId,
  ProgramSymbolId,
} from "../semantics/ids.js";
import { compileExpression } from "./expressions/index.js";
import {
  allocateTempLocal,
  createStorageRefBinding,
  loadBindingValue,
  storeLocalValue,
} from "./locals.js";
import {
  loadStructuralField,
  coerceValueToType,
  storeValueIntoStorageRef,
} from "./structural.js";
import { RTT_METADATA_SLOTS } from "./rtt/index.js";
import {
  getAbiTypesForSignature,
  getInlineUnionLayout,
  getOptimizedAbiTypeForResult,
  getOptimizedAbiTypesForParam,
  getOptimizedParamAbiKind,
  getOptimizedResultAbiKind,
  getRequiredExprType,
  getSignatureSpillBoxType,
  getSignatureWasmType,
  getStructuralTypeInfo,
  shouldInlineUnionLayout,
  wasmTypeFor,
} from "./types.js";
import {
  type HirExpression,
  isPackageVisible,
  isPublicVisibility,
  type HirExportEntry,
} from "../semantics/hir/index.js";
import { diagnosticFromCode } from "../diagnostics/index.js";
import {
  isOutcomeCarrierType,
  wrapValueInOutcome,
} from "./effects/outcome-values.js";
import { effectsFacade } from "./effects/facade.js";
import { emitPureSurfaceWrapper } from "./effects/abi-wrapper.js";
import { formatTestExportName } from "../tests/exports.js";
import { isGeneratedTestId } from "../tests/prefix.js";
import { emitSerializedExportWrapper } from "./exports/serialized-abi.js";
import {
  emitExportAbiSection,
  type ExportAbiEntry,
} from "./exports/export-abi.js";
import { resolveSerializerForTypes } from "./serializer.js";
import type { EffectfulExportTarget } from "./effects/codegen-backend.js";
import { walkHirExpression } from "./hir-walk.js";
import { markDependencyFunctionReachable } from "./function-dependencies.js";
import { boxSignatureSpillValue, unboxSignatureSpillValue } from "./signature-spill.js";

const REACHABILITY_STATE = Symbol.for("voyd.codegen.reachabilityState");
const FUNCTION_METADATA_REGISTRATION_STATE = Symbol.for(
  "voyd.codegen.functionMetadataRegistrationState",
);

type ReachabilityState = {
  symbols?: Set<ProgramSymbolId>;
};

type FunctionMetadataRegistrationState = {
  active?: boolean;
};

const debugEffects = (): boolean =>
  typeof process !== "undefined" && process.env?.DEBUG_EFFECTS === "1";

const getFunctionMetas = (
  ctx: CodegenContext,
  moduleId: string,
  symbol: number,
): FunctionMetadata[] | undefined => ctx.functions.get(moduleId)?.get(symbol);

const programSymbolIdOf = (
  ctx: CodegenContext,
  moduleId: string,
  symbol: number,
) => ctx.program.symbols.idOf({ moduleId, symbol });

const canonicalProgramSymbolIdOf = (
  ctx: CodegenContext,
  moduleId: string,
  symbol: number,
) => ctx.program.symbols.canonicalIdOf(moduleId, symbol);

const symbolName = (
  ctx: CodegenContext,
  moduleId: string,
  symbol: number,
): string =>
  ctx.program.symbols.getName(programSymbolIdOf(ctx, moduleId, symbol)) ??
  `${symbol}`;

const pushFunctionMeta = (
  ctx: CodegenContext,
  moduleId: string,
  symbol: number,
  meta: FunctionMetadata,
): void => {
  const bySymbol =
    ctx.functions.get(moduleId) ?? new Map<number, FunctionMetadata[]>();
  const existing = bySymbol.get(symbol);
  if (existing) {
    existing.push(meta);
  } else {
    bySymbol.set(symbol, [meta]);
  }
  if (!ctx.functions.has(moduleId)) {
    ctx.functions.set(moduleId, bySymbol);
  }
};

const userParamOffsetFor = (meta: FunctionMetadata): number => meta.userParamOffset;
const firstUserParamIndexFor = (meta: FunctionMetadata): number =>
  meta.firstUserParamIndex;

const makeAbiValue = (
  values: readonly binaryen.ExpressionRef[],
  ctx: CodegenContext,
): binaryen.ExpressionRef => {
  if (values.length === 0) {
    return ctx.mod.nop();
  }
  if (values.length === 1) {
    return values[0]!;
  }
  return ctx.mod.tuple.make(values as binaryen.ExpressionRef[]);
};

const bindRawFunctionParameters = ({
  fn,
  meta,
  ctx,
  fnCtx,
  handlerOffset,
}: {
  fn: HirFunction;
  meta: FunctionMetadata;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
  handlerOffset: number;
}): binaryen.ExpressionRef[] => {
  const ops: binaryen.ExpressionRef[] = [];
  let abiIndex = handlerOffset;

  fn.parameters.forEach((param, index) => {
    const abiTypes = meta.paramAbiTypes[index] ?? [];
    const abiValues = abiTypes.map((abiType, abiOffset) =>
      ctx.mod.local.get(abiIndex + abiOffset, abiType),
    );
    const typeId = meta.paramTypeIds[index];
    const abiKind = meta.paramAbiKinds[index] ?? "direct";
    if (
      typeof typeId === "number" &&
      (abiKind === "readonly_ref" || abiKind === "mutable_ref")
    ) {
      fnCtx.bindings.set(
        param.symbol,
        createStorageRefBinding({
          index: abiIndex,
          typeId,
          mutable: abiKind === "mutable_ref",
          ctx,
        }),
      );
    } else {
      const localType = wasmTypeFor(typeId!, ctx);
      const binding = allocateTempLocal(
        localType,
        fnCtx,
        typeId,
        ctx,
      );
      fnCtx.bindings.set(param.symbol, {
        ...binding,
        kind: "local",
        typeId,
      });
      const paramValue =
        typeof typeId === "number" &&
        getSignatureSpillBoxType({
          typeId,
          ctx,
        }) === abiTypes[0]
          ? unboxSignatureSpillValue({
              value: abiValues[0]!,
              typeId,
              ctx,
            })
          : makeAbiValue(abiValues, ctx);
      ops.push(
        storeLocalValue({
          binding,
          value: paramValue,
          ctx,
          fnCtx,
        }),
      );
    }
    abiIndex += abiTypes.length;
  });
  return ops;
};

const compileDefaultParameterInitialization = ({
  fn,
  meta,
  ctx,
  fnCtx,
}: {
  fn: HirFunction;
  meta: FunctionMetadata;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): binaryen.ExpressionRef[] => {
  const ops: binaryen.ExpressionRef[] = [];
  const typeInstanceId = fnCtx.typeInstanceId ?? fnCtx.instanceId;

  fn.parameters.forEach((param, index) => {
    if (typeof param.defaultValue !== "number") {
      return;
    }

    const rawTypeId = meta.paramTypeIds[index];
    if (typeof rawTypeId !== "number") {
      throw new Error(
        `codegen missing default parameter metadata for symbol ${param.symbol}`,
      );
    }

    const optionalInfo = ctx.program.optionals.getOptionalInfo(
      ctx.moduleId,
      rawTypeId,
    );
    if (!optionalInfo) {
      throw new Error("default parameter must use an Optional wrapper type");
    }
    const someInfo = getStructuralTypeInfo(optionalInfo.someType, ctx);
    if (!someInfo || someInfo.fields.length !== 1) {
      throw new Error(
        "default parameter Optional Some member must contain one value field",
      );
    }
    const someField = someInfo.fields[0]!;

    const defaultCompiled = compileExpression({
      exprId: param.defaultValue,
      ctx,
      fnCtx,
      tailPosition: false,
      expectedResultTypeId: optionalInfo.innerType,
    }).expr;
    const defaultTypeId = getRequiredExprType(
      param.defaultValue,
      ctx,
      typeInstanceId,
    );
    const defaultValueExpr = coerceValueToType({
      value: defaultCompiled,
      actualType: defaultTypeId,
      targetType: optionalInfo.innerType,
      ctx,
      fnCtx,
    });

    const resolved = allocateTempLocal(
      wasmTypeFor(optionalInfo.innerType, ctx),
      fnCtx,
      optionalInfo.innerType,
      ctx,
    );
    const rawBinding = fnCtx.bindings.get(param.symbol);
    if (!rawBinding) {
      throw new Error(
        `codegen missing bound parameter for optional default symbol ${param.symbol}`,
      );
    }
    const rawParamExpr = () => loadBindingValue(rawBinding, ctx);
    const rawAbiTypes = binaryen.expandType(rawBinding.type);
    const [isSome, extractedSomeValue] = shouldInlineUnionLayout(rawTypeId, ctx)
      ? (() => {
          const layout = getInlineUnionLayout(rawTypeId, ctx);
          const someLayout = layout.members.find(
            (member) => member.typeId === optionalInfo.someType,
          );
          if (!someLayout) {
            throw new Error(
              "default parameter inline optional layout is missing Some member",
            );
          }
          const tagValue =
            rawAbiTypes.length === 1
              ? rawParamExpr()
              : ctx.mod.tuple.extract(rawParamExpr(), 0);
          const payloadValues = someLayout.abiTypes.map((_, index) =>
            rawAbiTypes.length === 1
              ? rawParamExpr()
              : ctx.mod.tuple.extract(
                  rawParamExpr(),
                  someLayout.abiStart + index,
                ),
          );
          const payload =
            payloadValues.length === 0
              ? ctx.mod.nop()
              : payloadValues.length === 1
                ? payloadValues[0]!
                : ctx.mod.tuple.make(payloadValues);
          return [
            ctx.mod.i32.eq(tagValue, ctx.mod.i32.const(someLayout.tag)),
            coerceValueToType({
              value: payload,
              actualType: optionalInfo.innerType,
              targetType: optionalInfo.innerType,
              ctx,
              fnCtx,
            }),
          ] as const;
        })()
      : (() => {
          const ancestorsExpr = () =>
            structGetFieldValue({
              mod: ctx.mod,
              fieldType: ctx.rtt.extensionHelpers.i32Array,
              fieldIndex: RTT_METADATA_SLOTS.ANCESTORS,
              exprRef: rawParamExpr(),
            });
          return [
            ctx.mod.call(
              "__extends",
              [ctx.mod.i32.const(someInfo.runtimeTypeId), ancestorsExpr()],
              binaryen.i32,
            ),
            coerceValueToType({
              value: loadStructuralField({
                structInfo: someInfo,
                field: someField,
                pointer: () => refCast(ctx.mod, rawParamExpr(), someInfo.runtimeType),
                ctx,
              }),
              actualType: someField.typeId,
              targetType: optionalInfo.innerType,
              ctx,
              fnCtx,
            }),
          ] as const;
        })();

    fnCtx.bindings.set(param.symbol, {
      ...resolved,
      kind: "local",
      typeId: optionalInfo.innerType,
    });

    ops.push(
      storeLocalValue({
        binding: resolved,
        value: ctx.mod.if(
          isSome,
          extractedSomeValue,
          defaultValueExpr,
        ),
        ctx,
        fnCtx,
      }),
    );
  });

  return ops;
};

const getModuleExportEntries = (ctx: CodegenContext): readonly HirExportEntry[] => {
  const publicExports = ctx.module.hir.module.exports.filter((entry) =>
    isPublicVisibility(entry.visibility),
  );
  const baseEntries =
    ctx.module.meta.isPackageRoot || publicExports.length > 0
      ? publicExports
      : ctx.module.hir.module.exports.filter((entry) =>
          isPackageVisible(entry.visibility),
        );
  if (!ctx.options.testMode) {
    return baseEntries;
  }
  return baseEntries.filter((entry) => {
    const name = entry.alias ?? symbolName(ctx, ctx.moduleId, entry.symbol);
    return isGeneratedTestId(name);
  });
};

const collectReachableFunctionSymbols = ({
  ctx,
  contexts,
  entryModuleId,
}: {
  ctx: CodegenContext;
  contexts: readonly CodegenContext[];
  entryModuleId: string;
}): Set<ProgramSymbolId> => {
  const byModuleId = new Map(contexts.map((candidate) => [candidate.moduleId, candidate]));
  const entryCtx = byModuleId.get(entryModuleId) ?? ctx;
  const functionItemsByModule = new Map<string, Map<number, HirFunction>>();
  contexts.forEach((candidate) => {
    const bySymbol = new Map<number, HirFunction>();
    candidate.module.hir.items.forEach((item) => {
      if (item.kind === "function") {
        bySymbol.set(item.symbol, item);
      }
    });
    functionItemsByModule.set(candidate.moduleId, bySymbol);
  });

  const reachable = new Set<ProgramSymbolId>();
  const queue: ProgramSymbolId[] = [];
  const enqueue = (symbolId: ProgramSymbolId | undefined): void => {
    if (typeof symbolId !== "number" || reachable.has(symbolId)) {
      return;
    }
    queue.push(symbolId);
  };

  const testScope = entryCtx.options.testScope ?? "all";
  const exportContexts =
    entryCtx.options.testMode && testScope === "all" ? contexts : [entryCtx];
  exportContexts.forEach((exportCtx) => {
    getModuleExportEntries(exportCtx).forEach((entry) => {
      const intrinsicMetadata = entryCtx.program.symbols.getIntrinsicFunctionFlags(
        programSymbolIdOf(exportCtx, exportCtx.moduleId, entry.symbol),
      );
      if (
        intrinsicMetadata.intrinsic &&
        intrinsicMetadata.intrinsicUsesSignature !== true
      ) {
        return;
      }
      const targetId = exportCtx.program.imports.getTarget(
        exportCtx.moduleId,
        entry.symbol,
      );
      if (typeof targetId === "number") {
        const targetRef = exportCtx.program.symbols.refOf(targetId);
        enqueue(
          exportCtx.program.symbols.canonicalIdOf(
            targetRef.moduleId,
            targetRef.symbol,
          ) as ProgramSymbolId,
        );
        return;
      }
      enqueue(
        exportCtx.program.symbols.canonicalIdOf(
          exportCtx.moduleId,
          entry.symbol,
        ) as ProgramSymbolId,
      );
    });
  });
  if (queue.length === 0) {
    entryCtx.module.hir.items.forEach((item) => {
      if (item.kind !== "function") {
        return;
      }
      const intrinsicMetadata = entryCtx.program.symbols.getIntrinsicFunctionFlags(
        programSymbolIdOf(entryCtx, entryCtx.moduleId, item.symbol),
      );
      if (
        intrinsicMetadata.intrinsic &&
        intrinsicMetadata.intrinsicUsesSignature !== true
      ) {
        return;
      }
      enqueue(
        entryCtx.program.symbols.canonicalIdOf(
          entryCtx.moduleId,
          item.symbol,
        ) as ProgramSymbolId,
      );
    });
  }

  while (queue.length > 0) {
    const symbolId = queue.pop()!;
    if (reachable.has(symbolId)) {
      continue;
    }
    reachable.add(symbolId);
    const symbolRef = ctx.program.symbols.refOf(symbolId);
    const ownerCtx = byModuleId.get(symbolRef.moduleId);
    if (!ownerCtx) {
      continue;
    }
    const item = functionItemsByModule
      .get(ownerCtx.moduleId)
      ?.get(symbolRef.symbol);
    if (!item) {
      const targetId = ownerCtx.program.imports.getTarget(
        ownerCtx.moduleId,
        symbolRef.symbol,
      );
      if (typeof targetId === "number") {
        const targetRef = ownerCtx.program.symbols.refOf(targetId);
        enqueue(
          ownerCtx.program.symbols.canonicalIdOf(
            targetRef.moduleId,
            targetRef.symbol,
          ) as ProgramSymbolId,
        );
      }
      continue;
    }
    walkFunctionReachabilityExpressions({
      item,
      ctx: ownerCtx,
      onExpr: (exprId, expr) => {
        if (expr.exprKind === "call") {
          const callInfo = ownerCtx.program.calls.getCallInfo(ownerCtx.moduleId, exprId);
          callInfo.targets?.forEach((targetId) =>
            enqueue(targetId as ProgramSymbolId),
          );
          const callee = ownerCtx.module.hir.expressions.get(expr.callee);
          if (callee?.exprKind === "identifier") {
            enqueue(
              ownerCtx.program.symbols.canonicalIdOf(
                ownerCtx.moduleId,
                callee.symbol,
              ) as ProgramSymbolId,
            );
          }
          return;
        }
        if (expr.exprKind !== "method-call") {
          return;
        }
        const callInfo = ownerCtx.program.calls.getCallInfo(ownerCtx.moduleId, exprId);
        callInfo.targets?.forEach((targetId) =>
          enqueue(targetId as ProgramSymbolId),
        );
      },
    });
  }

  return reachable;
};

const reachabilityStateOf = (ctx: CodegenContext): ReachabilityState =>
  ctx.programHelpers.getHelperState(REACHABILITY_STATE, () => ({}));

const reachabilitySetOf = (ctx: CodegenContext): Set<ProgramSymbolId> => {
  const state = reachabilityStateOf(ctx);
  if (state.symbols) {
    return state.symbols;
  }
  const symbols = new Set<ProgramSymbolId>();
  state.symbols = symbols;
  return symbols;
};

const markFunctionReachable = ({
  ctx,
  moduleId,
  symbol,
  reachable,
}: {
  ctx: CodegenContext;
  moduleId: string;
  symbol: number;
  reachable?: Set<ProgramSymbolId>;
}): void => {
  (reachable ?? reachabilitySetOf(ctx)).add(
    ctx.program.symbols.canonicalIdOf(moduleId, symbol) as ProgramSymbolId,
  );
};

const markSerializerReachable = ({
  ctx,
  serializer,
}: {
  ctx: CodegenContext;
  serializer: NonNullable<ReturnType<typeof resolveSerializerForTypes>>;
}): void => {
  markFunctionReachable({
    ctx,
    moduleId: serializer.encode.moduleId,
    symbol: serializer.encode.symbol,
  });
  markFunctionReachable({
    ctx,
    moduleId: serializer.decode.moduleId,
    symbol: serializer.decode.symbol,
  });
};

const markStringLiteralCtorReachable = ({
  ctx,
  reachable,
}: {
  ctx: CodegenContext;
  reachable: Set<ProgramSymbolId>;
}): void => {
  markDependencyFunctionReachable({
    ctx,
    dependency: "string-literal-constructor",
    reachable,
  });
};

const walkFunctionReachabilityExpressions = ({
  item,
  ctx,
  onExpr,
}: {
  item: HirFunction;
  ctx: CodegenContext;
  onExpr: (exprId: number, expr: HirExpression) => void;
}): void => {
  const expressionIds = [
    item.body,
    ...item.parameters
      .map((param) => param.defaultValue)
      .filter((exprId): exprId is number => typeof exprId === "number"),
  ];
  expressionIds.forEach((exprId) => {
    walkHirExpression({
      exprId,
      ctx,
      visitLambdaBodies: true,
      visitHandlerBodies: true,
      visitor: { onExpr },
    });
  });
};

const getReachableFunctionSymbols = ({
  ctx,
  contexts,
  entryModuleId,
}: {
  ctx: CodegenContext;
  contexts: readonly CodegenContext[];
  entryModuleId: string;
}): Set<ProgramSymbolId> => {
  const state = reachabilityStateOf(ctx);
  if (state.symbols) {
    return state.symbols;
  }
  if (ctx.optimization?.reachableFunctionSymbols) {
    const symbols = new Set(ctx.optimization.reachableFunctionSymbols);
    state.symbols = symbols;
    return symbols;
  }
  const symbols = collectReachableFunctionSymbols({ ctx, contexts, entryModuleId });
  state.symbols = symbols;
  return symbols;
};

export const prepareReachableFunctionSymbols = ({
  contexts,
  entryModuleId,
}: {
  contexts: readonly CodegenContext[];
  entryModuleId: string;
}): Set<ProgramSymbolId> => {
  const seedCtx = contexts[0];
  if (!seedCtx) {
    return new Set<ProgramSymbolId>();
  }
  const symbols = getReachableFunctionSymbols({
    ctx: seedCtx,
    contexts,
    entryModuleId,
  });
  return symbols;
};

export const registerFunctionMetadata = (ctx: CodegenContext): void => {
  const registrationState =
    ctx.programHelpers.getHelperState<FunctionMetadataRegistrationState>(
      FUNCTION_METADATA_REGISTRATION_STATE,
      () => ({ active: false }),
    );
  const previousActive = registrationState.active === true;
  registrationState.active = true;
  const effects = effectsFacade(ctx);
  const unknown = ctx.program.primitives.unknown;

  try {
    for (const [itemId, item] of ctx.module.hir.items) {
      if (item.kind !== "function") continue;
      ctx.itemsToSymbols.set(itemId, {
        moduleId: ctx.moduleId,
        symbol: item.symbol,
      });

      const intrinsicMetadata = ctx.program.symbols.getIntrinsicFunctionFlags(
        programSymbolIdOf(ctx, ctx.moduleId, item.symbol),
      );
      if (
        intrinsicMetadata.intrinsic &&
        intrinsicMetadata.intrinsicUsesSignature !== true
      ) {
        continue;
      }

      const signature = ctx.program.functions.getSignature(
        ctx.moduleId,
        item.symbol,
      );
      if (!signature) {
        throw new Error(
          `codegen missing type information for function ${item.symbol}`,
        );
      }

      const schemeInfo = ctx.program.types.getScheme(signature.scheme);
      const instantiationInfo = ctx.program.functions.getInstantiationInfo(
        ctx.moduleId,
        item.symbol,
      );
      const recordedInstantiations =
        instantiationInfo && instantiationInfo.size > 0
          ? Array.from(instantiationInfo.entries())
          : [];
      if (recordedInstantiations.length === 0 && schemeInfo.params.length > 0) {
        continue;
      }
      const instantiations: [ProgramFunctionInstanceId, readonly TypeId[]][] =
        recordedInstantiations.length > 0
          ? recordedInstantiations
          : getDefaultInstantiationArgs({
              ctx,
              symbol: item.symbol,
              params: schemeInfo.params.length,
            });

      instantiations.forEach(([instanceId, typeArgs]) => {
        if (typeArgs.some((arg) => arg === unknown)) {
          const name = symbolName(ctx, ctx.moduleId, item.symbol);
          const instanceLabel = ctx.program.functions.formatInstance(instanceId);
          throw new Error(
            `codegen cannot emit ${name} without resolved type arguments (instance ${instanceLabel})`,
          );
        }
        if (ctx.functionInstances.has(instanceId)) {
          return;
        }

        const typeId = ctx.program.types.instantiate(signature.scheme, typeArgs);
        const descriptor = ctx.program.types.getTypeDesc(typeId);
        if (descriptor.kind !== "function") {
          throw new Error(
            `codegen expected function type for symbol ${item.symbol}`,
          );
        }

        const effectInfo = effects.functionAbi(item.symbol);
        if (!effectInfo) {
          throw new Error(
            `codegen missing effect information for function ${item.symbol}`,
          );
        }
        const effectful = effectInfo.typeEffectful;
        if (effectful && debugEffects()) {
          console.log(
            `[effects] effectful ${ctx.moduleLabel}::${symbolName(ctx, ctx.moduleId, item.symbol)}`,
            {
              effectRow: effectInfo.effectRow,
              row: ctx.program.effects.getRow(effectInfo.effectRow),
              hasOps:
                ctx.program.effects.getRow(effectInfo.effectRow).operations
                  .length > 0,
            },
          );
        }

        const paramAbiKinds = descriptor.parameters.map((param, index) =>
          getOptimizedParamAbiKind({
            typeId: param.type,
            bindingKind: signature.parameters[index]?.bindingKind,
            ctx,
          }),
        );
        const paramAbiTypes = descriptor.parameters.map((param, index) =>
          getOptimizedAbiTypesForParam({
            typeId: param.type,
            bindingKind: signature.parameters[index]?.bindingKind,
            ctx,
          }),
        );
        const userParamTypes = paramAbiTypes.flat();
        const resultAbiKind =
          effectful
            ? "direct"
            : getOptimizedResultAbiKind({
                typeId: descriptor.returnType,
                ctx,
              });
        const outParamType =
          resultAbiKind === "out_ref"
            ? getOptimizedAbiTypeForResult({
                typeId: descriptor.returnType,
                ctx,
              })
            : undefined;
        const resultAbiTypes =
          resultAbiKind === "direct"
            ? getAbiTypesForSignature(descriptor.returnType, ctx)
            : [];
        const widened = ctx.effectsBackend.abi.widenSignature({
          ctx,
          effectful,
          userParamTypes: outParamType ? [outParamType, ...userParamTypes] : userParamTypes,
          userResultType:
            resultAbiKind === "out_ref"
              ? binaryen.none
              : getSignatureWasmType(descriptor.returnType, ctx),
        });

        const metadata: FunctionMetadata = {
          moduleId: ctx.moduleId,
          symbol: item.symbol,
          wasmName: makeFunctionName(item, ctx, typeArgs),
          paramTypes: widened.paramTypes,
          paramAbiTypes,
          userParamOffset: widened.userParamOffset,
          firstUserParamIndex:
            widened.userParamOffset + (outParamType ? 1 : 0),
          resultType: widened.resultType,
          resultAbiTypes,
          paramTypeIds: descriptor.parameters.map((param) => param.type),
          parameters: descriptor.parameters.map((param, index) => ({
            typeId: param.type,
            label: param.label,
            optional: param.optional,
            name:
              typeof item.parameters[index]?.symbol === "number"
                ? symbolName(ctx, ctx.moduleId, item.parameters[index]!.symbol)
                : undefined,
            bindingKind: signature.parameters[index]?.bindingKind,
          })),
          paramAbiKinds,
          resultTypeId: descriptor.returnType,
          resultAbiKind,
          outParamType,
          typeArgs,
          instanceId,
          effectful,
          effectRow: effectInfo.effectRow,
        };

        pushFunctionMeta(ctx, ctx.moduleId, item.symbol, metadata);
        ctx.functionInstances.set(instanceId, metadata);
      });
    }
  } finally {
    registrationState.active = previousActive;
  }
};

export const compileFunctions = ({
  ctx,
  contexts,
  entryModuleId,
}: {
  ctx: CodegenContext;
  contexts: readonly CodegenContext[];
  entryModuleId: string;
}): number => {
  const reachableFunctions = getReachableFunctionSymbols({
    ctx,
    contexts,
    entryModuleId,
  }) as Set<ProgramSymbolId>;
  let compiledCount = 0;
  for (const item of ctx.module.hir.items.values()) {
    if (item.kind !== "function") continue;
    const intrinsicMetadata = ctx.program.symbols.getIntrinsicFunctionFlags(
      programSymbolIdOf(ctx, ctx.moduleId, item.symbol),
    );
    if (
      intrinsicMetadata.intrinsic &&
      intrinsicMetadata.intrinsicUsesSignature !== true
    ) {
      continue;
    }
    const metas = getFunctionMetas(ctx, ctx.moduleId, item.symbol);
    if (!metas || metas.length === 0) {
      continue;
    }
    const canonicalId = ctx.program.symbols.canonicalIdOf(
      ctx.moduleId,
      item.symbol,
    ) as ProgramSymbolId;
    if (!reachableFunctions.has(canonicalId)) {
      continue;
    }
    const hasPendingMeta = metas.some((meta) => ctx.mod.getFunction(meta.wasmName) === 0);
    if (!hasPendingMeta) {
      continue;
    }
    walkFunctionReachabilityExpressions({
      item,
      ctx,
      onExpr: (exprId, expr) => {
        if (expr.exprKind === "call") {
          const callInfo = ctx.program.calls.getCallInfo(ctx.moduleId, exprId);
          callInfo.targets?.forEach((targetId) =>
            reachableFunctions.add(targetId as ProgramSymbolId),
          );
          const callee = ctx.module.hir.expressions.get(expr.callee);
          if (callee?.exprKind === "identifier") {
            reachableFunctions.add(
              ctx.program.symbols.canonicalIdOf(
                ctx.moduleId,
                callee.symbol,
              ) as ProgramSymbolId,
            );
          }
          return;
        }
        if (expr.exprKind === "literal" && expr.literalKind === "string") {
          markStringLiteralCtorReachable({ ctx, reachable: reachableFunctions });
          return;
        }
        if (expr.exprKind !== "method-call") {
          return;
        }
        const callInfo = ctx.program.calls.getCallInfo(ctx.moduleId, exprId);
        callInfo.targets?.forEach((targetId) =>
          reachableFunctions.add(targetId as ProgramSymbolId),
        );
      },
    });
    metas.forEach((meta) => {
      if (ctx.mod.getFunction(meta.wasmName) !== 0) {
        return;
      }
      compileFunctionItem(item, meta, ctx);
      compiledCount += 1;
    });
  }
  return compiledCount;
};

export const registerImportMetadata = (ctx: CodegenContext): void => {
  const effects = effectsFacade(ctx);
  ctx.module.meta.imports.forEach((imp) => {
    const targetId = ctx.program.imports.getTarget(ctx.moduleId, imp.local);
    if (!targetId) return;
    const targetRef = ctx.program.symbols.refOf(targetId);
    if (targetRef.moduleId === ctx.moduleId) return;
    const intrinsicMetadata = ctx.program.symbols.getIntrinsicFunctionFlags(
      canonicalProgramSymbolIdOf(ctx, ctx.moduleId, imp.local),
    );
    if (
      intrinsicMetadata.intrinsic &&
      intrinsicMetadata.intrinsicUsesSignature !== true
    ) {
      return;
    }

    const signature = ctx.program.functions.getSignature(
      ctx.moduleId,
      imp.local,
    );
    if (!signature) return;

    const targetMetas = getFunctionMetas(
      ctx,
      targetRef.moduleId,
      targetRef.symbol,
    );
    if (!targetMetas || targetMetas.length === 0) {
      return;
    }

    const scheme = ctx.program.types.getScheme(signature.scheme);
    const typeParamCount =
      signature.typeParams.length > 0
        ? signature.typeParams.length
        : scheme.params.length;
    const instantiationInfo = ctx.program.functions.getInstantiationInfo(
      ctx.moduleId,
      imp.local,
    );
    const recordedInstantiations =
      instantiationInfo && instantiationInfo.size > 0
        ? Array.from(instantiationInfo.entries())
        : [];
    if (recordedInstantiations.length === 0 && typeParamCount > 0) {
      return;
    }
    const instantiations: [ProgramFunctionInstanceId, readonly TypeId[]][] =
      recordedInstantiations.length > 0
        ? recordedInstantiations
        : getDefaultInstantiationArgs({ ctx, symbol: imp.local, params: 0 });

    instantiations.forEach(([instanceId, typeArgs]) => {
      const targetMeta = pickTargetMeta(targetMetas, typeArgs);
      const effectInfo = effects.functionAbi(imp.local);
      const effectful =
        targetMeta?.effectful ??
        (effectInfo ? effectInfo.typeEffectful : false);
      const instantiatedTypeId =
        typeof signature.scheme === "number"
          ? ctx.program.types.instantiate(signature.scheme, typeArgs)
          : signature.typeId;
      const instantiatedTypeDesc =
        ctx.program.types.getTypeDesc(instantiatedTypeId);
      if (instantiatedTypeDesc.kind !== "function") {
        throw new Error(
          `codegen expected function type for import ${imp.local} (type ${instantiatedTypeId})`,
        );
      }

      const paramAbiKinds = instantiatedTypeDesc.parameters.map((param, index) =>
        getOptimizedParamAbiKind({
          typeId: param.type,
          bindingKind: signature.parameters[index]?.bindingKind,
          ctx,
        }),
      );
      const paramAbiTypes = instantiatedTypeDesc.parameters.map((param, index) =>
        getOptimizedAbiTypesForParam({
          typeId: param.type,
          bindingKind: signature.parameters[index]?.bindingKind,
          ctx,
        }),
      );
      const userParamTypes = paramAbiTypes.flat();
      const resultAbiKind =
        effectful
          ? "direct"
          : getOptimizedResultAbiKind({
              typeId: instantiatedTypeDesc.returnType,
              ctx,
            });
      const outParamType =
        resultAbiKind === "out_ref"
          ? getOptimizedAbiTypeForResult({
              typeId: instantiatedTypeDesc.returnType,
              ctx,
            })
          : undefined;
      const resultAbiTypes =
        resultAbiKind === "direct"
          ? getAbiTypesForSignature(instantiatedTypeDesc.returnType, ctx)
          : [];
      const widened = ctx.effectsBackend.abi.widenSignature({
        ctx,
        effectful,
        userParamTypes: outParamType ? [outParamType, ...userParamTypes] : userParamTypes,
        userResultType:
          resultAbiKind === "out_ref"
            ? binaryen.none
            : getSignatureWasmType(instantiatedTypeDesc.returnType, ctx),
      });
      const metadata: FunctionMetadata = {
        moduleId: ctx.moduleId,
        symbol: imp.local,
        wasmName: (targetMeta ?? targetMetas[0]!).wasmName,
        paramTypes: widened.paramTypes,
        paramAbiTypes,
        userParamOffset: widened.userParamOffset,
        firstUserParamIndex:
          widened.userParamOffset + (outParamType ? 1 : 0),
        resultType: widened.resultType,
        resultAbiTypes,
        paramTypeIds: instantiatedTypeDesc.parameters.map(
          (param) => param.type,
        ),
        parameters: instantiatedTypeDesc.parameters.map((param, index) => ({
          typeId: param.type,
          label: param.label,
          optional: param.optional,
          name: signature.parameters[index]?.name,
          bindingKind: signature.parameters[index]?.bindingKind,
        })),
        paramAbiKinds,
        resultTypeId: instantiatedTypeDesc.returnType,
        resultAbiKind,
        outParamType,
        typeArgs,
        instanceId,
        effectful,
        effectRow: targetMeta?.effectRow ?? effectInfo?.effectRow,
      };
      pushFunctionMeta(ctx, ctx.moduleId, imp.local, metadata);
      if (!ctx.functionInstances.has(instanceId)) {
        ctx.functionInstances.set(instanceId, metadata);
      }
    });
  });
};

export const emitModuleExports = (
  ctx: CodegenContext,
  contexts: readonly CodegenContext[] = [ctx],
): void => {
  const effectfulExports: EffectfulExportTarget[] = [];
  const exportAbiEntries: ExportAbiEntry[] = [];

  const emitEffectfulWasmExportWrapper = ({
    ctx: exportCtx,
    meta,
    exportName,
  }: {
    ctx: CodegenContext;
    meta: FunctionMetadata;
    exportName: string;
  }): void => {
    const userParamTypes = meta.paramTypes.slice(firstUserParamIndexFor(meta)) as number[];
    const wrapperName = `${meta.wasmName}__wasm_export_${sanitizeIdentifier(exportName)}`;

    emitPureSurfaceWrapper({
      ctx: exportCtx,
      wrapperName,
      wrapperParamTypes: userParamTypes,
      wrapperResultType: wasmTypeFor(meta.resultTypeId, exportCtx),
      wrapperResultTypeId: meta.resultTypeId,
      implName: meta.wasmName,
      buildImplCallArgs: () => [
        exportCtx.effectsBackend.abi.hiddenHandlerValue(exportCtx),
        ...userParamTypes.map((type, index) =>
          exportCtx.mod.local.get(index, type),
        ),
      ],
    });
    exportCtx.mod.addFunctionExport(wrapperName, exportName);
  };

  const testScope = ctx.options.testScope ?? "all";
  const exportContexts =
    ctx.options.testMode && testScope === "all" ? contexts : [ctx];
  exportContexts.forEach((exportCtx) => {
    const exportEntries = getModuleExportEntries(exportCtx);

    exportEntries.forEach((entry) => {
      const intrinsicMetadata =
        exportCtx.program.symbols.getIntrinsicFunctionFlags(
          programSymbolIdOf(exportCtx, exportCtx.moduleId, entry.symbol),
        );
      if (
        intrinsicMetadata.intrinsic &&
        intrinsicMetadata.intrinsicUsesSignature !== true
      ) {
        return;
      }
      const metas = getFunctionMetas(
        exportCtx,
        exportCtx.moduleId,
        entry.symbol,
      );
      const meta =
        metas?.find((candidate) => candidate.typeArgs.length === 0) ??
        metas?.[0];
      if (!meta) {
        reportMissingExportedGenericInstantiation({ ctx: exportCtx, entry });
        return;
      }
      const baseExportName =
        entry.alias ?? symbolName(exportCtx, exportCtx.moduleId, entry.symbol);
      const exportName = exportCtx.options.testMode
        ? formatTestExportName({
            moduleId: exportCtx.moduleId,
            testId: baseExportName,
          })
        : baseExportName;
      if (!exportCtx.programHelpers.registerExportName(exportName)) {
        return;
      }
      if (meta.effectful) {
        emitEffectfulWasmExportWrapper({ ctx: exportCtx, meta, exportName });

        if (meta.paramTypes.length > firstUserParamIndexFor(meta)) {
          return;
        }
        const valueType = wasmTypeFor(meta.resultTypeId, exportCtx);
        const serializer = resolveSerializerForTypes(
          [meta.resultTypeId],
          exportCtx,
        );
        if (serializer) {
          markSerializerReachable({ ctx: exportCtx, serializer });
        }
        const supportedReturn =
          valueType === binaryen.none ||
          valueType === binaryen.i32 ||
          valueType === binaryen.i64 ||
          valueType === binaryen.f32 ||
          valueType === binaryen.f64 ||
          serializer?.formatId === "msgpack";
        if (!supportedReturn) {
          exportCtx.diagnostics.report(
            diagnosticFromCode({
              code: "CG0002",
              params: {
                kind: "unsupported-effectful-export-return",
                exportName,
                returnType: formatWasmType(valueType),
              },
              span: entry.span,
            }),
          );
          return;
        }
        effectfulExports.push({ meta, exportName });
        return;
      }
      let serializer: ReturnType<typeof resolveSerializerForTypes> | undefined;
      try {
        serializer = resolveSerializerForTypes(
          [...meta.paramTypeIds, meta.resultTypeId],
          exportCtx,
        );
      } catch (error) {
        exportCtx.diagnostics.report(
          diagnosticFromCode({
            code: "CG0001",
            params: {
              kind: "codegen-error",
              message: (error as Error).message,
            },
            span: entry.span,
          }),
        );
        return;
      }

      if (serializer) {
        markSerializerReachable({ ctx: exportCtx, serializer });
        try {
          emitSerializedExportWrapper({ ctx: exportCtx, meta, exportName });
          exportAbiEntries.push({
            name: exportName,
            abi: "serialized",
            formatId: serializer.formatId,
          });
        } catch (error) {
          exportCtx.diagnostics.report(
            diagnosticFromCode({
              code: "CG0001",
              params: {
                kind: "codegen-error",
                message: (error as Error).message,
              },
              span: entry.span,
            }),
          );
        }
        return;
      }

      exportCtx.mod.addFunctionExport(meta.wasmName, exportName);
      exportAbiEntries.push({ name: exportName, abi: "direct" });
    });
  });

  if (exportAbiEntries.length > 0) {
    emitExportAbiSection({ mod: ctx.mod, entries: exportAbiEntries });
  }

  if (effectfulExports.length === 0) {
    return;
  }
  ctx.effectsBackend.abi.emitHostBoundary({
    entryCtx: ctx,
    contexts,
    effectfulExports,
  });
};

/**
 * Codegen intentionally skips emitting *uninstantiated* generic functions so that
 * modules like `std` can define lots of generic helpers without forcing every
 * function into the output WASM.
 *
 * Exports are different: a WASM export requires a concrete signature. If a
 * generic function is exported but never instantiated, we fail with a diagnostic
 * rather than silently omitting the export.
 */
const reportMissingExportedGenericInstantiation = ({
  ctx,
  entry,
}: {
  ctx: CodegenContext;
  entry: HirExportEntry;
}): void => {
  const signature = ctx.program.functions.getSignature(
    ctx.moduleId,
    entry.symbol,
  );
  if (!signature) return;

  const scheme = ctx.program.types.getScheme(signature.scheme);
  if (scheme.params.length === 0) return;

  const body = ctx.program.types.getTypeDesc(scheme.body);
  if (body.kind !== "function") return;
  const functionName = symbolName(ctx, ctx.moduleId, entry.symbol);

  ctx.diagnostics.report(
    diagnosticFromCode({
      code: "CG0003",
      params: {
        kind: "exported-generic-missing-instantiation",
        functionName,
      },
      span: entry.span,
    }),
  );
};

const compileFunctionItem = (
  fn: HirFunction,
  meta: FunctionMetadata,
  ctx: CodegenContext,
): void => {
  const effectInfo = effectsFacade(ctx).functionAbi(fn.symbol);
  if (!effectInfo) {
    throw new Error(
      `codegen missing effect information for function ${fn.symbol}`,
    );
  }
  const needsWrapper =
    effectInfo.abiEffectful && effectInfo.typeEffectful === false;
  const handlerParamType = ctx.effectsBackend.abi.hiddenHandlerParamType(ctx);
  if (needsWrapper) {
    const implSignature = ctx.effectsBackend.abi.widenSignature({
      ctx,
      effectful: true,
      userParamTypes: meta.paramTypes,
      userResultType: meta.resultType,
    });
    const implName = `${meta.wasmName}__effectful_impl`;
    const implCtx: FunctionContext = {
      bindings: new Map(),
      tempLocals: new Map(),
      locals: [],
      nextLocalIndex: implSignature.paramTypes.length,
      returnTypeId: meta.resultTypeId,
      returnWasmType: ctx.effectsBackend.abi.effectfulResultType(ctx),
      returnAbiKind: meta.resultAbiKind,
      instanceId: meta.instanceId,
      typeInstanceId: meta.instanceId,
      effectful: true,
      currentHandler: { index: 0, type: handlerParamType },
    };
    if (meta.resultAbiKind === "out_ref") {
      implCtx.returnOutPointer = createStorageRefBinding({
        index: implSignature.userParamOffset,
        typeId: meta.resultTypeId,
        mutable: true,
        ctx,
      });
    }

    const paramInitOps = bindRawFunctionParameters({
      fn,
      meta,
      ctx,
      fnCtx: implCtx,
      handlerOffset:
        implSignature.userParamOffset + (meta.outParamType ? 1 : 0),
    });
    const defaultInitOps = compileDefaultParameterInitialization({
      fn,
      meta,
      ctx,
      fnCtx: implCtx,
    });

    const implBody = compileExpression({
      exprId: fn.body,
      ctx,
      fnCtx: implCtx,
      tailPosition: false,
      expectedResultTypeId: implCtx.returnTypeId,
      outResultStorageRef:
        meta.resultAbiKind === "out_ref" && implCtx.returnOutPointer
          ? ctx.mod.local.get(
              implCtx.returnOutPointer.index,
              implCtx.returnOutPointer.storageType,
            )
          : undefined,
    });
    const implBodyExpr =
      defaultInitOps.length > 0
        ? ctx.mod.block(
            null,
            [...paramInitOps, ...defaultInitOps, implBody.expr],
            binaryen.getExpressionType(implBody.expr),
          )
        : paramInitOps.length > 0
          ? ctx.mod.block(null, [...paramInitOps, implBody.expr], binaryen.getExpressionType(implBody.expr))
          : implBody.expr;

    const implFunctionBody =
      meta.resultAbiKind === "out_ref" && implCtx.returnOutPointer
        ? (binaryen.getExpressionType(implBodyExpr) === binaryen.none ||
            binaryen.getExpressionType(implBodyExpr) === binaryen.unreachable
            ? implBodyExpr
            : ctx.mod.block(
                null,
                [
                  storeValueIntoStorageRef({
                    pointer: () =>
                      ctx.mod.local.get(
                        implCtx.returnOutPointer!.index,
                        implCtx.returnOutPointer!.storageType,
                      ),
                    value: implBodyExpr,
                    typeId: meta.resultTypeId,
                    ctx,
                    fnCtx: implCtx,
                  }),
                ],
                binaryen.none,
              ))
        : implBodyExpr;
    const wrappedValueType =
      meta.resultAbiKind === "out_ref"
        ? binaryen.none
        : wasmTypeFor(meta.resultTypeId, ctx);
    const implExprType = binaryen.getExpressionType(implFunctionBody);
    const shouldWrapOutcome =
      !isOutcomeCarrierType({
        wasmType: implExprType,
        ctx,
      });
    const functionBody = shouldWrapOutcome
      ? wrapValueInOutcome({
          valueExpr: implFunctionBody,
          valueType: wrappedValueType,
          ctx,
          fnCtx: implCtx,
        })
      : implFunctionBody;

    ctx.mod.addFunction(
      implName,
      binaryen.createType(implSignature.paramTypes as number[]),
      ctx.effectsBackend.abi.effectfulResultType(ctx),
      implCtx.locals,
      functionBody,
    );

    emitPureSurfaceWrapper({
      ctx,
      wrapperName: meta.wasmName,
      wrapperParamTypes: meta.paramTypes as number[],
      wrapperResultType: meta.resultType,
      wrapperResultTypeId: meta.resultTypeId,
      wrapperStoresResultByRef: meta.resultAbiKind === "out_ref",
      implName,
      buildImplCallArgs: () => [
        ctx.effectsBackend.abi.hiddenHandlerValue(ctx),
        ...meta.paramTypes.map((type, index) =>
          ctx.mod.local.get(index, type as number),
        ),
      ],
    });
    return;
  }

  const handlerOffset = userParamOffsetFor(meta);
  const fnCtx: FunctionContext = {
    bindings: new Map(),
    tempLocals: new Map(),
    locals: [],
    nextLocalIndex: meta.paramTypes.length,
    returnTypeId: meta.resultTypeId,
    returnWasmType: meta.resultType,
    returnAbiKind: meta.resultAbiKind,
    instanceId: meta.instanceId,
    typeInstanceId: meta.instanceId,
    effectful: meta.effectful,
  };
  if (meta.effectful) {
    fnCtx.currentHandler = {
      index: 0,
      type: handlerParamType,
    };
  }
  if (meta.resultAbiKind === "out_ref") {
    fnCtx.returnOutPointer = createStorageRefBinding({
      index: handlerOffset,
      typeId: meta.resultTypeId,
      mutable: true,
      ctx,
    });
  }

  const paramInitOps = bindRawFunctionParameters({
    fn,
    meta,
    ctx,
    fnCtx,
    handlerOffset: firstUserParamIndexFor(meta),
  });
  const defaultInitOps = compileDefaultParameterInitialization({
    fn,
    meta,
    ctx,
    fnCtx,
  });

  const body = compileExpression({
    exprId: fn.body,
    ctx,
    fnCtx,
    tailPosition: !meta.effectful,
    expectedResultTypeId: fnCtx.returnTypeId,
    outResultStorageRef:
      meta.resultAbiKind === "out_ref" && fnCtx.returnOutPointer
        ? ctx.mod.local.get(
            fnCtx.returnOutPointer.index,
            fnCtx.returnOutPointer.storageType,
          )
        : undefined,
  });
  const bodyExpr =
    defaultInitOps.length > 0
      ? ctx.mod.block(
          null,
          [...paramInitOps, ...defaultInitOps, body.expr],
          binaryen.getExpressionType(body.expr),
        )
      : paramInitOps.length > 0
        ? ctx.mod.block(null, [...paramInitOps, body.expr], binaryen.getExpressionType(body.expr))
        : body.expr;
  const returnValueType = wasmTypeFor(meta.resultTypeId, ctx);
  const bodyExprType = binaryen.getExpressionType(bodyExpr);
  const shouldWrapOutcome =
    meta.effectful &&
    !isOutcomeCarrierType({
      wasmType: bodyExprType,
      ctx,
    });
  const rawFunctionBody = shouldWrapOutcome
    ? wrapValueInOutcome({
        valueExpr: bodyExpr,
        valueType: returnValueType,
        ctx,
        fnCtx,
      })
    : bodyExpr;
  const functionBody =
    meta.resultAbiKind === "out_ref" && fnCtx.returnOutPointer
      ? (binaryen.getExpressionType(rawFunctionBody) === binaryen.none ||
          binaryen.getExpressionType(rawFunctionBody) === binaryen.unreachable
          ? rawFunctionBody
          : ctx.mod.block(
              null,
              [
                storeValueIntoStorageRef({
                  pointer: () =>
                    ctx.mod.local.get(
                      fnCtx.returnOutPointer!.index,
                      fnCtx.returnOutPointer!.storageType,
                    ),
                  value: rawFunctionBody,
                  typeId: meta.resultTypeId,
                  ctx,
                  fnCtx,
                }),
              ],
              binaryen.none,
            ))
      : !meta.effectful && meta.resultTypeId !== ctx.program.primitives.void
          && binaryen.getExpressionType(rawFunctionBody) !== binaryen.none
          && binaryen.getExpressionType(rawFunctionBody) !== binaryen.unreachable
        ? boxSignatureSpillValue({
            value: rawFunctionBody,
            typeId: meta.resultTypeId,
            ctx,
            fnCtx,
          })
        : rawFunctionBody;

  ctx.mod.addFunction(
    meta.wasmName,
    binaryen.createType(meta.paramTypes as number[]),
    meta.resultType,
    fnCtx.locals,
    functionBody,
  );
};

const makeFunctionName = (
  fn: HirFunction,
  ctx: CodegenContext,
  typeArgs: readonly TypeId[],
): string => {
  const safeSymbolName = sanitizeIdentifier(
    symbolName(ctx, ctx.moduleId, fn.symbol),
  );
  const suffix =
    typeArgs.length === 0
      ? ""
      : `__inst_${sanitizeIdentifier(typeArgs.join("_"))}`;
  return `${ctx.moduleLabel}__${safeSymbolName}_${fn.symbol}${suffix}`;
};

const sanitizeIdentifier = (value: string): string =>
  value.replace(/[^a-zA-Z0-9_]/g, "_");
const formatWasmType = (valueType: binaryen.Type): string => {
  if (valueType === binaryen.none) return "none";
  if (valueType === binaryen.i32) return "i32";
  if (valueType === binaryen.i64) return "i64";
  if (valueType === binaryen.f32) return "f32";
  if (valueType === binaryen.f64) return "f64";
  if (valueType === binaryen.eqref) return "eqref";
  if (valueType === binaryen.anyref) return "anyref";
  return String(valueType);
};
const getDefaultInstantiationArgs = ({
  ctx,
  symbol,
  params,
}: {
  ctx: CodegenContext;
  symbol: number;
  params: number;
}): [ProgramFunctionInstanceId, readonly TypeId[]][] => {
  if (params !== 0) {
    throw new Error(
      "getDefaultInstantiationArgs should only be used for non-generic functions",
    );
  }
  const instanceId = ctx.program.functions.getInstanceId(
    ctx.moduleId,
    symbol,
    [],
  );
  if (instanceId === undefined) {
    throw new Error(
      `codegen missing instance id for non-generic symbol ${symbol}`,
    );
  }
  return [[instanceId, []]];
};

const pickTargetMeta = (
  metas: readonly FunctionMetadata[],
  typeArgs: readonly TypeId[],
): FunctionMetadata | undefined => {
  const exact = metas.find(
    (meta) =>
      meta.typeArgs.length === typeArgs.length &&
      meta.typeArgs.every((arg, index) => arg === typeArgs[index]),
  );
  if (exact) {
    return exact;
  }
  const byArity = metas.find(
    (meta) => meta.typeArgs.length === typeArgs.length,
  );
  return byArity ?? metas[0];
};
