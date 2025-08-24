import { Call } from "../../syntax-objects/call.js";
import { getExprType } from "../resolution/get-expr-type.js";
import { typesAreCompatible } from "../resolution/index.js";
import { checkTypes } from "./check-types.js";

export const checkAssign = (call: Call) => {
  const target = call.argAt(0);
  checkTypes(target);

  if (target?.isIdentifier()) {
    const variable = target.resolve();
    if (!variable || !variable.isVariable()) {
      throw new Error(`Unrecognized variable ${target} at ${target.location}`);
    }

    if (!variable.isMutable) {
      throw new Error(`${target} cannot be re-assigned at ${target.location}`);
    }

    const initExpr = call.argAt(1);
    checkTypes(initExpr);
    const initType = getExprType(initExpr);

    if (!typesAreCompatible(variable.type, initType)) {
      const variableTypeName = variable.type?.name.value ?? "unknown";
      const initTypeName = initType?.name.value ?? "unknown";
      const location = call.location ?? target.location;
      throw new Error(
        `Cannot assign ${initTypeName} to variable ${target} of type ${variableTypeName} at ${location}`
      );
    }

    return call;
  }

  if (target?.isCall() && target.calls("member-access")) {
    ensureMemberAccessIsMutable(target);
    const initExpr = call.argAt(1);
    checkTypes(initExpr);
    const fieldType = getExprType(target);
    const initType = getExprType(initExpr);
    if (!typesAreCompatible(fieldType, initType)) {
      const fieldTypeName = fieldType?.name.value ?? "unknown";
      const initTypeName = initType?.name.value ?? "unknown";
      const location = call.location ?? target.location;
      throw new Error(
        `Cannot assign ${initTypeName} to field of type ${fieldTypeName} at ${location}`
      );
    }
    return call;
  }

  return call;
};

const ensureMemberAccessIsMutable = (access: Call) => {
  let current: Call | undefined = access;
  while (current && current.calls("member-access")) {
    const obj = current.argAt(0);
    const objType = getExprType(obj);
    if (objType && !objType.hasAttribute("mutable")) {
      const loc = obj?.location ?? current.location;
      throw new Error(`${obj} is not mutable at ${loc}`);
    }
    current = obj?.isCall() && obj.calls("member-access") ? obj : undefined;
  }
};

