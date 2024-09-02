import { Call } from "../../syntax-objects/call.js";
import { Identifier, List } from "../../syntax-objects/index.js";
import { dVoid, ObjectType } from "../../syntax-objects/types.js";
import { getCallFn } from "./get-call-fn.js";
import { getExprType, getIdentifierType } from "./get-expr-type.js";
import { resolveTypes } from "./resolve-types.js";

export const resolveCallTypes = (call: Call): Call => {
  if (call.calls("export")) return resolveExport(call);
  if (call.calls("if")) return resolveIf(call);
  if (call.calls("binaryen")) return resolveBinaryenCall(call);
  if (call.calls(":")) return checkLabeledArg(call);
  call.args = call.args.map(resolveTypes);

  const memberAccessCall = getMemberAccessCall(call);
  if (memberAccessCall) return memberAccessCall;

  // Constructor fn. TODO:
  const type = getIdentifierType(call.fnName);
  if (type?.isObjectType()) {
    return resolveObjectInit(call, type);
  }

  call.fn = getCallFn(call);
  call.type = call.fn?.returnType;
  return call;
};

export const checkLabeledArg = (call: Call) => {
  call.args = call.args.map(resolveTypes);
  const expr = call.argAt(1);
  call.type = getExprType(expr);
  return call;
};

export const resolveObjectInit = (call: Call, type: ObjectType): Call => {
  call.type = type;
  call.fn = type;
  return call;
};

const getMemberAccessCall = (call: Call): Call | undefined => {
  if (call.args.length > 1) return;
  const a1 = call.argAt(0);
  if (!a1) return;
  const a1Type = getExprType(a1);
  if (!a1Type || !a1Type.isObjectType() || !a1Type.hasField(call.fnName)) {
    return;
  }

  return new Call({
    ...call.metadata,
    fnName: Identifier.from("member-access"),
    args: new List({ value: [a1, call.fnName] }),
    type: a1Type.getField(call.fnName)?.type,
  });
};

const resolveExport = (call: Call) => {
  const block = call.argAt(0);
  if (!block?.isBlock()) {
    throw new Error("Expected export to contain block");
  }

  resolveTypes(block);

  const entities = block.getAllEntities();
  entities.forEach((e) => {
    if (e.isUse()) {
      e.entities.forEach((e) => call.parent?.registerEntity(e));
      return;
    }

    e.isExported = true;
    call.parent?.registerEntity(e);
  });

  return call;
};

export const resolveIf = (call: Call) => {
  call.args = call.args.map(resolveTypes);
  const thenExpr = call.argAt(1);
  const elseExpr = call.argAt(2);

  // Until unions are supported, return void if no else
  if (!elseExpr) {
    call.type = dVoid;
    return call;
  }

  const thenType = getExprType(thenExpr);
  call.type = thenType;
  return call;
};

export const resolveBinaryenCall = (call: Call) => {
  const returnTypeCall = call.callArgAt(2);
  call.type = getExprType(returnTypeCall.argAt(1));
  return call;
};
