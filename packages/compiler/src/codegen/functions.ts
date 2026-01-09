import binaryen from "binaryen";
import type {
  CodegenContext,
  FunctionContext,
  FunctionMetadata,
  HirFunction,
  TypeId,
} from "./context.js";
import { compileExpression } from "./expressions/index.js";
import { wasmTypeFor } from "./types.js";
import {
  isPackageVisible,
  isPublicVisibility,
  type HirExportEntry,
} from "../semantics/hir/index.js";
import { diagnosticFromCode } from "../diagnostics/index.js";
import { wrapValueInOutcome } from "./effects/outcome-values.js";
import {
  collectEffectOperationSignatures,
  createEffectfulEntry,
  createHandleOutcomeDynamic,
  createReadValue,
  createResumeContinuation,
  createResumeEffectful,
  ensureEffectResultAccessors,
  ensureLinearMemory,
  ensureMsgPackImports,
} from "./effects/host-boundary.js";
import { effectsFacade } from "./effects/facade.js";
import { emitPureSurfaceWrapper } from "./effects/abi-wrapper.js";
import { makeInstanceKey } from "../semantics/codegen-view/index.js";

const getFunctionMetas = (
  ctx: CodegenContext,
  moduleId: string,
  symbol: number
): FunctionMetadata[] | undefined => ctx.functions.get(moduleId)?.get(symbol);

const pushFunctionMeta = (
  ctx: CodegenContext,
  moduleId: string,
  symbol: number,
  meta: FunctionMetadata
): void => {
  const bySymbol = ctx.functions.get(moduleId) ?? new Map<number, FunctionMetadata[]>();
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

export const registerFunctionMetadata = (ctx: CodegenContext): void => {
  const effects = effectsFacade(ctx);
  const unknown = ctx.program.primitives.unknown;
  const exportedItems = new Set(
    ctx.module.hir.module.exports.map((entry) => entry.item)
  );
  const handlerParamType = ctx.effectsRuntime.handlerFrameType;

  for (const [itemId, item] of ctx.module.hir.items) {
    if (item.kind !== "function") continue;
    ctx.itemsToSymbols.set(itemId, { moduleId: ctx.moduleId, symbol: item.symbol });

    const intrinsicMetadata = ctx.program.symbols.getIntrinsicFunctionFlags(
      ctx.moduleId,
      item.symbol
    );
    if (intrinsicMetadata.intrinsic && intrinsicMetadata.intrinsicUsesSignature !== true) {
      continue;
    }

    const signature = ctx.program.functions.getSignature(ctx.moduleId, item.symbol);
    if (!signature) {
      throw new Error(`codegen missing type information for function ${item.symbol}`);
    }

    const schemeInfo = ctx.program.arena.getScheme(signature.scheme);
    const instantiationInfo = ctx.program.functions.getInstantiationInfo(ctx.moduleId, item.symbol);
    const recordedInstantiations =
      instantiationInfo && instantiationInfo.size > 0
        ? Array.from(instantiationInfo.entries())
        : [];
    if (recordedInstantiations.length === 0 && schemeInfo.params.length > 0) {
      continue;
    }
    const instantiations: [string, readonly TypeId[]][] =
      recordedInstantiations.length > 0
        ? recordedInstantiations
        : getDefaultInstantiationArgs({
            symbol: item.symbol,
            params: schemeInfo.params.length,
          });

    instantiations.forEach(([instanceKey, typeArgs]) => {
      if (typeArgs.some((arg) => arg === unknown)) {
        const name = ctx.program.symbols.getLocalName(ctx.moduleId, item.symbol) ?? `${item.symbol}`;
        throw new Error(
          `codegen cannot emit ${name} without resolved type arguments (instance ${instanceKey})`
        );
      }
      const scopedKey = makeInstanceKey(ctx.moduleId, instanceKey);
      if (ctx.functionInstances.has(scopedKey)) {
        return;
      }

      const typeId = ctx.program.arena.instantiate(signature.scheme, typeArgs);
      const descriptor = ctx.program.arena.get(typeId);
      if (descriptor.kind !== "function") {
        throw new Error(
          `codegen expected function type for symbol ${item.symbol}`
        );
      }

      const effectInfo = effects.functionAbi(item.symbol);
      if (!effectInfo) {
        throw new Error(
          `codegen missing effect information for function ${item.symbol}`
        );
      }
      const effectful = effectInfo.typeEffectful;
      if (effectful && process.env.DEBUG_EFFECTS === "1") {
        console.log(
          `[effects] effectful ${ctx.moduleLabel}::${ctx.program.symbols.getLocalName(ctx.moduleId, item.symbol) ?? item.symbol}`,
          {
            effectRow: effectInfo.effectRow,
            row: ctx.program.effects.getRow(effectInfo.effectRow),
            hasOps:
              ctx.program.effects.getRow(effectInfo.effectRow).operations.length >
              0,
          }
        );
      }

      const userParamTypes = descriptor.parameters.map((param) =>
        wasmTypeFor(param.type, ctx)
      );
      const paramTypes = effectful
        ? [handlerParamType, ...userParamTypes]
        : userParamTypes;
      const resultType = effectful
        ? ctx.effectsRuntime.outcomeType
        : wasmTypeFor(descriptor.returnType, ctx);

      const metadata: FunctionMetadata = {
        moduleId: ctx.moduleId,
        symbol: item.symbol,
        wasmName: makeFunctionName(item, ctx, typeArgs),
        paramTypes,
        resultType,
        paramTypeIds: descriptor.parameters.map((param) => param.type),
        parameters: descriptor.parameters.map((param, index) => ({
          typeId: param.type,
          label: param.label,
          optional: param.optional,
          name:
            typeof item.parameters[index]?.symbol === "number"
              ? ctx.program.symbols.getLocalName(
                  ctx.moduleId,
                  item.parameters[index]!.symbol
                )
              : undefined,
        })),
        resultTypeId: descriptor.returnType,
        typeArgs,
        instanceKey,
        effectful,
        effectRow: effectInfo.effectRow,
      };

      pushFunctionMeta(ctx, ctx.moduleId, item.symbol, metadata);
      ctx.functionInstances.set(scopedKey, metadata);
    });
  }
};

export const compileFunctions = (ctx: CodegenContext): void => {
  for (const item of ctx.module.hir.items.values()) {
    if (item.kind !== "function") continue;
    const intrinsicMetadata = ctx.program.symbols.getIntrinsicFunctionFlags(
      ctx.moduleId,
      item.symbol
    );
    if (intrinsicMetadata.intrinsic && intrinsicMetadata.intrinsicUsesSignature !== true) {
      continue;
    }
    const metas = getFunctionMetas(ctx, ctx.moduleId, item.symbol);
    if (!metas || metas.length === 0) {
      const signature = ctx.program.functions.getSignature(ctx.moduleId, item.symbol);
      const scheme = signature ? ctx.program.arena.getScheme(signature.scheme) : undefined;
      const instantiationInfo = ctx.program.functions.getInstantiationInfo(ctx.moduleId, item.symbol);
      const hasInstantiations = Boolean(instantiationInfo && instantiationInfo.size > 0);
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
  const handlerParamType = ctx.effectsRuntime.handlerFrameType;
  ctx.module.meta.imports.forEach((imp) => {
    const target = ctx.program.imports.getTarget(ctx.moduleId, imp.local);
    if (!target) return;
    if (target.moduleId === ctx.moduleId) return;
    const intrinsicMetadata = ctx.program.symbols.getIntrinsicFunctionFlags(
      ctx.moduleId,
      imp.local
    );
    if (intrinsicMetadata.intrinsic && intrinsicMetadata.intrinsicUsesSignature !== true) {
      return;
    }

    const signature = ctx.program.functions.getSignature(ctx.moduleId, imp.local);
    if (!signature) return;

    const targetMetas = getFunctionMetas(ctx, target.moduleId, target.symbol);
    if (!targetMetas || targetMetas.length === 0) {
      return;
    }

    const scheme = ctx.program.arena.getScheme(signature.scheme);
    const typeParamCount =
      signature.typeParams.length > 0
        ? signature.typeParams.length
        : scheme.params.length;
    const instantiationInfo = ctx.program.functions.getInstantiationInfo(ctx.moduleId, imp.local);
    const recordedInstantiations =
      instantiationInfo && instantiationInfo.size > 0
        ? Array.from(instantiationInfo.entries())
        : [];
    if (recordedInstantiations.length === 0 && typeParamCount > 0) {
      return;
    }
    const instantiations: [string, readonly TypeId[]][] =
      recordedInstantiations.length > 0
        ? recordedInstantiations
        : [[formatInstanceKey(imp.local, []), []]];

      instantiations.forEach(([instanceKey, typeArgs]) => {
        const targetMeta = pickTargetMeta(targetMetas, typeArgs);
        const effectInfo = effects.functionAbi(imp.local);
        const effectful =
          targetMeta?.effectful ?? (effectInfo ? effectInfo.typeEffectful : false);
        const instantiatedTypeId =
          typeof signature.scheme === "number"
            ? ctx.program.arena.instantiate(signature.scheme, typeArgs)
            : signature.typeId;
        const instantiatedTypeDesc = ctx.program.arena.get(instantiatedTypeId);
        if (instantiatedTypeDesc.kind !== "function") {
          throw new Error(
            `codegen expected function type for import ${imp.local} (type ${instantiatedTypeId})`
          );
        }

        const userParamTypes = instantiatedTypeDesc.parameters.map((param) =>
          wasmTypeFor(param.type, ctx)
        );
        const paramTypes = effectful
          ? [handlerParamType, ...userParamTypes]
          : userParamTypes;
        const resultType = effectful
          ? ctx.effectsRuntime.outcomeType
          : wasmTypeFor(instantiatedTypeDesc.returnType, ctx);
      const metadata: FunctionMetadata = {
        moduleId: ctx.moduleId,
        symbol: imp.local,
        wasmName: (targetMeta ?? targetMetas[0]!).wasmName,
        paramTypes,
        resultType,
        paramTypeIds: instantiatedTypeDesc.parameters.map((param) => param.type),
        parameters: instantiatedTypeDesc.parameters.map((param, index) => ({
          typeId: param.type,
          label: param.label,
          optional: param.optional,
          name: signature.parameters[index]?.name,
        })),
        resultTypeId: instantiatedTypeDesc.returnType,
        typeArgs,
        instanceKey,
        effectful,
        effectRow: targetMeta?.effectRow ?? effectInfo?.effectRow,
      };
      pushFunctionMeta(ctx, ctx.moduleId, imp.local, metadata);
      ctx.functionInstances.set(makeInstanceKey(ctx.moduleId, instanceKey), metadata);
    });
  });
};

export const emitModuleExports = (
  ctx: CodegenContext,
  contexts: readonly CodegenContext[] = [ctx]
): void => {
  const publicExports = ctx.module.hir.module.exports.filter((entry) =>
    isPublicVisibility(entry.visibility)
  );
  const exportEntries =
    ctx.module.meta.isPackageRoot || publicExports.length > 0
      ? publicExports
      : ctx.module.hir.module.exports.filter((entry) =>
          isPackageVisible(entry.visibility)
        );

  const effectfulExports: { meta: FunctionMetadata; exportName: string }[] = [];
  const handlerParamType = ctx.effectsRuntime.handlerFrameType;

  const emitEffectfulWasmExportWrapper = ({
    meta,
    exportName,
  }: {
    meta: FunctionMetadata;
    exportName: string;
  }): void => {
    const userParamTypes = meta.paramTypes.slice(1) as number[];
    const wrapperName = `${meta.wasmName}__wasm_export_${sanitizeIdentifier(exportName)}`;

    emitPureSurfaceWrapper({
      ctx,
      wrapperName,
      wrapperParamTypes: userParamTypes,
      wrapperResultType: wasmTypeFor(meta.resultTypeId, ctx),
      implName: meta.wasmName,
      buildImplCallArgs: () => [
        ctx.mod.ref.null(handlerParamType),
        ...userParamTypes.map((type, index) => ctx.mod.local.get(index, type)),
      ],
    });
    ctx.mod.addFunctionExport(wrapperName, exportName);
  };

  exportEntries.forEach((entry) => {
    const intrinsicMetadata = ctx.program.symbols.getIntrinsicFunctionFlags(
      ctx.moduleId,
      entry.symbol
    );
    if (
      intrinsicMetadata.intrinsic &&
      intrinsicMetadata.intrinsicUsesSignature !== true
    ) {
      return;
    }
    const metas = getFunctionMetas(ctx, ctx.moduleId, entry.symbol);
    const meta = metas?.find((candidate) => candidate.typeArgs.length === 0) ?? metas?.[0];
    if (!meta) {
      reportMissingExportedGenericInstantiation({ ctx, entry });
      return;
    }
    const exportName =
      entry.alias ?? ctx.program.symbols.getLocalName(ctx.moduleId, entry.symbol) ?? `${entry.symbol}`;
    if (meta.effectful) {
      emitEffectfulWasmExportWrapper({ meta, exportName });

      if (meta.paramTypes.length > 1) {
        return;
      }
      const valueType = wasmTypeFor(meta.resultTypeId, ctx);
      const supportedReturn =
        valueType === binaryen.none ||
        valueType === binaryen.i32 ||
        valueType === binaryen.i64 ||
        valueType === binaryen.f32 ||
        valueType === binaryen.f64;
      if (!supportedReturn) {
        ctx.diagnostics.report(
          diagnosticFromCode({
            code: "CG0002",
            params: {
              kind: "unsupported-effectful-export-return",
              exportName,
              returnType: formatWasmType(valueType),
            },
            span: entry.span,
          })
        );
        return;
      }
      effectfulExports.push({ meta, exportName });
      return;
    }
    ctx.mod.addFunctionExport(meta.wasmName, exportName);
  });

  if (effectfulExports.length === 0) {
    return;
  }

  ensureLinearMemory(ctx);
  const imports = ensureMsgPackImports(ctx);
  const signatures = collectEffectOperationSignatures(ctx, contexts);
  const handleOutcome = createHandleOutcomeDynamic({
    ctx,
    runtime: ctx.effectsRuntime,
    signatures,
    imports,
  });
  const resumeContinuation = createResumeContinuation({
    ctx,
    runtime: ctx.effectsRuntime,
    signatures,
    imports,
  });
  createResumeEffectful({
    ctx,
    runtime: ctx.effectsRuntime,
    handleOutcome,
    resumeContinuation,
  });
  createReadValue({ ctx, imports });
  ensureEffectResultAccessors({ ctx, runtime: ctx.effectsRuntime });

  effectfulExports.forEach(({ meta, exportName }) => {
    createEffectfulEntry({
      ctx,
      runtime: ctx.effectsRuntime,
      meta,
      handleOutcome,
      exportName: `${exportName}_effectful`,
    });
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
  const signature = ctx.program.functions.getSignature(ctx.moduleId, entry.symbol);
  if (!signature) return;

  const scheme = ctx.program.arena.getScheme(signature.scheme);
  if (scheme.params.length === 0) return;

  const body = ctx.program.arena.get(scheme.body);
  if (body.kind !== "function") return;
  const functionName =
    ctx.program.symbols.getLocalName(ctx.moduleId, entry.symbol) ?? `${entry.symbol}`;

  ctx.diagnostics.report(
    diagnosticFromCode({
      code: "CG0003",
      params: {
        kind: "exported-generic-missing-instantiation",
        functionName,
      },
      span: entry.span,
    })
  );
};

const compileFunctionItem = (
  fn: HirFunction,
  meta: FunctionMetadata,
  ctx: CodegenContext
): void => {
  const effectInfo = effectsFacade(ctx).functionAbi(fn.symbol);
  if (!effectInfo) {
    throw new Error(`codegen missing effect information for function ${fn.symbol}`);
  }
  const needsWrapper = effectInfo.abiEffectful && effectInfo.typeEffectful === false;
  const handlerParamType = ctx.effectsRuntime.handlerFrameType;
  if (needsWrapper) {
    const implName = `${meta.wasmName}__effectful_impl`;
    const implCtx: FunctionContext = {
      bindings: new Map(),
      tempLocals: new Map(),
      locals: [],
      nextLocalIndex: meta.paramTypes.length + 1,
      returnTypeId: meta.resultTypeId,
      instanceKey: meta.instanceKey,
      typeInstanceKey: meta.instanceKey,
      effectful: true,
      currentHandler: { index: 0, type: handlerParamType },
    };

    fn.parameters.forEach((param, index) => {
      const type = meta.paramTypes[index];
      if (typeof type !== "number") {
        throw new Error(
          `codegen missing parameter type for symbol ${param.symbol}`
        );
      }
      implCtx.bindings.set(param.symbol, {
        kind: "local",
        index: index + 1,
        type,
        typeId: meta.paramTypeIds[index],
      });
    });

    const implBody = compileExpression({
      exprId: fn.body,
      ctx,
      fnCtx: implCtx,
      tailPosition: true,
      expectedResultTypeId: implCtx.returnTypeId,
    });

    const returnValueType = wasmTypeFor(meta.resultTypeId, ctx);
    const shouldWrapOutcome =
      binaryen.getExpressionType(implBody.expr) === returnValueType;
    const functionBody = shouldWrapOutcome
      ? wrapValueInOutcome({
          valueExpr: implBody.expr,
          valueType: returnValueType,
          ctx,
        })
      : implBody.expr;

    ctx.mod.addFunction(
      implName,
      binaryen.createType([handlerParamType, ...(meta.paramTypes as number[])]),
      ctx.effectsRuntime.outcomeType,
      implCtx.locals,
      functionBody
    );

    emitPureSurfaceWrapper({
      ctx,
      wrapperName: meta.wasmName,
      wrapperParamTypes: meta.paramTypes as number[],
      wrapperResultType: meta.resultType,
      implName,
      buildImplCallArgs: () => [
        ctx.mod.ref.null(handlerParamType),
        ...fn.parameters.map((_, index) =>
          ctx.mod.local.get(index, meta.paramTypes[index] as number)
        ),
      ],
    });
    return;
  }

  const handlerOffset = meta.effectful ? 1 : 0;
  const fnCtx: FunctionContext = {
    bindings: new Map(),
    tempLocals: new Map(),
    locals: [],
    nextLocalIndex: meta.paramTypes.length,
    returnTypeId: meta.resultTypeId,
    instanceKey: meta.instanceKey,
    typeInstanceKey: meta.instanceKey,
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
        `codegen missing parameter type for symbol ${param.symbol}`
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
    tailPosition: true,
    expectedResultTypeId: fnCtx.returnTypeId,
  });
  const returnValueType = wasmTypeFor(meta.resultTypeId, ctx);
  const shouldWrapOutcome =
    meta.effectful &&
    binaryen.getExpressionType(body.expr) === returnValueType;
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
    functionBody
  );
};

const makeFunctionName = (
  fn: HirFunction,
  ctx: CodegenContext,
  typeArgs: readonly TypeId[]
): string => {
  const symbolName = sanitizeIdentifier(
    ctx.program.symbols.getLocalName(ctx.moduleId, fn.symbol) ?? `${fn.symbol}`
  );
  const suffix =
    typeArgs.length === 0 ? "" : `__inst_${sanitizeIdentifier(typeArgs.join("_"))}`;
  return `${ctx.moduleLabel}__${symbolName}_${fn.symbol}${suffix}`;
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
  symbol,
  params,
}: {
  symbol: number;
  params: number;
}): [string, readonly TypeId[]][] => {
  if (params === 0) {
    return [[formatInstanceKey(symbol, []), []]];
  }
  throw new Error(
    "getDefaultInstantiationArgs should only be used for non-generic functions"
  );
};

const formatInstanceKey = (
  symbol: number,
  typeArgs: readonly TypeId[]
): string => `${symbol}<${typeArgs.join(",")}>`;

const pickTargetMeta = (
  metas: readonly FunctionMetadata[],
  typeArgs: readonly TypeId[]
): FunctionMetadata | undefined => {
  const exact = metas.find(
    (meta) =>
      meta.typeArgs.length === typeArgs.length &&
      meta.typeArgs.every((arg, index) => arg === typeArgs[index])
  );
  if (exact) {
    return exact;
  }
  const byArity = metas.find((meta) => meta.typeArgs.length === typeArgs.length);
  return byArity ?? metas[0];
};
