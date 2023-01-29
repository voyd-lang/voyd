import { List, isList, Identifier } from "../../../lib/index.mjs";
import { isStruct } from "./is-struct.mjs";
import { typedStructListToStructType } from "./typed-struct-to-struct-type.mjs";

export const getInfoFromRawParam = (list: List) => {
  const isLabeled = !isStruct(list) && isList(list.at(2));
  const paramDef = isLabeled ? (list.at(2) as List) : list;
  const identifier = isStruct(list)
    ? undefined
    : (paramDef.at(1) as Identifier);
  const type = isStruct(list)
    ? typedStructListToStructType(list)
    : (paramDef.at(2)! as Identifier).getTypeOf()!;
  const label = isLabeled ? (list.at(1) as Identifier) : undefined;
  return { identifier, type, label };
};
