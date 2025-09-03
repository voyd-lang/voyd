import { checkTypes } from "./check-types/index.js";
import { initPrimitiveTypes } from "./init-primitive-types.js";
import { initEntities } from "./init-entities.js";
import { SemanticProcessor } from "./types.js";
import { registerModules } from "./modules.js";
import { expandRegularMacros } from "./regular-macros.js";
import type { ParsedModule } from "../parser/utils/parse-module.js";
import { Expr } from "../syntax-objects/expr.js";
import { resolveEntities } from "./resolution/resolve-entities.js";

const semanticPhases: SemanticProcessor[] = [
  expandRegularMacros, // Also handles use and module declaration initialization
  initPrimitiveTypes,
  initEntities,
  resolveEntities,
  checkTypes,
];

export const processSemantics = (parsedModule: ParsedModule): Expr => {
  const expr = registerModules(parsedModule);
  return semanticPhases.reduce((e, checker) => checker(e), expr as Expr);
};
