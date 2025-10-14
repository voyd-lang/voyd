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
  withTypeContext,
  type TypeContextTelemetry,
} from "./types/type-context.js";
import { type TypeInternerOptions } from "./types/type-interner.js";

export type ProcessSemanticsOptions = {
  types?: {
    useInterner?: boolean;
    internerOptions?: TypeInternerOptions;
    onTelemetry?: (telemetry: TypeContextTelemetry) => void;
  };
};

export const processSemantics = (
  parsedModule: ParsedModule,
  options: ProcessSemanticsOptions = {}
): Expr => {
  const typeContext = createTypeContext({
    useInterner: options.types?.useInterner ?? false,
    internerOptions: options.types?.internerOptions,
  });

  const result = withTypeContext(typeContext, () => {
    const expr = registerModules(parsedModule);
    const resolved = [
      expandFunctionalMacros,
      initPrimitiveTypes,
      initEntities,
      resolveEntities,
    ].reduce((acc, phase) => phase(acc), expr as Expr);
    const checked = checkTypes(resolved as VoydModule);
    canonicalizeResolvedTypes(checked as VoydModule, {
      onType: typeContext.useInterner
        ? (type) => typeContext.internType(type)
        : undefined,
    });
    return checked as VoydModule;
  });

  if (typeContext.useInterner && options.types?.onTelemetry) {
    const telemetry = typeContext.getTelemetry();
    if (telemetry) options.types.onTelemetry(telemetry);
  }

  return result;
};
