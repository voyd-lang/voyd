import { ObjectLiteral } from "../../syntax-objects/object-literal.js";
import { checkTypes } from "./check-types.js";

export const checkObjectLiteralType = (obj: ObjectLiteral) => {
  obj.fields.forEach((field) => checkTypes(field.initializer));
  return obj;
};

