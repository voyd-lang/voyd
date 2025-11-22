import { createTypingContext } from "./context.js";
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

  seedPrimitiveTypes(ctx);
  seedBaseObjectType(ctx);
  registerTypeAliases(ctx);
  registerObjectDecls(ctx);
  registerFunctionSignatures(ctx);

  runInferencePass(ctx);
  runStrictTypeCheck(ctx);
  validateTypedProgram(ctx);

  return {
    arena: ctx.arena,
    table: ctx.table,
    resolvedExprTypes: new Map(ctx.resolvedExprTypes),
    valueTypes: new Map(ctx.valueTypes),
    objectsByNominal: new Map(ctx.objectsByNominal),
    callTargets: new Map(ctx.callTargets),
    functionInstances: new Map(ctx.functionInstances),
    callTypeArguments: new Map(ctx.callTypeArguments),
    callInstanceKeys: new Map(ctx.callInstanceKeys),
    functionInstantiationInfo: new Map(
      Array.from(ctx.functionInstantiationInfo.entries()).map(
        ([symbol, instantiations]) => [symbol, new Map(instantiations)]
      )
    ),
    functionInstanceExprTypes: new Map(
      Array.from(ctx.functionInstanceExprTypes.entries()).map(
        ([key, exprs]) => [key, new Map(exprs)]
      )
    ),
  };
};
