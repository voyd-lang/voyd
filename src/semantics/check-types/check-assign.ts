import { Call } from "../../syntax-objects/call.js";
import { getExprType } from "../resolution/get-expr-type.js";
import { typesAreCompatible } from "../resolution/index.js";
import { checkTypes } from "./check-types.js";

export const checkAssign = (call: Call) => {
  const id = call.argAt(0);
  if (!id?.isIdentifier()) {
    if (id?.isCall() && id.calls("member-access")) {
      checkFieldAssignmentMutability(id);
    }

    return call;
  }

  const variable = id.resolve();
  if (!variable || !variable.isVariable()) {
    throw new Error(`Unrecognized variable ${id} at ${id.location}`);
  }

  if (!variable.isMutable) {
    throw new Error(`${id} cannot be re-assigned at ${id.location}`);
  }

  const initExpr = call.argAt(1);
  checkTypes(initExpr);
  const initType = getExprType(initExpr);

  if (!typesAreCompatible(variable.type, initType)) {
    const variableTypeName = variable.type?.name.value ?? "unknown";
    const initTypeName = initType?.name.value ?? "unknown";
    const location = call.location ?? id.location;
    throw new Error(
      `Cannot assign ${initTypeName} to variable ${id} of type ${variableTypeName} at ${location}`
    );
  }

  return call;
};

// Check to see if this is a member access assignment to a non-mutable reference
const checkFieldAssignmentMutability = (call: Call): Call => {
  const obj = call.argAt(0);
  if (obj) checkTypes(obj);
  const identifier = obj?.isIdentifier() ? obj : undefined;
  const entity = identifier?.resolve();
  if (entity?.isVariable() || entity?.isParameter()) {
    if (!entity.getAttribute("isMutableRef")) {
      console.warn(`${identifier} is not mutable at ${identifier?.location}`);
    }
  }
  return call;
};
