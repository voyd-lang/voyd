import { createTypingContext, createTypingState } from "./context.js";
import { runInferencePass, runStrictTypeCheck } from "./inference.js";
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
} from "./types.js";
import {
  registerImportedObjectTemplate,
  resolveImportedValue,
} from "./imports.js";

export * from "./types.js";

export const runTypingPipeline = (inputs: TypingInputs): TypingResult => {
  const ctx = createTypingContext(inputs);
  const state = createTypingState();

  seedPrimitiveTypes(ctx);
  seedBaseObjectType(ctx);
  primeImportedValues(ctx);
  primeImportedTypes(ctx);
  registerTypeAliases(ctx, state);
  registerObjectDecls(ctx);
  registerTraits(ctx);
  registerFunctionSignatures(ctx, state);
  registerEffectOperations(ctx, state);
  registerImpls(ctx, state);
  indexMemberMetadata(ctx);

  runInferencePass(ctx, state);
  runStrictTypeCheck(ctx, state);
  validateTypedProgram(ctx);

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
    callTargets: new Map(
      Array.from(ctx.callResolution.targets.entries()).map(([callId, targets]) => [
        callId,
        new Map(targets),
      ])
    ),
    functionInstances: ctx.functions.snapshotInstances(),
    callTypeArguments: new Map(ctx.callResolution.typeArguments),
    callInstanceKeys: new Map(ctx.callResolution.instanceKeys),
    callTraitDispatches: new Set(ctx.callResolution.traitDispatches),
    functionInstantiationInfo: ctx.functions.snapshotInstantiationInfo(),
    functionInstanceExprTypes: ctx.functions.snapshotInstanceExprTypes(),
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
    diagnostics: ctx.diagnostics.diagnostics,
  };
};

const primeImportedValues = (ctx: TypingContext): void => {
  ctx.importsByLocal.forEach((target, symbol) => {
    const record = ctx.symbolTable.getSymbol(symbol);
    if (record.kind !== "value") {
      return;
    }
    if (!target) {
      return;
    }
    resolveImportedValue({ symbol, ctx });
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
    registerImportedObjectTemplate({
      dependency,
      dependencySymbol: target.symbol,
      localSymbol: symbol,
      ctx,
    });
  });
};
