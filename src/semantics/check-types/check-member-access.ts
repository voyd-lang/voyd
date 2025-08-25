import { Call } from "../../syntax-objects/call.js";
import { checkTypes } from "./check-types.js";

export const checkMemberAccess = (call: Call): Call => {
  const obj = call.argAt(0);
  if (obj) {
    call.args.set(0, checkTypes(obj));
  }

  const parent = call.parent;
  if (parent?.isCall() && parent.calls("=") && parent.argAt(0) === call) {
    const entity = obj?.isIdentifier() ? obj.resolve() : undefined;
    if (entity && (entity.isVariable() || entity.isParameter())) {
      if (!entity.hasAttribute("mutable")) {
        console.warn(`${entity.name} is not mutable at ${call.location}`);
      }
    }
  }

  return call;
};
