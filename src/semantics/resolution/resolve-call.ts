import { Call } from "../../syntax-objects/call.js";
import { Identifier, List, nop } from "../../syntax-objects/index.js";
import {
  dVoid,
  FixedArrayType,
  ObjectType,
  Type,
} from "../../syntax-objects/types.js";
import { getCallFn } from "./get-call-fn.js";
import { getExprType, getIdentifierType } from "./get-expr-type.js";
import { resolveObjectType } from "./resolve-object-type.js";
import { resolveEntities } from "./resolve-entities.js";
import { resolveExport, resolveModulePath } from "./resolve-use.js";
import { combineTypes } from "./combine-types.js";
import { resolveTypeExpr } from "./resolve-type-expr.js";
import { resolveTrait } from "./resolve-trait.js";

export const resolveCall = (call: Call): Call => {
  if (call.type) return call;
  if (call.calls("::")) return resolveModuleAccess(call);
  if (call.calls("export")) return resolveExport(call);
  if (call.calls("if")) return resolveIf(call);
  if (call.calls("call-closure")) return resolveClosureCall(call);
  if (call.calls(":")) return resolveLabeledArg(call);
  if (call.calls("while")) return resolveWhile(call);
  if (call.calls("FixedArray")) return resolveFixedArray(call);
  if (call.calls("binaryen")) return resolveBinaryen(call);
  call.args = call.args.map((arg) => {
    const inner = arg.isCall() && arg.calls(":") ? arg.argAt(1) : arg;
    if (
      inner?.isClosure() &&
      inner.parameters.some((p) => !p.type && !p.typeExpr)
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

  // Ensure the call identifier is processed so closures can capture it when
  // referenced as the callee.
  call.fnName = resolveEntities(call.fnName) as Identifier;

  // Constructor fn. TODO:
  const type = getIdentifierType(call.fnName);
  call.fnName.type = type;

  if (type?.isObjectType()) {
    return resolveObjectInit(call, type);
  }

  if (call.typeArgs) {
    call.typeArgs = call.typeArgs.map(resolveTypeExpr);
  }

  resolveCallFn(call);
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

const resolveCallFn = (call: Call) => {
  let traitMethod;
  if (!call.fn) {
    const arg0 = call.argAt(0);
    const arg1Type =
      arg0?.isClosure() && arg0.parameters.some((p) => !p.type && !p.typeExpr)
        ? undefined
        : getExprType(arg0);
    if (arg1Type?.isTraitType()) {
      const trait = resolveTrait(arg1Type, call);
      traitMethod = trait.methods
        .toArray()
        .find((fn) => fn.name.is(call.fnName.value));
      if (traitMethod) {
        call.fn = traitMethod;
        call.type = traitMethod.returnType;
      }
    }
  }

  if (!call.fn || call.fn === traitMethod) {
    const resolvedFn = getCallFn(call);
    if (resolvedFn) {
      call.fn = resolvedFn;
      call.type = resolvedFn.returnType;
    }
  }
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
    if (!arg) return;
    const closure = arg.isCall() && arg.calls(":") ? arg.argAt(1) : arg;
    if (!closure?.isClosure()) return;

    const paramType = param.type;
    if (!paramType?.isFnType()) return;

    closure.parameters.forEach((p, i) => {
      const expected = paramType.parameters[i]?.type;
      if (!p.type && expected) {
        p.type = expected;
      }
    });

    const resolvedClosure = resolveEntities(closure);
    if (arg.isCall() && arg.calls(":")) {
      arg.args.set(1, resolvedClosure);
      call.args.set(index, resolveEntities(arg));
    } else {
      call.args.set(index, resolvedClosure);
    }
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

  const args = call.args.toArray();
  const thenTypes: Type[] = [];
  let elseType: Type | undefined;

  for (let i = 1; i < args.length; i++) {
    const labelCall = args[i];
    if (!labelCall.isCall() || !labelCall.calls(":")) continue;
    const labelId = labelCall.argAt(0);
    const value = labelCall.argAt(1);
    if (!labelId?.isIdentifier()) continue;
    if (labelId.value === "then") {
      const t = getExprType(value);
      if (t) thenTypes.push(t);
    } else if (labelId.value === "else") {
      elseType = getExprType(value);
    }
  }

  if (!elseType) {
    call.type = dVoid;
    return call;
  }

  call.type = combineTypes([...thenTypes, elseType]);
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

const resolveClosureCall = (call: Call): Call => {
  call.args = call.args.map(resolveEntities);
  const closure = call.argAt(0);
  if (closure?.isClosure()) {
    call.type = closure.getReturnType();
    return call;
  }
  const closureType = getExprType(closure);
  if (closureType?.isFnType()) {
    call.type = closureType.returnType;
  }
  return call;
};
