import { evalTypes } from "./check-types.mjs";
import { initPrimitiveTypes } from "./init-primitive-types.mjs";
import { registerEntities } from "./register-entities.mjs";
import { TypeChecker } from "./types";

const typePhases: TypeChecker[] = [
  initPrimitiveTypes,
  registerEntities,
  evalTypes,
];

export const typeCheck: TypeChecker = (expr) => {
  typePhases.forEach((checker) => checker(expr));
  return expr;
};
