import {
  CompileExprOpts,
  buildObjectType,
  buildUnionType,
  buildIntersectionType,
} from "../codegen.js";
import { Type } from "../syntax-objects/types.js";

export const compile = (opts: CompileExprOpts<Type>) => {
  const type = opts.expr;

  if (type.isObj()) {
    buildObjectType(opts, type);
    return opts.mod.nop();
  }

  if (type.isUnionType()) {
    buildUnionType(opts, type);
    return opts.mod.nop();
  }

  if (type.isIntersectionType()) {
    buildIntersectionType(opts, type);
    return opts.mod.nop();
  }

  return opts.mod.nop();
};
