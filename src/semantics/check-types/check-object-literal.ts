import { ObjectLiteral } from "../../syntax-objects/object-literal.js";
import { checkTypes } from "./check-types.js";

export const checkObjectLiteralType = (obj: ObjectLiteral) => {
  // Debug: trace object literal checks during VSX run
  if (process.env.VOYD_DEBUG?.includes("vsx")) {
    console.warn(`checkObjectLiteralType at ${obj.location}`);
  }
  obj.fields.forEach((field) => checkTypes(field.initializer));
  return obj;
};
