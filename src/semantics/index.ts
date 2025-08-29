import { checkTypes } from "./check-types/index.js";
import { initPrimitiveTypes } from "./init-primitive-types.js";
import { initEntities } from "./init-entities.js";
import { SemanticProcessor } from "./types.js";
import { registerModules } from "./modules.js";
import { expandRegularMacros } from "./regular-macros.js";
import { ParsedModule } from "../parser/index.js";
import { Expr } from "../syntax-objects/expr.js";
import { resolveEntities } from "./resolution/resolve-entities.js";
import { VoydModule } from "../syntax-objects/module.js";

const semanticPhases: SemanticProcessor[] = [
  expandRegularMacros, // Also handles use and module declaration initialization
  initPrimitiveTypes,
  initEntities,
  resolveEntities,
  checkTypes,
];

export const processSemantics = (
  parsedModule: ParsedModule,
  rootModule?: VoydModule
): Expr => {
  const expr = registerModules(parsedModule, rootModule);
  return semanticPhases.reduce((e, checker) => checker(e), expr as Expr);
};
