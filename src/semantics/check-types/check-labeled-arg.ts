import { Call } from "../../syntax-objects/call.js";
import { checkTypes } from "./check-types.js";

export const checkLabeledArg = (call: Call) => {
  const expr = call.argAt(1);
  checkTypes(expr);
  return call;
};

