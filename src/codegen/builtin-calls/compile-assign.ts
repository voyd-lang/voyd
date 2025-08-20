import { CompileExprOpts, compileExpression } from "../../codegen.js";
import { Call } from "../../syntax-objects/call.js";
import { Identifier } from "../../syntax-objects/identifier.js";
import { ObjectType, IntersectionType } from "../../syntax-objects/types.js";
import { getExprType } from "../../semantics/resolution/get-expr-type.js";
import { OBJECT_FIELDS_OFFSET } from "./object-layout.js";
import * as gc from "../../lib/binaryen-gc/index.js";

export const compileAssign = (opts: CompileExprOpts<Call>): number => {
  const { expr, mod } = opts;
  const identifier = expr.argAt(0);

  if (identifier?.isCall()) {
    return compileFieldAssign(opts);
  }

  if (!identifier?.isIdentifier()) {
    throw new Error(`Invalid assignment target ${identifier}`);
  }

  const value = compileExpression({
    ...opts,
    expr: expr.argAt(1)!,
    isReturnExpr: false,
  });

  const entity = (identifier as Identifier).resolve();
  if (!entity) {
    throw new Error(`${identifier} not found in scope`);
  }

  if (entity.isVariable()) {
    return mod.local.set(entity.getIndex(), value);
  }

  throw new Error(`${identifier} cannot be re-assigned`);
};

const compileFieldAssign = (opts: CompileExprOpts<Call>) => {
  const { expr, mod } = opts;
  const access = expr.callArgAt(0);
  const member = access.identifierArgAt(1);
  const target = access.exprArgAt(0);
  const type = getExprType(target) as ObjectType | IntersectionType;

  if (type.isIntersectionType() || type.isStructural) {
    return opts.fieldLookupHelpers.setFieldValueByAccessor(opts);
  }

  const value = compileExpression({
    ...opts,
    expr: expr.argAt(1)!,
    isReturnExpr: false,
  });

  const index = type.getFieldIndex(member);
  if (index === -1) {
    throw new Error(`Field ${member} not found in ${type.id}`);
  }
  const memberIndex = index + OBJECT_FIELDS_OFFSET;

  return gc.structSetFieldValue({
    mod,
    ref: compileExpression({ ...opts, expr: target }),
    fieldIndex: memberIndex,
    value,
  });
};
