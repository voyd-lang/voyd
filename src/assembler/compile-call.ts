import {
  CompileExprOpts,
  compileExpression,
  mapBinaryenType,
} from "../assembler.js";
import binaryen from "binaryen";
import { refCast, structGetFieldValue } from "../lib/binaryen-gc/index.js";
import { Call } from "../syntax-objects/call.js";
import { ObjectLiteral } from "../syntax-objects/object-literal.js";
import {
  ObjectType,
  IntersectionType,
  FixedArrayType,
  FnType,
} from "../syntax-objects/types.js";
import { Identifier } from "../syntax-objects/identifier.js";
import { Expr } from "../syntax-objects/expr.js";
import { getExprType } from "../semantics/resolution/get-expr-type.js";
import { returnCall } from "./return-call.js";
import * as gc from "../lib/binaryen-gc/index.js";

const OBJECT_FIELDS_OFFSET = 2;

export const compile = (opts: CompileExprOpts<Call>): number => {
  const { expr, mod, isReturnExpr } = opts;
  if (expr.calls("quote")) return (expr.argAt(0) as { value: number }).value;
  if (expr.calls("=")) return compileAssign(opts);
  if (expr.calls("if")) return compileIf(opts);
  if (expr.calls("export")) return compileExport(opts);
  if (expr.calls("mod")) return mod.nop();
  if (expr.calls("member-access")) return compileObjMemberAccess(opts);
  if (expr.calls("while")) return compileWhile(opts);
  if (expr.calls("break")) return mod.br(opts.loopBreakId!);
  if (expr.calls("FixedArray")) return compileFixedArray(opts);
  if (expr.calls("binaryen")) {
    return compileBnrCall(opts);
  }

  if (!expr.fn) {
    const fnType = getExprType(expr.fnName);
    if (fnType?.isFnType()) {
      return compileClosureCall({ ...opts, expr }, fnType);
    }
    throw new Error(`No function found for call ${expr.location}`);
  }

  if (expr.fn.isObjectType()) {
    return compileObjectInit(opts);
  }

  const args = expr.args.toArray().map((arg, i) => {
    const compiled = compileExpression({
      ...opts,
      expr: arg,
      isReturnExpr: false,
    });

    if (!expr.fn?.isFn()) return compiled;
    const param = expr.fn?.parameters[i];
    const argType = getExprType(arg);
    if (param?.type?.isObjectType() && argType?.isTraitType()) {
      return refCast(mod, compiled, mapBinaryenType(opts, param.type));
    }

    return compiled;
  });

  const id = expr.fn!.id;
  const returnType = mapBinaryenType(opts, expr.fn!.returnType!);

  if (isReturnExpr) {
    return returnCall(mod, id, args, returnType);
  }

  return mod.call(id, args, returnType);
};

const compileClosureCall = (
  opts: CompileExprOpts<Call>,
  fnType: FnType
): number => {
  const { expr, mod, isReturnExpr } = opts;
  const closureRef = compileExpression({
    ...opts,
    expr: expr.fnName,
    isReturnExpr: false,
  });

  const fnRef = gc.structGetFieldValue({
    mod,
    fieldType: binaryen.funcref,
    fieldIndex: 0,
    exprRef: compileExpression({ ...opts, expr: expr.fnName, isReturnExpr: false }),
  });

  const args = [
    closureRef,
    ...expr.args.toArray().map((arg) =>
      compileExpression({ ...opts, expr: arg, isReturnExpr: false })
    ),
  ];

  const returnType = mapBinaryenType(opts, fnType.returnType);

  return gc.callRef(mod, fnRef, args, returnType, !!isReturnExpr);
};

const compileFixedArray = (opts: CompileExprOpts<Call>) => {
  const type = opts.expr.type as FixedArrayType;
  return gc.arrayNewFixed(
    opts.mod,
    gc.binaryenTypeToHeapType(mapBinaryenType(opts, type)),
    opts.expr.argArrayMap((expr) => compileExpression({ ...opts, expr }))
  );
};

const compileWhile = (opts: CompileExprOpts<Call>) => {
  const { expr, mod } = opts;
  const loopId = expr.syntaxId.toString();
  const breakId = `__break_${loopId}`;
  return mod.loop(
    loopId,
    mod.block(breakId, [
      mod.br_if(
        breakId,
        mod.i32.ne(
          compileExpression({
            ...opts,
            expr: expr.exprArgAt(0),
            isReturnExpr: false,
          }),
          mod.i32.const(1)
        )
      ),
      compileExpression({
        ...opts,
        expr: expr.labeledArg("do"),
        loopBreakId: breakId,
        isReturnExpr: false,
      }),
      mod.br(loopId),
    ])
  );
};

const compileObjectInit = (opts: CompileExprOpts<Call>) => {
  const { expr, mod } = opts;

  const objectType = getExprType(expr) as ObjectType;
  const objectBinType = mapBinaryenType(opts, objectType);
  const obj = expr.argAt(0) as ObjectLiteral;

  return gc.initStruct(mod, objectBinType, [
    mod.global.get(
      `__ancestors_table_${objectType.id}`,
      opts.extensionHelpers.i32Array
    ),
    mod.global.get(
      `__field_index_table_${objectType.id}`,
      opts.fieldLookupHelpers.lookupTableType
    ),
    ...obj.fields.map((field) =>
      compileExpression({
        ...opts,
        expr: field.initializer,
        isReturnExpr: false,
      })
    ),
  ]);
};

const compileExport = (opts: CompileExprOpts<Call>) => {
  const expr = opts.expr.exprArgAt(0);
  const result = compileExpression({ ...opts, expr });
  return result;
};

const compileAssign = (opts: CompileExprOpts<Call>): number => {
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
  const entity = identifier.resolve();
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

const compileBnrCall = (opts: CompileExprOpts<Call>): number => {
  const { expr } = opts;
  const funcIdExpr = expr.labeledArg("func");
  const namespaceExpr = expr.labeledArg("namespace");
  const argsExpr = expr.labeledArg("args");

  if (!funcIdExpr?.isIdentifier())
    throw new Error("binaryen call missing 'func:' identifier");
  if (!namespaceExpr?.isIdentifier())
    throw new Error("binaryen call missing 'namespace:' identifier");
  if (!argsExpr?.isCall())
    throw new Error("binaryen call missing 'args:' list");

  const funcId = funcIdExpr as Identifier;
  const namespace = namespaceExpr.value;
  const args = argsExpr as Call;

  const func =
    namespace === "gc"
      ? (...args: unknown[]) => (gc as any)[funcId.value](opts.mod, ...args)
      : (opts.mod as any)[namespace][funcId.value];

  return func(
    ...(args.argArrayMap((expr: Expr) => {
      if (expr?.isCall() && expr.calls("BnrType")) {
        const type = getExprType(expr.typeArgs?.at(0));
        if (!type) return opts.mod.nop();
        return mapBinaryenType(opts, type);
      }

      if (expr?.isCall() && expr.calls("BnrConst")) {
        const arg = expr.argAt(0);
        if (!arg) return opts.mod.nop();
        if ("value" in arg) return (arg as any).value;
      }

      return compileExpression({ ...opts, expr });
    }) ?? [])
  );
};

const compileIf = (opts: CompileExprOpts<Call>) => {
  const { expr, mod } = opts;
  const conditionNode = expr.exprArgAt(0);
  const ifTrueNode = expr.labeledArg("then");
  const ifFalseNode = expr.optionalLabeledArg("else");
  const condition = compileExpression({
    ...opts,
    expr: conditionNode,
    isReturnExpr: false,
  });
  const ifTrue = compileExpression({ ...opts, expr: ifTrueNode });
  const ifFalse =
    ifFalseNode !== undefined
      ? compileExpression({ ...opts, expr: ifFalseNode })
      : undefined;

  return mod.if(condition, ifTrue, ifFalse);
};

const compileObjMemberAccess = (opts: CompileExprOpts<Call>) => {
  const { expr, mod } = opts;
  const obj = expr.exprArgAt(0);
  const member = expr.identifierArgAt(1);
  const objValue = compileExpression({ ...opts, expr: obj });
  const type = getExprType(obj) as ObjectType | IntersectionType;

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
