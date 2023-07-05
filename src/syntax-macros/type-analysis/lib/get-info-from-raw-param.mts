import { List, Identifier } from "../../../lib/index.mjs";
import { isStruct } from "./is-struct.mjs";
import { typedStructListToStructType } from "./typed-struct-to-struct-type.mjs";

export const getInfoFromRawParam = (list: List) => {
  const isLabeled = !isStruct(list) && list.at(2)?.isList();
  const paramDef = isLabeled ? (list.at(2) as List) : list;
  const name = isStruct(list) ? undefined : (paramDef.at(1) as Identifier);
  const type = isStruct(list)
    ? typedStructListToStructType(list)
    : (paramDef.at(2)! as Identifier).resolve();

  if (!type?.isType()) {
    throw new Error(`Could not resolve type for parameter ${name}`);
  }

  const label = isLabeled ? (list.at(1) as Identifier) : undefined;
  return { name, type, label };
};
