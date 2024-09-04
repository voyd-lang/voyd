import binaryen from "binaryen";
import { ExpressionRef, TypeRef } from "../lib/binaryen-gc/types.js";

export const returnCall = (
  mod: binaryen.Module,
  fnId: string,
  args: ExpressionRef[],
  returnType: TypeRef
) => {
  return mod.return_call(fnId, args, returnType);
};
