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
} from "./registry.js";
import { validateTypedProgram } from "./validation.js";
import type {
  TypingContext,
  TypingInputs,
  TypingResult,
} from "./types.js";
import { resolveImportedValue } from "./imports.js";

export * from "./types.js";

export const runTypingPipeline = (inputs: TypingInputs): TypingResult => {
  const ctx = createTypingContext(inputs);
  const state = createTypingState();

  seedPrimitiveTypes(ctx);
  seedBaseObjectType(ctx);
  primeImportedValues(ctx);
  registerTypeAliases(ctx, state);
  registerObjectDecls(ctx);
  registerTraits(ctx);
  registerFunctionSignatures(ctx, state);
  registerImpls(ctx, state);

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
    intrinsicTypes: ctx.intrinsicTypes,
    resolvedExprTypes: new Map(ctx.resolvedExprTypes),
    valueTypes: new Map(ctx.valueTypes),
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
    functionInstantiationInfo: ctx.functions.snapshotInstantiationInfo(),
    functionInstanceExprTypes: ctx.functions.snapshotInstanceExprTypes(),
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
