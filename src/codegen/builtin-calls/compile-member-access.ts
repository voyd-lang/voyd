import {
  CompileExprOpts,
  compileExpression,
  mapBinaryenType,
} from "../../codegen.js";
import { Call } from "../../syntax-objects/call.js";
import { IntersectionType } from "../../syntax-objects/types.js";
import { getExprType } from "../../semantics/resolution/get-expr-type.js";
import { OBJECT_FIELDS_OFFSET } from "./object-layout.js";
import * as gc from "../../lib/binaryen-gc/index.js";
import { Obj } from "../../syntax-objects/index.js";

export const compileMemberAccess = (opts: CompileExprOpts<Call>) => {
  const { expr, mod } = opts;
  const obj = expr.exprArgAt(0);
  const member = expr.identifierArgAt(1);
  const objValue = compileExpression({
    ...opts,
    expr: obj,
    isReturnExpr: false,
  });
  const type = getExprType(obj) as Obj | IntersectionType;

  if (type.isIntersectionType() || type.isStructural) {
    return opts.fieldLookupHelpers.getFieldValueByAccessor(opts);
  }

  const memberIndex = type.getFieldIndex(member) + OBJECT_FIELDS_OFFSET;
  const field = type.getField(member)!;
  return gc.structGetFieldValue({
    mod,
    fieldIndex: memberIndex,
    fieldType: mapBinaryenType(opts, field.type!),
    exprRef: objValue,
  });
};
