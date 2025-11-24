import { createTypingContext, createTypingState } from "./context.js";
import { runInferencePass, runStrictTypeCheck } from "./inference.js";
import {
  registerFunctionSignatures,
  registerObjectDecls,
  registerTypeAliases,
  seedBaseObjectType,
  seedPrimitiveTypes,
} from "./registry.js";
import { validateTypedProgram } from "./validation.js";
import type { TypingInputs, TypingResult } from "./types.js";

export * from "./types.js";

export const runTypingPipeline = (inputs: TypingInputs): TypingResult => {
  const ctx = createTypingContext(inputs);
  const state = createTypingState();

  seedPrimitiveTypes(ctx);
  seedBaseObjectType(ctx);
  registerTypeAliases(ctx, state);
  registerObjectDecls(ctx);
  registerFunctionSignatures(ctx, state);

  runInferencePass(ctx, state);
  runStrictTypeCheck(ctx, state);
  validateTypedProgram(ctx);

  return {
    arena: ctx.arena,
    table: ctx.table,
    resolvedExprTypes: new Map(ctx.resolvedExprTypes),
    valueTypes: new Map(ctx.valueTypes),
    objectsByNominal: new Map(ctx.objects.byNominal),
    callTargets: new Map(
      Array.from(ctx.callResolution.targets.entries()).map(([callId, targets]) => [
        callId,
        new Map(targets),
      ])
    ),
    functionInstances: new Map(ctx.functions.instances),
    callTypeArguments: new Map(ctx.callResolution.typeArguments),
    callInstanceKeys: new Map(ctx.callResolution.instanceKeys),
    functionInstantiationInfo: new Map(
      Array.from(ctx.functions.instantiationInfo.entries()).map(
        ([symbol, instantiations]) => [symbol, new Map(instantiations)]
      )
    ),
    functionInstanceExprTypes: new Map(
      Array.from(ctx.functions.instanceExprTypes.entries()).map(
        ([key, exprs]) => [key, new Map(exprs)]
      )
    ),
  };
};
