import { List } from "../../syntax-objects/list.js";
import { checkTypes } from "./check-types.js";

export const checkListTypes = (list: List) => {
  return list.map(checkTypes);
};

