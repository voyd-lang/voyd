import { checkTypes } from "./check-types.mjs";
import { initPrimitiveTypes } from "./init-primitive-types.mjs";
import { initEntities } from "./init-entities.mjs";
import { TypeChecker } from "./types";

const typePhases: TypeChecker[] = [
  initPrimitiveTypes,
  initEntities,
  checkTypes,
];

export const typeCheck: TypeChecker = (expr) => {
  typePhases.forEach((checker) => checker(expr));
  return expr;
};
