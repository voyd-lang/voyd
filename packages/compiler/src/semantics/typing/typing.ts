import { createTypingContext, createTypingState } from "./context.js";
import { requireInferredReturnTypes, runInferencePass, runStrictTypeCheck } from "./inference.js";
import {
  registerFunctionSignatures,
  registerObjectDecls,
  registerTraits,
  registerTypeAliases,
  seedBaseObjectType,
  seedPrimitiveTypes,
  registerImpls,
  registerEffectOperations,
} from "./registry.js";
import { indexMemberMetadata } from "./members.js";
import { validateTypedProgram } from "./validation.js";
import type {
  TypingContext,
  TypingInputs,
  TypingResult,
  TypingState,
} from "./types.js";
import {
  registerImportedObjectTemplate,
} from "./imports.js";
import { cloneNestedMap } from "./call-resolution.js";
import { ensureImportedOwnerTemplatesAvailable } from "./import-owner-templates.js";
import {
  getObjectTemplate,
  refreshTraitImplInstances,
  resolveTypeAlias,
} from "./type-system.js";
import { DiagnosticError, type Diagnostic } from "../../diagnostics/index.js";
import { hydrateImportedTraitMetadataForDependencySymbol } from "./import-trait-impl-hydration.js";
import { hydrateImportedValueLikeSymbol } from "./import-hydration.js";

export * from "./types.js";

export const runTypingPipeline = (inputs: TypingInputs): TypingResult => {
  const ctx = createTypingContext(inputs);
  const state = createTypingState();
  const recoverDiagnosticErrors = inputs.recoverDiagnosticErrors === true;

  try {
    seedPrimitiveTypes(ctx);
    seedBaseObjectType(ctx);
    primeImportedValues(ctx);
    registerTypeAliases(ctx, state);
    registerObjectDecls(ctx);
    primeValueObjectTemplates(ctx, state);
    registerTraits(ctx);
    primeImportedTypes(ctx);
    primeTypeAliases(ctx, state);
    registerFunctionSignatures(ctx, state);
    registerEffectOperations(ctx, state);
    registerImpls(ctx, state);
    refreshTraitImplInstances(ctx, state);
    indexMemberMetadata(ctx);

    runInferencePass(ctx, state);
    runStrictTypeCheck(ctx, state);
    hydrateImportedOwnerTemplatesForInferredTypes(ctx);
    refreshTraitImplInstances(ctx, state);
    requireInferredReturnTypes(ctx);
    validateTypedProgram(ctx);
  } catch (error) {
    if (!(error instanceof DiagnosticError) || !recoverDiagnosticErrors) {
      throw error;
    }
    return snapshotTypingResult({
      ctx,
      diagnostics: mergeDiagnostics(
        ctx.diagnostics.diagnostics,
        error.diagnostics,
      ),
    });
  }

  return snapshotTypingResult({ ctx });
};

const snapshotTypingResult = ({
  ctx,
  diagnostics,
}: {
  ctx: TypingContext;
  diagnostics?: readonly Diagnostic[];
}): TypingResult => {
  return {
    arena: ctx.arena,
    table: ctx.table,
    functions: ctx.functions,
    typeAliases: ctx.typeAliases,
    objects: ctx.objects,
    traits: ctx.traits,
    primitives: ctx.primitives,
    effects: ctx.effects,
    intrinsicTypes: ctx.intrinsicTypes,
    resolvedExprTypes: new Map(ctx.resolvedExprTypes),
    valueTypes: new Map(ctx.valueTypes),
    tailResumptions: new Map(ctx.tailResumptions),
    objectsByNominal: ctx.objects.snapshotByNominal(),
    callTargets: cloneNestedMap(ctx.callResolution.targets),
    callArgumentPlans: cloneNestedMap(ctx.callResolution.argumentPlans),
    functionInstances: ctx.functions.snapshotInstances(),
    callTypeArguments: cloneNestedMap(ctx.callResolution.typeArguments),
    callInstanceKeys: cloneNestedMap(ctx.callResolution.instanceKeys),
    callTraitDispatches: new Set(ctx.callResolution.traitDispatches),
    functionInstantiationInfo: ctx.functions.snapshotInstantiationInfo(),
    functionInstanceExprTypes: ctx.functions.snapshotInstanceExprTypes(),
    functionInstanceValueTypes: ctx.functions.snapshotInstanceValueTypes(),
    traitImplsByNominal: new Map(
      Array.from(ctx.traitImplsByNominal.entries()).map(([nominal, impls]) => [
        nominal,
        impls,
      ])
    ),
    traitImplsByTrait: new Map(
      Array.from(ctx.traitImplsByTrait.entries()).map(([symbol, impls]) => [
        symbol,
        impls,
      ])
    ),
    traitMethodImpls: new Map(ctx.traitMethodImpls),
    memberMetadata: new Map(ctx.memberMetadata),
    diagnostics: diagnostics ?? ctx.diagnostics.diagnostics,
  };
};

const mergeDiagnostics = (
  primary: readonly Diagnostic[],
  secondary: readonly Diagnostic[],
): readonly Diagnostic[] => {
  const seen = new Set(
    primary.map(
      (diagnostic) =>
        `${diagnostic.code}:${diagnostic.span.file}:${diagnostic.span.start}:${diagnostic.span.end}:${diagnostic.message}`,
    ),
  );
  const merged = [...primary];
  secondary.forEach((diagnostic) => {
    const key = `${diagnostic.code}:${diagnostic.span.file}:${diagnostic.span.start}:${diagnostic.span.end}:${diagnostic.message}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    merged.push(diagnostic);
  });
  return merged;
};

const primeTypeAliases = (ctx: TypingContext, state: TypingState): void => {
  for (const template of ctx.typeAliases.templates()) {
    if (template.params.length > 0) {
      continue;
    }
    resolveTypeAlias(template.symbol, ctx, state, []);
  }
};

const primeValueObjectTemplates = (
  ctx: TypingContext,
  state: TypingState,
): void => {
  for (const item of ctx.hir.items.values()) {
    if (item.kind !== "object" || item.objectKind !== "value") {
      continue;
    }
    getObjectTemplate(item.symbol, ctx, state);
  }
};

const primeImportedValues = (ctx: TypingContext): void => {
  ctx.importsByLocal.forEach((_target, symbol) => {
    hydrateImportedValueLikeSymbol({ symbol, ctx });
  });
};

const primeImportedTypes = (ctx: TypingContext): void => {
  ctx.importsByLocal.forEach((target, symbol) => {
    const record = ctx.symbolTable.getSymbol(symbol);
    if (record.kind !== "type") {
      return;
    }
    if (!target) {
      return;
    }
    const dependency = ctx.dependencies.get(target.moduleId);
    if (!dependency) {
      return;
    }
    hydrateImportedTraitMetadataForDependencySymbol({
      dependency,
      dependencySymbol: target.symbol,
      localSymbol: symbol,
      ctx,
    });
    registerImportedObjectTemplate({
      dependency,
      dependencySymbol: target.symbol,
      localSymbol: symbol,
      ctx,
    });
  });
};

const hydrateImportedOwnerTemplatesForInferredTypes = (
  ctx: TypingContext,
): void => {
  const collected = new Set<number>();
  const add = (typeId: number | undefined): void => {
    if (typeof typeId === "number") {
      collected.add(typeId);
    }
  };

  Array.from(ctx.table.entries()).forEach(([, typeId]) => add(typeId));
  ctx.resolvedExprTypes.forEach((typeId) => add(typeId));
  ctx.valueTypes.forEach((typeId) => add(typeId));

  Array.from(ctx.functions.signatures, ([, signature]) => signature).forEach((signature) => {
    add(signature.typeId);
    add(signature.returnType);
    signature.parameters.forEach((param) => add(param.type));
    signature.typeParams?.forEach((param) => {
      add(param.constraint);
      add(param.typeRef);
    });
  });

  ctx.functions.snapshotInstances().forEach((typeId) => add(typeId));
  ctx.functions.snapshotInstanceExprTypes().forEach((entries) =>
    entries.forEach((typeId) => add(typeId)),
  );
  ctx.functions.snapshotInstanceValueTypes().forEach((entries) =>
    entries.forEach((typeId) => add(typeId)),
  );

  ensureImportedOwnerTemplatesAvailable({
    types: Array.from(collected),
    ctx,
  });
};
