import { Block } from "../../syntax-objects/block.js";
import { checkTypes } from "./check-types.js";

export const checkBlockTypes = (block: Block): Block => {
  block.body = block.body.map(checkTypes);
  return block;
};
