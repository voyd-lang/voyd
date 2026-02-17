import binaryen from "binaryen";
import type {
  CodegenContext,
  FunctionContext,
  FunctionMetadata,
  HirFunction,
  TypeId,
} from "./context.js";
import type { ProgramFunctionInstanceId } from "../semantics/ids.js";
import { compileExpression } from "./expressions/index.js";
import { wasmTypeFor } from "./types.js";
import {
  isPackageVisible,
  isPublicVisibility,
  type HirExportEntry,
} from "../semantics/hir/index.js";
import { diagnosticFromCode } from "../diagnostics/index.js";
import { wrapValueInOutcome } from "./effects/outcome-values.js";
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

const userParamOffsetFor = (meta: FunctionMetadata): number =>
  meta.effectful ? Math.max(0, meta.paramTypes.length - meta.paramTypeIds.length) : 0;

export const registerFunctionMetadata = (ctx: CodegenContext): void => {
  const effects = effectsFacade(ctx);
  const unknown = ctx.program.primitives.unknown;

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

      const userParamTypes = descriptor.parameters.map((param) =>
        wasmTypeFor(param.type, ctx, new Set(), "signature"),
      );
      const widened = ctx.effectsBackend.abi.widenSignature({
        ctx,
        effectful,
        userParamTypes,
        userResultType: wasmTypeFor(descriptor.returnType, ctx, new Set(), "signature"),
      });

      const metadata: FunctionMetadata = {
        moduleId: ctx.moduleId,
        symbol: item.symbol,
        wasmName: makeFunctionName(item, ctx, typeArgs),
        paramTypes: widened.paramTypes,
        resultType: widened.resultType,
        paramTypeIds: descriptor.parameters.map((param) => param.type),
        parameters: descriptor.parameters.map((param, index) => ({
          typeId: param.type,
          label: param.label,
          optional: param.optional,
          name:
            typeof item.parameters[index]?.symbol === "number"
              ? symbolName(ctx, ctx.moduleId, item.parameters[index]!.symbol)
              : undefined,
        })),
        resultTypeId: descriptor.returnType,
        typeArgs,
        instanceId,
        effectful,
        effectRow: effectInfo.effectRow,
      };

      pushFunctionMeta(ctx, ctx.moduleId, item.symbol, metadata);
      ctx.functionInstances.set(instanceId, metadata);
    });
  }
};

export const compileFunctions = (ctx: CodegenContext): void => {
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
      const signature = ctx.program.functions.getSignature(
        ctx.moduleId,
        item.symbol,
      );
      const scheme = signature
        ? ctx.program.types.getScheme(signature.scheme)
        : undefined;
      const instantiationInfo = ctx.program.functions.getInstantiationInfo(
        ctx.moduleId,
        item.symbol,
      );
      const hasInstantiations = Boolean(
        instantiationInfo && instantiationInfo.size > 0,
      );
      if (scheme && scheme.params.length > 0 && !hasInstantiations) {
        continue;
      }
      throw new Error(`codegen missing metadata for function ${item.symbol}`);
    }
    metas.forEach((meta) => compileFunctionItem(item, meta, ctx));
  }
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

      const userParamTypes = instantiatedTypeDesc.parameters.map((param) =>
        wasmTypeFor(param.type, ctx, new Set(), "signature"),
      );
      const widened = ctx.effectsBackend.abi.widenSignature({
        ctx,
        effectful,
        userParamTypes,
        userResultType: wasmTypeFor(
          instantiatedTypeDesc.returnType,
          ctx,
          new Set(),
          "signature",
        ),
      });
      const metadata: FunctionMetadata = {
        moduleId: ctx.moduleId,
        symbol: imp.local,
        wasmName: (targetMeta ?? targetMetas[0]!).wasmName,
        paramTypes: widened.paramTypes,
        resultType: widened.resultType,
        paramTypeIds: instantiatedTypeDesc.parameters.map(
          (param) => param.type,
        ),
        parameters: instantiatedTypeDesc.parameters.map((param, index) => ({
          typeId: param.type,
          label: param.label,
          optional: param.optional,
          name: signature.parameters[index]?.name,
        })),
        resultTypeId: instantiatedTypeDesc.returnType,
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
    const userParamOffset = userParamOffsetFor(meta);
    const userParamTypes = meta.paramTypes.slice(userParamOffset) as number[];
    const wrapperName = `${meta.wasmName}__wasm_export_${sanitizeIdentifier(exportName)}`;

    emitPureSurfaceWrapper({
      ctx: exportCtx,
      wrapperName,
      wrapperParamTypes: userParamTypes,
      wrapperResultType: wasmTypeFor(meta.resultTypeId, exportCtx),
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
    const publicExports = exportCtx.module.hir.module.exports.filter((entry) =>
      isPublicVisibility(entry.visibility),
    );
    const baseEntries =
      exportCtx.module.meta.isPackageRoot || publicExports.length > 0
        ? publicExports
        : exportCtx.module.hir.module.exports.filter((entry) =>
            isPackageVisible(entry.visibility),
          );
    const isTestExport = (entry: HirExportEntry): boolean => {
      const name =
        entry.alias ?? symbolName(exportCtx, exportCtx.moduleId, entry.symbol);
      return isGeneratedTestId(name);
    };
    const exportEntries = exportCtx.options.testMode
      ? baseEntries.filter(isTestExport)
      : baseEntries;

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

        if (meta.paramTypes.length > userParamOffsetFor(meta)) {
          return;
        }
        const valueType = wasmTypeFor(meta.resultTypeId, exportCtx);
        const serializer = resolveSerializerForTypes(
          [meta.resultTypeId],
          exportCtx,
        );
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
      instanceId: meta.instanceId,
      typeInstanceId: meta.instanceId,
      effectful: true,
      currentHandler: { index: 0, type: handlerParamType },
    };

    fn.parameters.forEach((param, index) => {
      const type = meta.paramTypes[index];
      if (typeof type !== "number") {
        throw new Error(
          `codegen missing parameter type for symbol ${param.symbol}`,
        );
      }
      implCtx.bindings.set(param.symbol, {
        kind: "local",
        index: index + implSignature.userParamOffset,
        type,
        typeId: meta.paramTypeIds[index],
      });
    });

    const implBody = compileExpression({
      exprId: fn.body,
      ctx,
      fnCtx: implCtx,
      tailPosition: false,
      expectedResultTypeId: implCtx.returnTypeId,
    });

    const returnValueType = wasmTypeFor(meta.resultTypeId, ctx);
    const implExprType = binaryen.getExpressionType(implBody.expr);
    const shouldWrapOutcome =
      implExprType === returnValueType ||
      (returnValueType === ctx.rtt.baseType &&
        implExprType !== binaryen.none &&
        implExprType !== binaryen.unreachable &&
        implExprType !== ctx.effectsBackend.abi.effectfulResultType(ctx));
    const functionBody = shouldWrapOutcome
      ? wrapValueInOutcome({
        valueExpr: implBody.expr,
          valueType: returnValueType,
          ctx,
        })
      : implBody.expr;

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
      implName,
      buildImplCallArgs: () => [
        ctx.effectsBackend.abi.hiddenHandlerValue(ctx),
        ...fn.parameters.map((_, index) =>
          ctx.mod.local.get(index, meta.paramTypes[index] as number),
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

  fn.parameters.forEach((param, index) => {
    const wasmIndex = index + handlerOffset;
    const type = meta.paramTypes[wasmIndex];
    if (typeof type !== "number") {
      throw new Error(
        `codegen missing parameter type for symbol ${param.symbol}`,
      );
    }
    fnCtx.bindings.set(param.symbol, {
      kind: "local",
      index: wasmIndex,
      type,
      typeId: meta.paramTypeIds[index],
    });
  });

  const body = compileExpression({
    exprId: fn.body,
    ctx,
    fnCtx,
    tailPosition: !meta.effectful,
    expectedResultTypeId: fnCtx.returnTypeId,
  });
  const returnValueType = wasmTypeFor(meta.resultTypeId, ctx);
  const bodyExprType = binaryen.getExpressionType(body.expr);
  const shouldWrapOutcome =
    meta.effectful &&
    (bodyExprType === returnValueType ||
      (returnValueType === ctx.rtt.baseType &&
        bodyExprType !== binaryen.none &&
        bodyExprType !== binaryen.unreachable &&
        bodyExprType !== ctx.effectsBackend.abi.effectfulResultType(ctx)));
  const functionBody = shouldWrapOutcome
    ? wrapValueInOutcome({
        valueExpr: body.expr,
        valueType: returnValueType,
        ctx,
      })
    : body.expr;

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
