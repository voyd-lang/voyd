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
import { isCanonicalizationEnabled } from "./types/canonicalization-feature.js";

export const processSemantics = (parsedModule: ParsedModule): Expr => {
  const expr = registerModules(parsedModule);
  const resolved = [expandFunctionalMacros, initPrimitiveTypes, initEntities, resolveEntities].reduce(
    (acc, phase) => phase(acc),
    expr as Expr
  );
  const canonicalBeforeCheck = isCanonicalizationEnabled()
    ? canonicalizeResolvedTypes(resolved as VoydModule)
    : resolved;
  const checked = checkTypes(canonicalBeforeCheck);
  if (!isCanonicalizationEnabled()) return checked;
  return canonicalizeResolvedTypes(checked as VoydModule);
};
