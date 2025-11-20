import { createTypingContext } from "./context.js";
import { runInferencePass, runStrictTypeCheck } from "./inference.js";
import {
  registerFunctionSignatures,
  registerObjectDecls,
  registerTypeAliases,
  seedBaseObjectType,
  seedPrimitiveTypes,
} from "./registry.js";
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

  return {
    arena: ctx.arena,
    table: ctx.table,
    valueTypes: new Map(ctx.valueTypes),
    callTargets: new Map(ctx.callTargets),
  };
};
