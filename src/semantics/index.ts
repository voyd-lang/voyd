import { checkTypes } from "./check-types/index.js";
import { initPrimitiveTypes } from "./init-primitive-types.js";
import { initEntities } from "./init-entities.js";
import { registerModules } from "./modules.js";
import { expandFunctionalMacros } from "./functional-macros.js";
import type { ParsedModule } from "../parser/utils/parse-module.js";
import { Expr } from "../syntax-objects/expr.js";
import { resolveEntities } from "./resolution/resolve-entities.js";
import { canonicalizeResolvedTypes } from "./types/canonicalize-resolved-types.js";
import { VoydModule } from "../syntax-objects/module.js";
import {
  createTypeContext,
  runWithTypeContext,
  type SemanticsTypeContext,
  type TypeContextTelemetry,
} from "./types/type-context.js";

const flagEnabled = (value: string | undefined): boolean => {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return false;
  if (["0", "false", "off", "no"].includes(normalized)) return false;
  if (["1", "true", "on", "yes"].includes(normalized)) return true;
  return false;
};

const ENV_USE_TYPE_INTERNER = flagEnabled(process.env.VOYD_USE_TYPE_INTERNER);
const ENV_RECORD_TYPE_EVENTS = flagEnabled(
  process.env.VOYD_TYPE_INTERNER_EVENTS
);

export type ProcessSemanticsOptions = {
  useTypeInterner?: boolean;
  recordTypeInternerEvents?: boolean;
  typeContext?: SemanticsTypeContext;
  onTypeContextTelemetry?: (telemetry: TypeContextTelemetry) => void;
};

const semanticPipeline = (expr: Expr): Expr =>
  [
    expandFunctionalMacros,
    initPrimitiveTypes,
    initEntities,
    resolveEntities,
  ].reduce((acc, phase) => phase(acc), expr);

export const processSemantics = (
  parsedModule: ParsedModule,
  options: ProcessSemanticsOptions = {}
): Expr => {
  const envUseInterner = options.typeContext?.useInterner ?? ENV_USE_TYPE_INTERNER;
  const useTypeInterner = options.useTypeInterner ?? envUseInterner;
  const recordEvents =
    options.recordTypeInternerEvents ?? ENV_RECORD_TYPE_EVENTS;

  const context =
    options.typeContext ??
    createTypeContext({
      useInterner: useTypeInterner,
      recordEvents: useTypeInterner && recordEvents,
    });

  try {
    const result = runWithTypeContext(context, () => {
      const expr = registerModules(parsedModule);
      const resolved = semanticPipeline(expr as Expr);
      const checked = checkTypes(resolved as VoydModule);

      if (context?.useInterner) {
        canonicalizeResolvedTypes(checked as VoydModule, {
          onType: (type) => context.register(type),
        });
      } else {
        canonicalizeResolvedTypes(checked as VoydModule);
      }

      return checked as VoydModule;
    });
    return result;
  } finally {
    if (options.onTypeContextTelemetry) {
      options.onTypeContextTelemetry(context.getTelemetry());
    }
  }
};
