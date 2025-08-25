import { Call } from "../../syntax-objects/call.js";
import { getExprType } from "../resolution/get-expr-type.js";
import { typesAreCompatible } from "../resolution/index.js";
import { checkTypes } from "./check-types.js";

export const checkAssign = (call: Call) => {
  const id = call.argAt(0);
  if (id?.isCall() && id.calls("member-access")) {
    checkTypes(id);
    return call;
  }
  if (!id?.isIdentifier()) {
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

