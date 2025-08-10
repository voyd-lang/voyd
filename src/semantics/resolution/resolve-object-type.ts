import { Call } from "../../syntax-objects/call.js";
import { ObjectType } from "../../syntax-objects/types.js";
import { resolveGenericObjVersion } from "./resolve-generic-object.js";
import { resolveObjectTypePure } from "./resolve-object-type-pure.js";

export const resolveObjectType = (obj: ObjectType, call?: Call): ObjectType => {
  if (obj.typesResolved) return obj;

  if (obj.typeParameters) {
    return resolveGenericObjVersion(obj, call) ?? resolveObjectTypePure(obj);
  }

  return resolveObjectTypePure(obj);
};
