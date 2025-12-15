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
} from "../semantics/hir/index.js";
import { wrapValueInOutcome } from "./effects/outcome-values.js";
import {
  collectEffectOperationSignatures,
  createEffectfulEntry,
  createHandleOutcome,
  createReadValue,
  createResumeContinuation,
  createResumeEffectful,
  ensureEffectResultAccessors,
  ensureLinearMemory,
  ensureMsgPackImports,
} from "./effects/host-boundary.js";
import { effectsFacade } from "./effects/facade.js";
import { emitPureSurfaceWrapper } from "./effects/abi-wrapper.js";

export const registerFunctionMetadata = (ctx: CodegenContext): void => {
  const effects = effectsFacade(ctx);
  const unknown = ctx.typing.arena.internPrimitive("unknown");
  const exportedItems = new Set(
    ctx.hir.module.exports.map((entry) => entry.item)
  );
  const handlerParamType = ctx.effectsRuntime.handlerFrameType;

  for (const [itemId, item] of ctx.hir.items) {
    if (item.kind !== "function") continue;
    ctx.itemsToSymbols.set(itemId, { moduleId: ctx.moduleId, symbol: item.symbol });

    const symbolRecord = ctx.symbolTable.getSymbol(item.symbol);
    const intrinsicMetadata = (symbolRecord.metadata ?? {}) as {
      intrinsic?: boolean;
      intrinsicUsesSignature?: boolean;
    };
    if (intrinsicMetadata.intrinsic && intrinsicMetadata.intrinsicUsesSignature !== true) {
      continue;
    }

    const scheme = ctx.typing.table.getSymbolScheme(item.symbol);
    if (typeof scheme !== "number") {
      throw new Error(
        `codegen missing type scheme for function ${item.symbol}`
      );
    }

    const schemeInfo = ctx.typing.arena.getScheme(scheme);
    const instantiationInfo = ctx.typing.functionInstantiationInfo.get(item.symbol);
    const recordedInstantiations =
      instantiationInfo && instantiationInfo.size > 0
        ? Array.from(instantiationInfo.entries())
        : [];
    if (recordedInstantiations.length === 0 && schemeInfo.params.length > 0) {
      const name = ctx.symbolTable.getSymbol(item.symbol).name;
      const exported = exportedItems.has(itemId) ? "exported " : "";
      throw new Error(
        `codegen requires a concrete instantiation for ${exported}generic function ${name}`
      );
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
        const name = ctx.symbolTable.getSymbol(item.symbol).name;
        throw new Error(
          `codegen cannot emit ${name} without resolved type arguments (instance ${instanceKey})`
        );
      }
      if (ctx.functionInstances.has(instanceKey)) {
        return;
      }

      const typeId = ctx.typing.arena.instantiate(scheme, typeArgs);
      const descriptor = ctx.typing.arena.get(typeId);
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
          `[effects] effectful ${ctx.moduleLabel}::${ctx.symbolTable.getSymbol(item.symbol).name}`,
          {
            effectRow: effectInfo.effectRow,
            row: ctx.typing.effects.getRow(effectInfo.effectRow),
            hasOps:
              ctx.typing.effects.getRow(effectInfo.effectRow).operations.length >
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
        resultTypeId: descriptor.returnType,
        typeArgs,
        instanceKey,
        effectful,
        effectRow: effectInfo.effectRow,
      };

      const key = functionKey(ctx.moduleId, item.symbol);
      const metas = ctx.functions.get(key);
      if (metas) {
        metas.push(metadata);
      } else {
        ctx.functions.set(key, [metadata]);
      }
      ctx.functionInstances.set(scopedInstanceKey(ctx.moduleId, instanceKey), metadata);
    });
  }
};

export const compileFunctions = (ctx: CodegenContext): void => {
  for (const item of ctx.hir.items.values()) {
    if (item.kind !== "function") continue;
    const symbolRecord = ctx.symbolTable.getSymbol(item.symbol);
    const intrinsicMetadata = (symbolRecord.metadata ?? {}) as {
      intrinsic?: boolean;
      intrinsicUsesSignature?: boolean;
    };
    if (intrinsicMetadata.intrinsic && intrinsicMetadata.intrinsicUsesSignature !== true) {
      continue;
    }
    const metas = ctx.functions.get(functionKey(ctx.moduleId, item.symbol));
    if (!metas || metas.length === 0) {
      throw new Error(`codegen missing metadata for function ${item.symbol}`);
    }
    metas.forEach((meta) => compileFunctionItem(item, meta, ctx));
  }
};

export const registerImportMetadata = (ctx: CodegenContext): void => {
  const effects = effectsFacade(ctx);
  const handlerParamType = ctx.effectsRuntime.handlerFrameType;
  ctx.binding.imports.forEach((imp) => {
    if (!imp.target) return;
    if (imp.target.moduleId === ctx.moduleId) return;
    const symbolRecord = ctx.symbolTable.getSymbol(imp.local);
    const intrinsicMetadata = (symbolRecord.metadata ?? {}) as {
      intrinsic?: boolean;
      intrinsicUsesSignature?: boolean;
    };
    if (intrinsicMetadata.intrinsic && intrinsicMetadata.intrinsicUsesSignature !== true) {
      return;
    }

    const signature = ctx.typing.functions.getSignature(imp.local);
    if (!signature) return;

    const targetKey = functionKey(imp.target.moduleId, imp.target.symbol);
    const targetMetas = ctx.functions.get(targetKey);
    if (!targetMetas || targetMetas.length === 0) {
      return;
    }

    const schemeId = ctx.typing.table.getSymbolScheme(imp.local);
    const scheme =
      typeof schemeId === "number" ? ctx.typing.arena.getScheme(schemeId) : undefined;
    const typeParamCount = signature.typeParams?.length ?? scheme?.params.length ?? 0;
    const instantiationInfo = ctx.typing.functionInstantiationInfo.get(imp.local);
    const recordedInstantiations =
      instantiationInfo && instantiationInfo.size > 0
        ? Array.from(instantiationInfo.entries())
        : [];
    if (recordedInstantiations.length === 0 && typeParamCount > 0) {
      const name = ctx.symbolTable.getSymbol(imp.local).name;
      throw new Error(
        `codegen requires a concrete instantiation for imported generic function ${name}`
      );
    }
    const instantiations: [string, readonly TypeId[]][] =
      recordedInstantiations.length > 0
        ? recordedInstantiations
        : [[formatInstanceKey(imp.local, []), []]];

      instantiations.forEach(([instanceKey, typeArgs]) => {
        const targetMeta = pickTargetMeta(targetMetas, typeArgs.length);
        const effectInfo = effects.functionAbi(imp.local);
        const effectful =
          targetMeta?.effectful ?? (effectInfo ? effectInfo.typeEffectful : false);
        const userParamTypes = signature.parameters.map((param) =>
          wasmTypeFor(param.type, ctx)
        );
        const paramTypes = effectful
          ? [handlerParamType, ...userParamTypes]
          : userParamTypes;
        const resultType = effectful
          ? ctx.effectsRuntime.outcomeType
          : wasmTypeFor(signature.returnType, ctx);
      const metadata: FunctionMetadata = {
        moduleId: ctx.moduleId,
        symbol: imp.local,
        wasmName: (targetMeta ?? targetMetas[0]!).wasmName,
        paramTypes,
        resultType,
        paramTypeIds: signature.parameters.map((param) => param.type),
        resultTypeId: signature.returnType,
        typeArgs,
        instanceKey,
        effectful,
        effectRow: targetMeta?.effectRow ?? effectInfo?.effectRow,
      };
      const key = functionKey(ctx.moduleId, imp.local);
      const metas = ctx.functions.get(key);
      if (metas) {
        metas.push(metadata);
      } else {
        ctx.functions.set(key, [metadata]);
      }
      ctx.functionInstances.set(scopedInstanceKey(ctx.moduleId, instanceKey), metadata);
    });
  });
};

export const emitModuleExports = (ctx: CodegenContext): void => {
  const publicExports = ctx.hir.module.exports.filter((entry) =>
    isPublicVisibility(entry.visibility)
  );
  const exportEntries =
    ctx.binding.isPackageRoot || publicExports.length > 0
      ? publicExports
      : ctx.hir.module.exports.filter((entry) =>
          isPackageVisible(entry.visibility)
        );

  const effectfulExports: { meta: FunctionMetadata; exportName: string }[] = [];
  let effectfulValueType: binaryen.Type | undefined;
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
    const symbolRecord = ctx.symbolTable.getSymbol(entry.symbol);
    const intrinsicMetadata = (symbolRecord.metadata ?? {}) as {
      intrinsic?: boolean;
      intrinsicUsesSignature?: boolean;
    };
    if (
      intrinsicMetadata.intrinsic &&
      intrinsicMetadata.intrinsicUsesSignature !== true
    ) {
      return;
    }
    const metas = ctx.functions.get(
      functionKey(ctx.moduleId, entry.symbol)
    );
    const meta =
      metas?.find((candidate) => candidate.typeArgs.length === 0) ?? metas?.[0];
    if (!meta) {
      return;
    }
    const exportName = entry.alias ?? symbolRecord.name;
    if (meta.effectful) {
      emitEffectfulWasmExportWrapper({ meta, exportName });

      if (meta.paramTypes.length > 1) {
        return;
      }
      const valueType = wasmTypeFor(meta.resultTypeId, ctx);
      if (!effectfulValueType) {
        effectfulValueType = valueType;
      } else if (effectfulValueType !== valueType) {
        throw new Error(
          "effectful exports with differing return types are not supported"
        );
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
  const signatures = collectEffectOperationSignatures(ctx);
  const handleOutcome = createHandleOutcome({
    ctx,
    runtime: ctx.effectsRuntime,
    valueType: effectfulValueType ?? binaryen.none,
    signatures,
    imports,
  });
  const resumeContinuation = createResumeContinuation({
    ctx,
    runtime: ctx.effectsRuntime,
    signatures,
  });
  createResumeEffectful({
    ctx,
    runtime: ctx.effectsRuntime,
    imports,
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
    ctx.symbolTable.getSymbol(fn.symbol).name
  );
  const suffix =
    typeArgs.length === 0 ? "" : `__inst_${sanitizeIdentifier(typeArgs.join("_"))}`;
  return `${ctx.moduleLabel}__${symbolName}_${fn.symbol}${suffix}`;
};

const sanitizeIdentifier = (value: string): string =>
  value.replace(/[^a-zA-Z0-9_]/g, "_");
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

const functionKey = (moduleId: string, symbol: number): string =>
  `${moduleId}::${symbol}`;

const scopedInstanceKey = (
  moduleId: string,
  instanceKey: string
): string => `${moduleId}::${instanceKey}`;

const pickTargetMeta = (
  metas: readonly FunctionMetadata[],
  typeArgCount: number
): FunctionMetadata | undefined =>
  metas.find((meta) => meta.typeArgs.length === typeArgCount) ?? metas[0];
