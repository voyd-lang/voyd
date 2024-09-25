import {
  List,
  Expr,
  nop,
  Identifier,
  ObjectType,
  Type,
  bool,
  dVoid,
  Fn,
  Block,
  Call,
  Variable,
  VoidModule,
  Parameter,
  Use,
  TypeAlias,
  ObjectLiteral,
  UnionType,
  IntersectionType,
  FixedArrayType,
} from "../syntax-objects/index.js";
import { Match } from "../syntax-objects/match.js";
import { getExprType } from "./resolution/get-expr-type.js";
import { typesAreCompatible } from "./resolution/index.js";

export const checkTypes = (expr: Expr | undefined): Expr => {
  if (!expr) return nop();
  if (expr.isBlock()) return checkBlockTypes(expr);
  if (expr.isCall()) return checkCallTypes(expr);
  if (expr.isFn()) return checkFnTypes(expr);
  if (expr.isVariable()) return checkVarTypes(expr);
  if (expr.isModule()) return checkModuleTypes(expr);
  if (expr.isList()) return checkListTypes(expr);
  if (expr.isIdentifier()) return checkIdentifier(expr);
  if (expr.isUse()) return checkUse(expr);
  if (expr.isObjectType()) return checkObjectType(expr);
  if (expr.isTypeAlias()) return checkTypeAlias(expr);
  if (expr.isObjectLiteral()) return checkObjectLiteralType(expr);
  if (expr.isUnionType()) return checkUnionType(expr);
  if (expr.isFixedArrayType()) return checkFixedArrayType(expr);
  if (expr.isMatch()) return checkMatch(expr);
  if (expr.isIntersectionType()) return checkIntersectionType(expr);
  return expr;
};

const checkBlockTypes = (block: Block): Block => {
  block.body = block.body.map(checkTypes);
  return block;
};

const checkCallTypes = (call: Call): Call | ObjectLiteral => {
  if (call.calls("export")) return checkExport(call);
  if (call.calls("if")) return checkIf(call);
  if (call.calls("binaryen")) return checkBinaryenCall(call);
  if (call.calls("mod")) return call;
  if (call.calls("break")) return call;
  if (call.calls(":")) return checkLabeledArg(call);
  if (call.calls("=")) return checkAssign(call);
  if (call.calls("while")) return checkWhile(call);
  if (call.calls("FixedArray")) return checkFixedArrayInit(call);
  if (call.calls("member-access")) return call; // TODO
  if (call.fn?.isObjectType()) return checkObjectInit(call);

  call.args = call.args.map(checkTypes);

  if (!call.fn) {
    const params = call.args
      .toArray()
      .map((arg) => getExprType(arg)?.name.value)
      .join(", ");

    throw new Error(
      `Could not resolve fn ${call.fnName}(${params}) at ${call.location}`
    );
  }

  if (!call.type) {
    throw new Error(
      `Could not resolve type for call ${call.fnName} at ${call.location}`
    );
  }

  return call;
};

const checkFixedArrayInit = (call: Call) => {
  const type = call.type;

  if (!type || !type.isFixedArrayType()) {
    throw new Error(`Expected FixedArray type at ${call.location}`);
  }

  checkFixedArrayType(type);
  call.args.each((arg) => {
    const argType = getExprType(arg);
    if (!argType || !typesAreCompatible(argType, type.elemType)) {
      throw new Error(
        `Expected ${type.elemType?.name} got ${argType?.name} at ${arg.location}`
      );
    }
  });

  return call;
};

const checkWhile = (call: Call) => {
  const cond = call.argAt(0);
  const condType = getExprType(cond);
  if (!cond || !condType || !typesAreCompatible(condType, bool)) {
    throw new Error(
      `While conditions must resolve to a boolean at ${cond?.location}`
    );
  }

  checkTypes(call.argAt(1));
  return call;
};

const checkObjectInit = (call: Call): Call => {
  const literal = call.argAt(0);
  if (!literal?.isObjectLiteral()) {
    throw new Error(`Expected object literal, got ${literal}`);
  }
  checkTypes(literal);

  // Check to ensure literal structure is compatible with nominal structure
  if (!typesAreCompatible(literal.type, call.type, { structuralOnly: true })) {
    throw new Error(`Object literal type does not match expected type`);
  }

  return call;
};

export const checkAssign = (call: Call) => {
  const id = call.argAt(0);
  if (!id?.isIdentifier()) {
    return call;
  }

  const variable = id.resolve();
  if (!variable || !variable.isVariable()) {
    throw new Error(`Unrecognized variable ${id} at ${id.location}`);
  }

  if (!variable.isMutable) {
    throw new Error(`${id} cannot be re-assigned`);
  }

  const initType = getExprType(call.argAt(1));

  if (!typesAreCompatible(variable.type, initType)) {
    throw new Error(`${id} cannot be assigned to ${initType}`);
  }

  return call;
};

const checkIdentifier = (id: Identifier) => {
  if (id.is("return") || id.is("break")) return id;

  const entity = id.resolve();
  if (!entity) {
    throw new Error(`Unrecognized identifier, ${id} at ${id.location}`);
  }

  if (entity.isVariable()) {
    if ((id.location?.startIndex ?? 0) <= (entity.location?.startIndex ?? 0)) {
      throw new Error(`${id} used before defined`);
    }
  }

  return id;
};

export const checkIf = (call: Call) => {
  const cond = checkTypes(call.argAt(0));
  const condType = getExprType(cond);
  if (!condType || !typesAreCompatible(condType, bool)) {
    throw new Error(
      `If conditions must resolve to a boolean at ${cond.location}`
    );
  }

  const thenExpr = checkTypes(call.argAt(1));
  const elseExpr = call.argAt(2) ? checkTypes(call.argAt(2)) : undefined;

  // Until unions are supported, return voyd if no else
  if (!elseExpr) {
    call.type = dVoid;
    return call;
  }

  const thenType = getExprType(thenExpr);
  const elseType = getExprType(elseExpr);

  // Until unions are supported, throw an error when types don't match
  if (!typesAreCompatible(thenType, elseType)) {
    throw new Error(
      `If condition clauses do not return same type at ${call.location}`
    );
  }

  call.type = thenType;
  return call;
};

export const checkBinaryenCall = (call: Call) => {
  return call; // TODO: Actually check?
};

export const checkLabeledArg = (call: Call) => {
  const expr = call.argAt(1);
  checkTypes(expr);
  return call;
};

const checkExport = (call: Call) => {
  const block = call.argAt(0);
  if (!block?.isBlock()) {
    throw new Error("Expected export to contain block");
  }

  checkTypes(block);
  return call;
};

const checkUse = (use: Use) => {
  // TODO: Maybe check for dupes or some
  return use;
};

const checkFnTypes = (fn: Fn): Fn => {
  if (fn.genericInstances) {
    fn.genericInstances.forEach(checkFnTypes);
    return fn;
  }

  // If the function has type parameters and not genericInstances, it isn't in use and wont be compiled.
  if (fn.typeParameters) {
    return fn;
  }

  checkParameters(fn.parameters);
  checkTypes(fn.body);

  if (fn.returnTypeExpr) {
    checkTypeExpr(fn.returnTypeExpr);
  }

  if (!fn.returnType) {
    throw new Error(
      `Unable to determine return type for ${fn.name} at ${fn.location}`
    );
  }

  const inferredReturnType = fn.inferredReturnType;

  if (
    inferredReturnType &&
    !typesAreCompatible(inferredReturnType, fn.returnType)
  ) {
    throw new Error(
      `Fn, ${fn.name}, return value type (${inferredReturnType?.name}) is not compatible with annotated return type (${fn.returnType?.name}) at ${fn.location}`
    );
  }

  return fn;
};

const checkParameters = (params: Parameter[]) => {
  params.forEach((p) => {
    if (!p.type) {
      throw new Error(`Unable to determine type for ${p}`);
    }

    checkTypeExpr(p.typeExpr);
  });
};

const checkModuleTypes = (mod: VoidModule): VoidModule => {
  mod.each(checkTypes);
  return mod;
};

const resolveExports = ({
  exports,
  body,
}: {
  exports: List;
  body: List;
}): void => {
  body.each((expr) => {
    if (!expr.isList()) return;
    if (expr.calls("export")) {
      exports.push(expr.at(1) as Identifier);
      return;
    }
    return resolveExports({ exports, body: expr });
  });
};

const checkVarTypes = (variable: Variable): Variable => {
  checkTypes(variable.initializer);

  if (!variable.inferredType) {
    throw new Error(
      `Enable to determine variable initializer return type ${variable.name}`
    );
  }

  if (variable.typeExpr) checkTypeExpr(variable.typeExpr);

  if (
    variable.annotatedType &&
    !typesAreCompatible(variable.inferredType, variable.annotatedType)
  ) {
    throw new Error(
      `${variable.name} of type ${variable.type} is not assignable to ${variable.inferredType}`
    );
  }

  return variable;
};

const checkObjectType = (obj: ObjectType): ObjectType => {
  if (obj.genericInstances) {
    obj.genericInstances.forEach(checkTypes);
    return obj;
  }

  if (obj.typeParameters) {
    return obj;
  }

  obj.fields.forEach((field) => {
    if (!field.type) {
      throw new Error(
        `Unable to determine type for ${field.typeExpr} at ${field.typeExpr.location}`
      );
    }
  });

  obj.implementations.forEach((impl) => impl.methods.forEach(checkTypes));

  if (obj.parentObjExpr) {
    assertValidExtension(obj, obj.parentObjType);
  }

  return obj;
};

export function assertValidExtension(
  child: ObjectType,
  parent?: Type
): asserts parent is ObjectType {
  if (!parent || !parent?.isObjectType()) {
    throw new Error(`Cannot resolve parent for obj ${child.name}`);
  }

  const validExtension = parent.fields.every((field) => {
    const match = child.fields.find((f) => f.name === field.name);
    return match && typesAreCompatible(field.type, match.type);
  });

  if (!validExtension) {
    throw new Error(`${child.name} does not properly extend ${parent.name}`);
  }
}

const checkTypeExpr = (expr?: Expr) => {
  if (!expr) return; // TODO: Throw error? We use nop instead of undefined now (but maybe not everywhere)

  if (expr.isCall() && !expr.type) {
    throw new Error(`Unable to fully resolve type at ${expr.location}`);
  }

  if (expr.isCall()) {
    return;
  }

  return checkTypes(expr);
};

const checkTypeAlias = (alias: TypeAlias): TypeAlias => {
  if (!alias.type) {
    throw new Error(
      `Unable to determine type for ${JSON.stringify(
        alias.typeExpr,
        undefined,
        2
      )}`
    );
  }

  return alias;
};

const checkListTypes = (list: List) => {
  console.log("Unexpected list");
  console.log(JSON.stringify(list, undefined, 2));
  return list.map(checkTypes);
};

const checkObjectLiteralType = (obj: ObjectLiteral) => {
  obj.fields.forEach((field) => checkTypes(field.initializer));
  return obj;
};

const checkMatch = (match: Match) => {
  if (match.bindVariable) {
    checkVarTypes(match.bindVariable);
  }

  if (match.baseType?.isUnionType()) {
    return checkUnionMatch(match);
  }

  return checkObjectMatch(match);
};

const checkIntersectionType = (inter: IntersectionType) => {
  checkTypeExpr(inter.nominalTypeExpr.value);
  checkTypeExpr(inter.structuralTypeExpr.value);

  if (!inter.nominalType || !inter.structuralType) {
    throw new Error(`Unable to resolve intersection type ${inter.location}`);
  }

  if (!inter.structuralType.getAttribute("isStructural")) {
    throw new Error(
      `Structural type must be a structural type ${inter.structuralTypeExpr.value.location}`
    );
  }

  return inter;
};

const checkUnionMatch = (match: Match) => {
  const union = match.baseType as UnionType;

  if (match.cases.length !== union.types.length) {
    throw new Error(
      `Match does not handle all possibilities of union ${match.location}`
    );
  }

  for (const mCase of match.cases) {
    if (!mCase.matchType) {
      throw new Error(
        `Unable to determine match type for case at ${mCase.expr.location}`
      );
    }

    if (!typesAreCompatible(mCase.expr.type, match.type)) {
      throw new Error(
        `All cases must return the same type for now ${mCase.expr.location}`
      );
    }
  }

  union.types.forEach((type) => {
    if (
      !match.cases.some((mCase) => typesAreCompatible(mCase.matchType, type))
    ) {
      throw new Error(
        `Match does not handle all possibilities of union ${match.location}`
      );
    }
  });

  return match;
};

/** Check a match against an object type */
const checkObjectMatch = (match: Match) => {
  if (!match.defaultCase) {
    throw new Error(`Match must have a default case at ${match.location}`);
  }

  if (!match.baseType || !match.baseType.isObjectType()) {
    throw new Error(
      `Unable to determine base type for match at ${match.location}`
    );
  }

  for (const mCase of match.cases) {
    if (!mCase.matchType) {
      throw new Error(
        `Unable to determine match type for case at ${mCase.expr.location}`
      );
    }

    if (!mCase.matchType.extends(match.baseType)) {
      throw new Error(
        `Match case type ${mCase.matchType.name} does not extend ${match.baseType.name} at ${mCase.expr.location}`
      );
    }

    if (!typesAreCompatible(mCase.expr.type, match.type)) {
      throw new Error(
        `All cases must return the same type for now ${mCase.expr.location}`
      );
    }
  }

  return match;
};

const checkUnionType = (union: UnionType) => {
  union.childTypeExprs.each(checkTypeExpr);

  if (union.types.length !== union.childTypeExprs.length) {
    throw new Error(`Unable to resolve every type in union ${union.location}`);
  }

  return union;
};

const checkFixedArrayType = (array: FixedArrayType) => {
  if (!array.elemType) {
    throw new Error(`Unable to determine element type for ${array.location}`);
  }

  return array;
};
