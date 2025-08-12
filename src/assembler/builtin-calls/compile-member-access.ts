import { CompileExprOpts, compileExpression, mapBinaryenType } from "../../assembler.js";
import { Call } from "../../syntax-objects/call.js";
import { ObjectType, IntersectionType } from "../../syntax-objects/types.js";
import { OBJECT_FIELDS_OFFSET } from "./object-layout.js";
import * as gc from "../../lib/binaryen-gc/index.js";

export const compileMemberAccess = (opts: CompileExprOpts<Call>) => {
  const { expr, mod } = opts;
  const obj = expr.exprArgAt(0);
  const member = expr.identifierArgAt(1);
  const objValue = compileExpression({ ...opts, expr: obj });
  const type = obj.getType() as ObjectType | IntersectionType;

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
