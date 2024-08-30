import { checkTypes } from "./check-types.js";
import { initPrimitiveTypes } from "./init-primitive-types.js";
import { initEntities } from "./init-entities.js";
import { SemanticProcessor } from "./types.js";
import { registerModules } from "./modules.js";
import { expandRegularMacros } from "./regular-macros.js";
import { ParsedModule } from "../parser/index.js";
import { Expr } from "../syntax-objects/expr.js";

const semanticPhases: SemanticProcessor[] = [
  expandRegularMacros,
  initPrimitiveTypes,
  initEntities,
  checkTypes,
];

export const processSemantics = (parsedModule: ParsedModule): Expr => {
  const expr = registerModules(parsedModule);
  return semanticPhases.reduce((e, checker) => checker(e), expr as Expr);
};
