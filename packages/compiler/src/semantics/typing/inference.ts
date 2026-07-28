import type { HirFunction, HirModuleLet } from "../hir/index.js";
import { ensureTypeMatches } from "./type-system.js";
import type { FunctionSignature, TypingContext, TypingState } from "./types.js";
import {
  formatFunctionInstanceKey,
  typeGenericFunctionBody,
  typeExpression,
  validateGenericFunctionBody,
} from "./expressions.js";
import { getValueType } from "./expressions/identifier.js";
import { mergeBranchType } from "./expressions/branching.js";
import { composeEffectRows, ensureEffectCompatibility, getExprEffectRow } from "./effects.js";
import { typeDefaultParameterValues } from "./default-parameters.js";
import { emitDiagnostic, normalizeSpan } from "../../diagnostics/index.js";
import { cloneNestedMap } from "./call-resolution.js";

export const runInferencePass = (
  ctx: TypingContext,
  state: TypingState
): void => {
  state.mode = "relaxed";
  let changed: boolean;
  do {
    clearFunctionInstances(ctx);
    ctx.table.clearExprTypes();
    ctx.resolvedExprTypes.clear();
    const moduleLetsChanged = typeAllModuleLets(ctx, state, {
      collectChanges: true,
    });
    const functionsChanged = typeAllFunctions(ctx, state, {
      collectChanges: true,
    });
    changed = moduleLetsChanged || functionsChanged;
  } while (changed);
};

export const runStrictTypeCheck = (
  ctx: TypingContext,
  state: TypingState
): void => {
  state.mode = "strict";
  clearFunctionInstances(ctx);
  ctx.table.clearExprTypes();
  ctx.resolvedExprTypes.clear();
  typeAllModuleLets(ctx, state, { collectChanges: false });
  indexGenericFunctionCalls(ctx, state);
  typeAllFunctions(ctx, state, { collectChanges: false });
  validateGenericConstructorBodies(ctx, state);
};

const indexGenericFunctionCalls = (
  ctx: TypingContext,
  state: TypingState,
): void => {
  const indexingCtx = createBorrowIndexingContext(ctx);
  for (const fn of ctx.hir.items.values()) {
    if (fn.kind !== "function") {
      continue;
    }
    const signature = ctx.functions.getSignature(fn.symbol);
    if (!signature?.typeParams || signature.typeParams.length === 0) {
      continue;
    }
    const indexedSignature = indexingCtx.functions.getSignature(fn.symbol);
    if (!indexedSignature?.typeParams) {
      continue;
    }
    const substitution = new Map(
      indexedSignature.typeParams.map((param) => [
        param.typeParam,
        param.typeRef,
      ]),
    );
    const diagnosticCheckpoint = ctx.diagnostics.checkpoint();
    const previousMode = state.mode;
    const previousIndexingGenericCalls = state.indexingGenericCalls;
    const previousConstraintCache = state.currentFunctionConstraintCache;
    const previousExprEffects = ctx.effects.snapshotExprEffects();
    state.mode = "relaxed";
    state.indexingGenericCalls = true;
    try {
      typeGenericFunctionBody({
        symbol: fn.symbol,
        signature: indexedSignature,
        substitution,
        retainInstance: false,
        retainResolvedTypes: true,
        ctx: indexingCtx,
        state,
      });
    } catch {
      // Generic bodies are diagnosed when instantiated. This pass only keeps
      // call resolutions that are valid under their symbolic parameters.
    } finally {
      ctx.effects.restoreExprEffects(previousExprEffects);
      state.mode = previousMode;
      state.indexingGenericCalls = previousIndexingGenericCalls;
      state.currentFunctionConstraintCache = previousConstraintCache;
      ctx.diagnostics.restore(diagnosticCheckpoint);
    }
  }
  mergeNestedMaps(ctx.borrowCallTargets, indexingCtx.callResolution.targets);
  mergeNestedMaps(
    ctx.borrowCallArgumentPlans,
    indexingCtx.callResolution.argumentPlans,
  );
  indexingCtx.resolvedExprTypes.forEach((type, expr) =>
    ctx.borrowResolvedExprTypes.set(expr, type),
  );
};

const createBorrowIndexingContext = (
  ctx: TypingContext,
): TypingContext => ({
  ...ctx,
  typeCheckBudget: { ...ctx.typeCheckBudget },
  importsByLocal: new Map(ctx.importsByLocal),
  importAliasesByModule: cloneNestedMap(ctx.importAliasesByModule),
  table: ctx.table.clone(),
  resolvedExprTypes: new Map(),
  valueTypes: new Map(ctx.valueTypes),
  activeValueTypeComputations: new Set(),
  tailResumptions: new Map(),
  callResolution: {
    targets: new Map(),
    argumentPlans: new Map(),
    typeArguments: new Map(),
    instanceKeys: new Map(),
    traitDispatches: new Set(),
  },
  borrowCallTargets: new Map(),
  borrowCallArgumentPlans: new Map(),
  borrowResolvedExprTypes: new Map(),
  functions: ctx.functions.clone(),
  objects: ctx.objects.clone(),
  traits: ctx.traits.clone(),
  typeParameterConstraints: new Map(ctx.typeParameterConstraints),
  typeAliases: ctx.typeAliases.clone(),
  primitives: {
    ...ctx.primitives,
    cache: new Map(ctx.primitives.cache),
  },
  intrinsicTypes: new Map(ctx.intrinsicTypes),
  memberMetadata: new Map(ctx.memberMetadata),
  traitImplsByNominal: new Map(
    Array.from(ctx.traitImplsByNominal, ([nominal, impls]) => [
      nominal,
      [...impls],
    ]),
  ),
  traitImplsByTrait: new Map(
    Array.from(ctx.traitImplsByTrait, ([trait, impls]) => [
      trait,
      [...impls],
    ]),
  ),
  traitMethodImpls: new Map(ctx.traitMethodImpls),
});

const mergeNestedMaps = <Key, InnerKey, Value>(
  target: Map<Key, Map<InnerKey, Value>>,
  source: ReadonlyMap<Key, ReadonlyMap<InnerKey, Value>>,
): void => {
  source.forEach((values, key) => {
    const merged = target.get(key) ?? new Map();
    values.forEach((value, innerKey) => merged.set(innerKey, value));
    target.set(key, merged);
  });
};

const validateGenericConstructorBodies = (
  ctx: TypingContext,
  state: TypingState,
): void => {
  for (const fn of ctx.hir.items.values()) {
    if (fn.kind !== "function") {
      continue;
    }
    const signature = ctx.functions.getSignature(fn.symbol);
    if (!signature?.typeParams || signature.typeParams.length === 0) {
      continue;
    }
    const record = ctx.symbolTable.getSymbol(fn.symbol);
    const metadata = (record.metadata ?? {}) as {
      implTarget?: unknown;
      static?: unknown;
    };
    if (
      record.name !== "init" ||
      metadata.static !== true ||
      typeof metadata.implTarget !== "number"
    ) {
      continue;
    }
    const substitution = new Map(
      signature.typeParams.map((param) => [param.typeParam, param.typeRef]),
    );
    validateGenericFunctionBody({
      symbol: fn.symbol,
      signature,
      substitution,
      ctx,
      state,
    });
  }
};

export const requireInferredReturnTypes = (
  ctx: TypingContext,
): void => {
  const unresolved = Array.from(ctx.functions.signatures).find(
    ([, signature]) => !signature.hasExplicitReturn
  );
  if (!unresolved) {
    return;
  }

  const [symbol] = unresolved;
  const name = ctx.symbolTable.getSymbol(symbol).name;
  const fn = Array.from(ctx.hir.items.values()).find(
    (item) => item.kind === "function" && item.symbol === symbol
  );
  const span = fn?.span ?? ctx.hir.module.span;

  // Note: this is intentionally checked after strict typing so that we report
  // the root cause (e.g. member access issues) before falling back to this.
  return emitDiagnostic({
    ctx,
    code: "TY0034",
    params: { kind: "return-type-inference-failed", functionName: name },
    span: normalizeSpan(span),
  });
};

export const typeAllFunctions = (
  ctx: TypingContext,
  state: TypingState,
  options: { collectChanges: boolean }
): boolean => {
  let changed = false;
  for (const item of ctx.hir.items.values()) {
    if (item.kind !== "function") continue;
    if (item.typeParameters && item.typeParameters.length > 0) {
      continue;
    }
    const updated = typeFunction(item, ctx, state);
    if (options.collectChanges) {
      changed = updated || changed;
    }
  }
  return options.collectChanges ? changed : false;
};

const typeAllModuleLets = (
  ctx: TypingContext,
  state: TypingState,
  options: { collectChanges: boolean },
): boolean => {
  const moduleLets = Array.from(ctx.hir.items.values()).filter(
    (item): item is HirModuleLet => item.kind === "module-let",
  );
  if (moduleLets.length === 0) {
    return false;
  }

  const previousTypes = new Map(
    moduleLets.map((item) => [item.symbol, ctx.valueTypes.get(item.symbol)]),
  );

  moduleLets.forEach((item) => {
    ctx.valueTypes.delete(item.symbol);
  });

  let changed = false;
  moduleLets.forEach((item) => {
    const previous = previousTypes.get(item.symbol);
    const next = getValueType(item.symbol, ctx, {
      span: item.span,
      mode: state.mode,
    });
    if (options.collectChanges && previous !== next) {
      changed = true;
    }
  });

  return options.collectChanges ? changed : false;
};

const typeFunction = (
  fn: HirFunction,
  ctx: TypingContext,
  state: TypingState
): boolean => {
  const signature = ctx.functions.getSignature(fn.symbol);
  if (!signature) {
    throw new Error(`missing type signature for function symbol ${fn.symbol}`);
  }

  if (signature.typeParams && signature.typeParams.length > 0) {
    return false;
  }

  const previousFunction = state.currentFunction;
  state.currentFunction = {
    returnType: signature.returnType,
    instanceKey: formatFunctionInstanceKey(fn.symbol, []),
    typeParams: undefined,
    substitution: undefined,
    memberOf: ctx.memberMetadata.get(fn.symbol)?.owner,
    functionSymbol: fn.symbol,
    observedReturnType: undefined,
  };
  let bodyType;
  let observedReturnType: number | undefined;
  let defaultEffectRows: number[] = [];
  let updated = false;
  try {
    const defaultParameterValues = typeDefaultParameterValues({
      fn,
      signature,
      ctx,
      state,
      typeExpression,
    });
    defaultEffectRows = defaultParameterValues.effectRows;
    if (defaultParameterValues.signatureUpdated) {
      refreshFunctionSignatureType({ fn, signature, ctx });
      updated = true;
    }
    bodyType = typeExpression(fn.body, ctx, state, {
      expectedType: signature.returnType,
    });
    observedReturnType = state.currentFunction?.observedReturnType;
  } finally {
    state.currentFunction = previousFunction;
  }

  const bodyEffectRow = getExprEffectRow(fn.body, ctx);
  const inferredEffectRow =
    defaultEffectRows.length === 0
      ? bodyEffectRow
      : composeEffectRows(ctx.effects, [bodyEffectRow, ...defaultEffectRows]);
  if (signature.annotatedEffects) {
    ensureEffectCompatibility({
      inferred: inferredEffectRow,
      annotated: signature.effectRow ?? ctx.primitives.defaultEffectRow,
      ctx,
      span: fn.span,
      location: fn.ast,
      reason: `function ${ctx.symbolTable.getSymbol(fn.symbol).name} effects`,
    });
  } else if (signature.effectRow !== inferredEffectRow) {
    signature.effectRow = inferredEffectRow;
    updated = true;
  }

  const effectiveReturnType =
    typeof observedReturnType === "number"
      ? mergeBranchType({
          acc: observedReturnType,
          next: bodyType,
          ctx,
          state,
          span: fn.span,
          context: `function ${ctx.symbolTable.getSymbol(fn.symbol).name}`,
        })
      : bodyType;

  if (signature.hasExplicitReturn) {
    ensureTypeMatches(
      effectiveReturnType,
      signature.returnType,
      ctx,
      state,
      `function ${ctx.symbolTable.getSymbol(fn.symbol).name} return type`
    );
    if (updated) {
      refreshFunctionSignatureType({ fn, signature, ctx });
    }
    if (
      state.mode === "strict" &&
      typeof signature.effectRow === "number" &&
      signature.scheme
    ) {
      if (ctx.effects.getFunctionEffect(fn.symbol) === undefined) {
        ctx.effects.setFunctionEffect(fn.symbol, signature.scheme, signature.effectRow);
      }
    }
    return updated;
  }

  if (effectiveReturnType === ctx.primitives.unknown) {
    if (
      state.mode === "strict" &&
      typeof signature.effectRow === "number" &&
      signature.scheme
    ) {
      if (ctx.effects.getFunctionEffect(fn.symbol) === undefined) {
        ctx.effects.setFunctionEffect(fn.symbol, signature.scheme, signature.effectRow);
      }
    }
    return updated;
  }

  finalizeFunctionReturnType(fn, signature, effectiveReturnType, ctx);
  if (
    state.mode === "strict" &&
    typeof signature.effectRow === "number" &&
    signature.scheme
  ) {
    if (ctx.effects.getFunctionEffect(fn.symbol) === undefined) {
      ctx.effects.setFunctionEffect(fn.symbol, signature.scheme, signature.effectRow);
    }
  }
  return true;
};

const clearFunctionInstances = (ctx: TypingContext): void => {
  ctx.functions.resetInstances();
  ctx.callResolution.argumentPlans.clear();
  ctx.callResolution.typeArguments.clear();
  ctx.callResolution.instanceKeys.clear();
};

const finalizeFunctionReturnType = (
  fn: HirFunction,
  signature: FunctionSignature,
  inferred: number,
  ctx: TypingContext
): void => {
  signature.returnType = inferred;
  refreshFunctionSignatureType({ fn, signature, ctx });
  signature.hasExplicitReturn = true;
  signature.annotatedReturn ||= false;
};

const refreshFunctionSignatureType = ({
  fn,
  signature,
  ctx,
}: {
  fn: HirFunction;
  signature: FunctionSignature;
  ctx: TypingContext;
}): void => {
  const functionType = ctx.arena.internFunction({
    parameters: signature.parameters.map(({ type, label, optional, defaulted, bindingKind }) => ({
      type,
      label,
      optional: (optional ?? false) || (defaulted ?? false),
      defaulted: defaulted ?? false,
      bindingKind,
    })),
    returnType: signature.returnType,
    effectRow: signature.effectRow ?? ctx.primitives.defaultEffectRow,
  });
  signature.typeId = functionType;
  ctx.valueTypes.set(fn.symbol, functionType);
  const scheme = ctx.arena.newScheme(
    signature.typeParams?.map((param) => param.typeParam) ?? [],
    functionType
  );
  signature.scheme = scheme;
  ctx.table.setSymbolScheme(fn.symbol, scheme);
};
