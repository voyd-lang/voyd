import { Fn } from "../../syntax-objects/fn.js";
import { typesAreCompatible } from "../resolution/index.js";
import { canonicalType } from "../types/canonicalize.js";
import { typeKey } from "../types/type-key.js";
import { checkParameters } from "./check-parameters.js";
import { checkTypes } from "./check-types.js";
import { checkTypeExpr, checkTypeExprAllowTypeParams } from "./check-type-expr.js";
import { resolveFnSignature } from "../resolution/resolve-fn.js";

export const checkFnTypes = (fn: Fn): Fn => {
  if (fn.genericInstances) {
    fn.genericInstances.forEach(checkFnTypes);
    return fn;
  }

  // If the function has type parameters and not genericInstances, it isn't in use and wont be compiled.
  // However, we still want to validate that its signature's type expressions
  // are well-formed (i.e., no unknown type identifiers), allowing unresolved
  // type parameters.
  if (fn.typeParameters) {
    // Ensure parameter/return type expressions are resolved enough to inspect
    resolveFnSignature(fn);
    const allowed = new Set(fn.typeParameters.map((p) => p.value));
    fn.parameters.forEach((p) => {
      if (!p.typeExpr) return; // untyped param is fine here
      checkTypeExprAllowTypeParams(p.typeExpr, allowed);
    });
    if (fn.returnTypeExpr) {
      checkTypeExprAllowTypeParams(fn.returnTypeExpr, allowed);
    }
    return fn;
  }

  checkParameters(fn.parameters);
  checkTypes(fn.body);

  if (fn.returnTypeExpr) {
    checkTypeExpr(fn.returnTypeExpr);
  }

  if (!fn.returnType) {
    throw new Error(
      `Unable to determine return type for ${fn.name} at ${fn.location}`
    );
  }

  const inferredReturnType = fn.inferredReturnType
    ? canonicalType(fn.inferredReturnType)
    : undefined;
  const annotatedReturnType = fn.returnType
    ? canonicalType(fn.returnType)
    : undefined;

  if (
    inferredReturnType &&
    annotatedReturnType &&
    !typesAreCompatible(inferredReturnType, annotatedReturnType)
  ) {
    if (annotatedReturnType.isUnionType?.()) {
      const actualKey = typeKey(inferredReturnType);
      const matchesBranch = annotatedReturnType.types.some((branch) => {
        const branchKey = typeKey(canonicalType(branch));
        return (
          branchKey === actualKey ||
          branchKey.includes(actualKey) ||
          actualKey.includes(branchKey)
        );
      });
      if (matchesBranch) return fn;
    }
    throw new Error(
      `Fn, ${fn.name}, return value type (${inferredReturnType?.name}) is not compatible with annotated return type (${annotatedReturnType?.name}) at ${fn.location}`
    );
  }

  return fn;
};
