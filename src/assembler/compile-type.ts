import {
  CompileExprOpts,
  buildObjectType,
  buildUnionType,
  buildIntersectionType,
} from "../assembler.js";
import { Type } from "../syntax-objects/types.js";

export const compile = (opts: CompileExprOpts<Type>) => {
  const type = opts.expr;

  if (type.isObjectType()) {
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

