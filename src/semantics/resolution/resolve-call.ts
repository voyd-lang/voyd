import { Call } from "../../syntax-objects/call.js";
import { Identifier, List, nop } from "../../syntax-objects/index.js";
import {
  dVoid,
  FixedArrayType,
  ObjectType,
} from "../../syntax-objects/types.js";
import { getCallFn } from "./get-call-fn.js";
import { getExprType, getIdentifierType } from "./get-expr-type.js";
import { resolveObjectType } from "./resolve-object-type.js";
import { resolveEntities } from "./resolve-entities.js";
import { resolveExport, resolveModulePath } from "./resolve-use.js";
import { combineTypes } from "./combine-types.js";
import { resolveTypeExpr } from "./resolve-type-expr.js";

export const resolveCall = (call: Call): Call => {
  if (call.type) return call;
  if (call.calls("::")) return resolveModuleAccess(call);
  if (call.calls("export")) return resolveExport(call);
  if (call.calls("if")) return resolveIf(call);
  if (call.calls(":")) return resolveLabeledArg(call);
  if (call.calls("while")) return resolveWhile(call);
  if (call.calls("FixedArray")) return resolveFixedArray(call);
  if (call.calls("binaryen")) return resolveBinaryen(call);
  call.args = call.args.map((arg) => {
    if (
      arg.isClosure() &&
      arg.parameters.some((p) => !p.type && !p.typeExpr)
    ) {
      return arg;
    }
    return resolveEntities(arg);
  });

  const firstArg = call.argAt(0);
  const shouldCheckMemberAccess = !(
    firstArg?.isClosure() &&
    firstArg.parameters.some((p) => !p.type && !p.typeExpr)
  );
  const memberAccessCall = shouldCheckMemberAccess
    ? getMemberAccessCall(call)
    : undefined;
  if (memberAccessCall) return memberAccessCall;

  // Constructor fn. TODO:
  const type = getIdentifierType(call.fnName);
  call.fnName.type = type;

  if (type?.isObjectType()) {
    return resolveObjectInit(call, type);
  }

  if (call.typeArgs) {
    call.typeArgs = call.typeArgs.map(resolveTypeExpr);
  }

  if (!call.fn) {
    call.fn = getCallFn(call);
  }
  expandObjectArg(call);
  inferClosureArgTypes(call);

  call.type = call.fn?.isFn()
    ? call.fn.returnType
    : call.fn?.isObjectType()
    ? call.fn
    : type?.isFnType()
    ? type.returnType
    : undefined;
  return call;
};

const expandObjectArg = (call: Call) => {
  const fn = call.fn;
  if (!fn?.isFn() || call.args.length !== 1) return;

  const objArg = call.argAt(0)!;
  const params = fn.parameters;
  const labeledParams = params.filter((p) => p.label);
  const allLabeled = labeledParams.length === params.length;
  if (!allLabeled) return;

  // Case 1: direct object literal supplied
  if (objArg.isObjectLiteral()) {
    const coversAll = labeledParams.every((p) =>
      objArg.fields.some((f) => f.name === p.label!.value)
    );
    if (!coversAll) return;

    const newArgs = labeledParams.map((p) => {
      const fieldName = p.label!.value;
      const field = objArg.fields.find((f) => f.name === fieldName)!;
      return new Call({
        ...call.metadata,
        fnName: Identifier.from(":"),
        args: new List({
          value: [Identifier.from(fieldName), field.initializer.clone()],
        }),
        type: getExprType(field.initializer),
      });
    });

    call.args = new List({ value: newArgs });
    call.args.parent = call;
    return;
  }

  // Case 2: object reference (nominal or structural type)
  const objType = getExprType(objArg);
  const structType = objType?.isObjectType()
    ? objType
    : objType?.isIntersectionType()
    ? objType.structuralType
    : undefined;
  if (!structType) return;

  const coversAll = labeledParams.every((p) =>
    structType.hasField(p.label!.value)
  );
  if (!coversAll) return;

  const newArgs = labeledParams.map((p) => {
    const fieldName = p.label!.value;
    const fieldType = structType.getField(fieldName)?.type;
    const objClone = resolveEntities(objArg.clone());
    const access = new Call({
      ...call.metadata,
      fnName: Identifier.from("member-access"),
      args: new List({
        value: [objClone, Identifier.from(fieldName)],
      }),
      type: fieldType,
    });
    return new Call({
      ...call.metadata,
      fnName: Identifier.from(":"),
      args: new List({ value: [Identifier.from(fieldName), access] }),
      type: fieldType,
    });
  });

  call.args = new List({ value: newArgs });
  call.args.parent = call;
};

const inferClosureArgTypes = (call: Call) => {
  const fn = call.fn;
  if (!fn?.isFn()) return;
  fn.parameters.forEach((param, index) => {
    const arg = call.argAt(index);
    if (!arg?.isClosure()) return;

    const paramType = param.type;
    if (!paramType?.isFnType()) return;

    arg.parameters.forEach((p, i) => {
      const expected = paramType.parameters[i]?.type;
      if (!p.type && expected) {
        p.type = expected;
      }
    });

    const resolved = resolveEntities(arg);
    call.args.set(index, resolved);
  });
};

export const resolveModuleAccess = (call: Call) => {
  const [left, right] = call.argsArray();
  if (right?.isCall()) {
    const path = new List(["::", left, right.fnName]);
    path.parent = call.parent ?? call.parentModule;
    const entity = resolveModulePath(path)[0]?.e;
    if (entity?.isFn()) {
      right.fn = entity;
      right.args = right.args.map(resolveEntities);
      return resolveCall(right);
    }
  }
  return call;
};

export const resolveLabeledArg = (call: Call) => {
  call.args = call.args.map(resolveEntities);
  const expr = call.argAt(1);
  call.type = getExprType(expr);
  return call;
};

export const resolveObjectInit = (call: Call, type: ObjectType): Call => {
  type = resolveObjectType(type, call);
  call.type = type;
  call.fn = type;
  return call;
};

const resolveFixedArray = (call: Call) => {
  call.args = call.args.map(resolveEntities);

  const elemTypeExpr =
    call.typeArgs?.at(0) ??
    combineTypes(
      call.args
        .toArray()
        .map(getExprType)
        .filter((t) => !!t)
    ) ??
    nop();

  const elemType = getExprType(elemTypeExpr);
  call.type = new FixedArrayType({
    ...call.metadata,
    name: Identifier.from(`FixedArray#${call.syntaxId}`),
    elemTypeExpr,
    elemType,
  });
  return call;
};

const getMemberAccessCall = (call: Call): Call | undefined => {
  if (call.args.length > 1) return;
  const a1 = call.argAt(0);
  if (!a1) return;
  const a1Type = getExprType(a1);

  if (a1Type && a1Type.isObjectType() && a1Type.hasField(call.fnName)) {
    return new Call({
      ...call.metadata,
      fnName: Identifier.from("member-access"),
      args: new List({ value: [a1, call.fnName] }),
      type: a1Type.getField(call.fnName)?.type,
    });
  }

  if (
    a1Type &&
    a1Type.isIntersectionType() &&
    (a1Type.nominalType?.hasField(call.fnName) ||
      a1Type.structuralType?.hasField(call.fnName))
  ) {
    const field =
      a1Type.nominalType?.getField(call.fnName) ??
      a1Type.structuralType?.getField(call.fnName);

    return new Call({
      ...call.metadata,
      fnName: Identifier.from("member-access"),
      args: new List({ value: [a1, call.fnName] }),
      type: field?.type,
    });
  }

  return undefined;
};

export const resolveIf = (call: Call) => {
  call.args = call.args.map(resolveEntities);
  const thenExpr = call.argAt(1);
  const elseExpr = call.argAt(2);

  // Until unions are supported, return voyd if no else
  if (!elseExpr) {
    call.type = dVoid;
    return call;
  }

  const thenType = getExprType(thenExpr);
  const elseType = getExprType(elseExpr);
  call.type =
    elseType && thenType ? combineTypes([thenType, elseType]) : thenType;
  return call;
};

export const resolveWhile = (call: Call) => {
  call.args = call.args.map(resolveEntities);
  call.type = dVoid;
  return call;
};

export const resolveBinaryen = (call: Call) => {
  call.args = call.args.map(resolveEntities);
  const typeArg = call.optionalLabeledArg("return_type");

  if (!typeArg) return call;

  resolveTypeExpr(typeArg);
  call.type = getExprType(typeArg);
  return call;
};
