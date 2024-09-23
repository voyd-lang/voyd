import { Call } from "../../syntax-objects/call.js";
import { Identifier, List, nop } from "../../syntax-objects/index.js";
import { dVoid, ObjectType, TypeAlias } from "../../syntax-objects/types.js";
import { getCallFn } from "./get-call-fn.js";
import { getExprType, getIdentifierType } from "./get-expr-type.js";
import { resolveObjectType } from "./resolve-object-type.js";
import { resolveEntities } from "./resolve-types.js";
import { resolveExport } from "./resolve-use.js";

export const resolveCall = (call: Call): Call => {
  if (call.type) return call;
  if (call.calls("export")) return resolveExport(call);
  if (call.calls("if")) return resolveIf(call);
  if (call.calls(":")) return checkLabeledArg(call);
  if (call.calls("while")) return resolveWhile(call);
  call.args = call.args.map(resolveEntities);

  const memberAccessCall = getMemberAccessCall(call);
  if (memberAccessCall) return memberAccessCall;

  const entity = call.fnName.resolve();
  if (entity?.isTypeAlias()) {
    return resolveTypeAlias(call, entity);
  }

  // Constructor fn. TODO:
  const type = getIdentifierType(call.fnName);
  if (type?.isObjectType()) {
    return resolveObjectInit(call, type);
  }

  if (call.typeArgs) {
    call.typeArgs = call.typeArgs.map(resolveEntities);
  }

  call.fn = getCallFn(call);
  call.type = call.fn?.returnType;
  return call;
};

export const checkLabeledArg = (call: Call) => {
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

export const resolveTypeAlias = (call: Call, type: TypeAlias): Call => {
  const alias = type.clone();

  if (alias.typeParameters) {
    alias.typeParameters.forEach((typeParam, index) => {
      const typeArg = call.typeArgs?.exprAt(index);
      const identifier = typeParam.clone();
      const type = new TypeAlias({
        name: identifier,
        typeExpr: nop(),
      });
      type.type = getExprType(typeArg);
      alias.registerEntity(type);
    });
  }

  alias.typeExpr = resolveEntities(alias.typeExpr);
  alias.type = getExprType(alias.typeExpr);
  call.type = alias.type;
  call.fn = call.type?.isObjectType() ? call.type : undefined;
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
  call.type = thenType;
  return call;
};

export const resolveWhile = (call: Call) => {
  call.args = call.args.map(resolveEntities);
  call.type = dVoid;
  return call;
};
