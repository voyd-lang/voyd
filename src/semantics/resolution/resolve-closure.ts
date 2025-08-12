import { Closure } from "../../syntax-objects/closure.js";
import { Parameter } from "../../syntax-objects/parameter.js";
import { getExprType } from "./get-expr-type.js";
import { resolveEntities } from "./resolve-entities.js";
import { resolveTypeExpr } from "./resolve-type-expr.js";
import {
  Primitive,
  Type,
  i32,
  f32,
  i64,
  f64,
  bool,
  dVoid,
  dVoyd,
  voydString,
} from "../../syntax-objects/types.js";

export const resolveClosure = (closure: Closure): Closure => {
  if (closure.typesResolved) {
    return closure;
  }

  resolveClosureSignature(closure);

  closure.body = resolveEntities(closure.body);
  closure.inferredReturnType = getExprType(closure.body);
  closure.returnType = closure.annotatedReturnType ?? closure.inferredReturnType;
  closure.typesResolved = true;

  return closure;
};

export const resolveClosureSignature = (closure: Closure) => {
  resolveParameters(closure.parameters);
  if (closure.returnTypeExpr) {
    closure.returnTypeExpr = resolveTypeExpr(closure.returnTypeExpr);
    closure.annotatedReturnType = getExprType(closure.returnTypeExpr);
    closure.returnType = closure.annotatedReturnType;
  }

  return closure;
};

const resolveParameters = (params: Parameter[]) => {
  params.forEach((p) => {
    if (p.type) return;

    if (!p.typeExpr) {
      throw new Error(`Unable to determine type for ${p}`);
    }

    if (p.typeExpr.isIdentifier()) {
      const primMap: Record<string, Type> = {
        i32,
        f32,
        i64,
        f64,
        bool,
        void: dVoid,
        voyd: dVoyd,
        string: voydString,
      };
      const prim = primMap[p.typeExpr.value];
      if (prim) {
        p.type = prim;
        return;
      }
    }
    p.typeExpr = resolveTypeExpr(p.typeExpr);
    p.typeExpr = resolveEntities(p.typeExpr);
    p.type = getExprType(p.typeExpr);
  });
};
