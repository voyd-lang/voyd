import { inferTypes } from "./infer-types.mjs";
import { initPrimitiveTypes } from "./init-primitive-types.mjs";
import { registerAnnotatedTypes } from "./register-annotated-types.mjs";
import { TypeChecker } from "./types";

const typePhases: TypeChecker[] = [
  initPrimitiveTypes,
  registerAnnotatedTypes,
  inferTypes,
];

export const typeCheck: TypeChecker = (expr) => {
  typePhases.forEach((checker) => checker(expr));
  return expr;
};
