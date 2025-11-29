import { Closure } from "../../syntax-objects/closure.js";
import { Parameter } from "../../syntax-objects/parameter.js";
import { FnType } from "../../syntax-objects/types.js";
import { Call } from "../../syntax-objects/call.js";
import { Identifier } from "../../syntax-objects/identifier.js";
import { List } from "../../syntax-objects/list.js";
import { getExprType } from "./get-expr-type.js";
import { resolveEntities } from "./resolve-entities.js";
import { resolveTypeExpr } from "./resolve-type-expr.js";

export const resolveClosure = (closure: Closure): Closure => {
  if (closure.typesResolved) {
    return closure;
  }

  resolveClosureSignature(closure);

  closure.captures = [];
  closure.body = resolveEntities(closure.body);
  closure.inferredReturnType = getExprType(closure.body);
  if (
    closure.annotatedReturnType?.isPrimitiveType() &&
    (closure.annotatedReturnType.name.value === "void" ||
      closure.annotatedReturnType.name.value === "voyd")
  ) {
    closure.inferredReturnType = closure.annotatedReturnType;
  }
  closure.returnType =
    closure.annotatedReturnType ?? closure.inferredReturnType;
  closure.typesResolved =
    closure.returnType && closure.parameters.every((p) => p.type);

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
  params.forEach((p, i) => {
    if (p.type) return;

    const callSiteSignature = p.parentFn?.getAttribute("parameterFnType") as
      | FnType
      | undefined;

    if (!p.typeExpr && callSiteSignature) {
      const csp = callSiteSignature.parameters.at(i);
      p.type = csp?.type;
      if (p.type) return;
    }

    if (!p.typeExpr) return;
    if (p.isOptional) {
      p.typeExpr = new Call({
        ...p.typeExpr.metadata,
        fnName: Identifier.from("Optional"),
        args: new List({ value: [] }),
        typeArgs: new List({ value: [p.typeExpr] }),
      });
    }

    p.typeExpr = resolveTypeExpr(p.typeExpr);
    p.type = getExprType(p.typeExpr);
  });
};
