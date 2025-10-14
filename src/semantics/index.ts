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

export const processSemantics = (parsedModule: ParsedModule): Expr => {
  const expr = registerModules(parsedModule);
  const resolved = [expandFunctionalMacros, initPrimitiveTypes, initEntities, resolveEntities].reduce(
    (acc, phase) => phase(acc),
    expr as Expr
  );
  const checked = checkTypes(resolved as VoydModule);
  canonicalizeResolvedTypes(checked as VoydModule);
  return checked as VoydModule;
};
