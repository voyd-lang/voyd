import binaryen from "binaryen";
import type {
  CodegenContext,
  FunctionContext,
  FunctionMetadata,
  HirFunction,
  HirPattern,
  TypeId,
} from "./context.js";
import { compileExpression } from "./expressions/index.js";
import { wasmTypeFor } from "./types.js";
import {
  isPackageVisible,
  isPublicVisibility,
} from "../semantics/hir/index.js";
import { wrapValueInOutcome } from "./effects/outcome-values.js";
import { allocateTempLocal } from "./locals.js";
import { unboxOutcomeValue } from "./effects/outcome-values.js";
import { ensureDispatcher } from "./effects/dispatcher.js";
import { OUTCOME_TAGS } from "./effects/runtime-abi.js";
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

const containsEffectHandlerFromPattern = (
  pattern: HirPattern,
  ctx: CodegenContext
): boolean => {
  switch (pattern.kind) {
    case "identifier":
    case "wildcard":
      return false;
    case "destructure":
      return (
        pattern.fields.some((field) =>
          containsEffectHandlerFromPattern(field.pattern, ctx)
        ) ||
        (pattern.spread
          ? containsEffectHandlerFromPattern(pattern.spread, ctx)
          : false)
      );
    case "tuple":
      return pattern.elements.some((element) =>
        containsEffectHandlerFromPattern(element, ctx)
      );
    case "type":
      return pattern.binding
        ? containsEffectHandlerFromPattern(pattern.binding, ctx)
        : false;
  }
};

const containsEffectHandler = (
  exprId: number,
  ctx: CodegenContext
): boolean => {
  const expr = ctx.hir.expressions.get(exprId);
  if (!expr) return false;
  switch (expr.exprKind) {
    case "effect-handler":
      return true;
    case "call":
      return (
        containsEffectHandler(expr.callee, ctx) ||
        expr.args.some((arg) => containsEffectHandler(arg.expr, ctx))
      );
    case "block":
      return (
        expr.statements.some((stmtId) => {
          const stmt = ctx.hir.statements.get(stmtId);
          if (!stmt) return false;
          if (stmt.kind === "let") {
            return (
              containsEffectHandler(stmt.initializer, ctx) ||
              containsEffectHandlerFromPattern(stmt.pattern, ctx)
            );
          }
          if (stmt.kind === "expr-stmt") {
            return containsEffectHandler(stmt.expr, ctx);
          }
          if (stmt.kind === "return" && typeof stmt.value === "number") {
            return containsEffectHandler(stmt.value, ctx);
          }
          return false;
        }) ||
        (typeof expr.value === "number" &&
          containsEffectHandler(expr.value, ctx))
      );
    case "tuple":
      return expr.elements.some((element) =>
        containsEffectHandler(element, ctx)
      );
    case "loop":
      return containsEffectHandler(expr.body, ctx);
    case "while":
      return (
        containsEffectHandler(expr.condition, ctx) ||
        containsEffectHandler(expr.body, ctx)
      );
    case "if":
    case "cond":
      return (
        expr.branches.some(
          (branch) =>
            containsEffectHandler(branch.condition, ctx) ||
            containsEffectHandler(branch.value, ctx)
        ) ||
        (typeof expr.defaultBranch === "number" &&
          containsEffectHandler(expr.defaultBranch, ctx))
      );
    case "match":
      return (
        containsEffectHandler(expr.discriminant, ctx) ||
        expr.arms.some(
          (arm) =>
            (typeof arm.guard === "number" &&
              containsEffectHandler(arm.guard, ctx)) ||
            containsEffectHandler(arm.value, ctx)
        )
      );
    case "object-literal":
      return expr.entries.some((entry) =>
        containsEffectHandler(entry.value, ctx)
      );
    case "field-access":
      return containsEffectHandler(expr.target, ctx);
    case "assign":
      return (
        (typeof expr.target === "number" &&
          containsEffectHandler(expr.target, ctx)) ||
        containsEffectHandler(expr.value, ctx)
      );
    case "lambda":
    case "identifier":
    case "literal":
    case "overload-set":
    case "continue":
    case "break":
      return false;
  }
};

export const registerFunctionMetadata = (ctx: CodegenContext): void => {
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

      const effectInfo = ctx.effectMir.functions.get(item.symbol);
      if (!effectInfo) {
        throw new Error(
          `codegen missing effect information for function ${item.symbol}`
        );
      }
      const effectful = effectInfo.pure === false;
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
        const effectInfo = ctx.effectMir.functions.get(imp.local);
        const effectful =
          targetMeta?.effectful ?? (effectInfo ? effectInfo.pure === false : false);
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
  const hasHandlerExpr = containsEffectHandler(fn.body, ctx);
  const handlerParamType = ctx.effectsRuntime.handlerFrameType;
  if (!meta.effectful && hasHandlerExpr) {
    const implName = `${meta.wasmName}__effectful_impl`;
    const implCtx: FunctionContext = {
      bindings: new Map(),
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

    const wrapperCtx: FunctionContext = {
      bindings: new Map(),
      locals: [],
      nextLocalIndex: meta.paramTypes.length,
      returnTypeId: meta.resultTypeId,
      instanceKey: meta.instanceKey,
      typeInstanceKey: meta.instanceKey,
      effectful: false,
    };
    const outcomeTemp = allocateTempLocal(ctx.effectsRuntime.outcomeType, wrapperCtx);
    const payload = () =>
      ctx.effectsRuntime.outcomePayload(
        ctx.mod.local.get(outcomeTemp.index, outcomeTemp.type)
      );
    const dispatchedOutcome = ctx.mod.call(
      ensureDispatcher(ctx),
      [
        ctx.mod.call(
          implName,
          [
            ctx.mod.ref.null(handlerParamType),
            ...fn.parameters.map((_, index) =>
              ctx.mod.local.get(index, meta.paramTypes[index] as number)
            ),
          ],
          ctx.effectsRuntime.outcomeType
        ),
      ],
      ctx.effectsRuntime.outcomeType
    );
    const tagIsValue = ctx.mod.i32.eq(
      ctx.effectsRuntime.outcomeTag(
        ctx.mod.local.get(outcomeTemp.index, outcomeTemp.type)
      ),
      ctx.mod.i32.const(OUTCOME_TAGS.value)
    );
    const wrapperBody = ctx.mod.block(
      null,
      [
        ctx.mod.local.set(outcomeTemp.index, dispatchedOutcome),
        ctx.mod.if(
          tagIsValue,
          unboxOutcomeValue({
            payload: payload(),
            valueType: meta.resultType,
            ctx,
          }),
          ctx.mod.unreachable()
        ),
      ],
      meta.resultType
    );

    ctx.mod.addFunction(
      meta.wasmName,
      binaryen.createType(meta.paramTypes as number[]),
      meta.resultType,
      wrapperCtx.locals,
      wrapperBody
    );
    return;
  }

  const handlerOffset = meta.effectful ? 1 : 0;
  const fnCtx: FunctionContext = {
    bindings: new Map(),
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
  } else if (hasHandlerExpr) {
    const handlerLocal = allocateTempLocal(handlerParamType, fnCtx);
    fnCtx.currentHandler = {
      index: handlerLocal.index,
      type: handlerLocal.type,
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
