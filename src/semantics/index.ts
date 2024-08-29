import { checkTypes } from "./check-types.js";
import { initPrimitiveTypes } from "./init-primitive-types.js";
import { initEntities } from "./init-entities.js";
import { TypeChecker } from "./types.js";

const typePhases: TypeChecker[] = [
  initPrimitiveTypes,
  initEntities,
  checkTypes,
];

export const typeCheck: TypeChecker = (expr) =>
  typePhases.reduce((expr, checker) => checker(expr), expr);
