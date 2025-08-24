import { Implementation } from "../syntax-objects/implementation.js";
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
  VoydModule,
  Parameter,
  Use,
  TypeAlias,
  ObjectLiteral,
  UnionType,
  IntersectionType,
  FixedArrayType,
  Closure,
} from "../syntax-objects/index.js";
import { Match } from "../syntax-objects/match.js";
import { getExprType } from "./resolution/get-expr-type.js";
import { typesAreCompatible } from "./resolution/index.js";
import { getCallFn } from "./resolution/get-call-fn.js";
import { resolveUnionType } from "./resolution/resolve-union.js";
import { formatFnSignature } from "./fn-signature.js";

export const checkTypes = (expr: Expr | undefined): Expr => {
  if (!expr) return nop();
  if (expr.isBlock()) return checkBlockTypes(expr);
  if (expr.isCall()) return checkCallTypes(expr);
  if (expr.isFn()) return checkFnTypes(expr);
  if (expr.isClosure()) return checkClosureTypes(expr);
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
  if (call.calls("call-closure")) return checkClosureCall(call);
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
    const arg1Type = getExprType(call.argAt(0));
    if (arg1Type?.isTraitType() && call.type) {
      // Trait method call may not have a concrete implementation yet
      return call;
    }
    // Not having a fn is ok when the call points to a closure. TODO: Make this more explicit on the call
    const entity = call.fnName.resolve();
    if (
      (entity?.isVariable() || entity?.isParameter()) &&
      entity.type?.isFnType()
    ) {
      return call;
    }

    const params = call.args
      .toArray()
      .map((arg) => getExprType(arg)?.name.value)
      .join(", ");

    const location = call.location ?? call.fnName.location;
    const candidates = call.resolveFns(call.fnName);
    if (candidates.length) {
      const signatures = candidates.map(formatFnSignature).join(", ");
      throw new Error(
        `No overload matches ${call.fnName}(${params}) at ${location}. Available overloads: ${signatures}`
      );
    }

    throw new Error(
      `Could not resolve fn ${call.fnName}(${params}) at ${location}`
    );
  }

  if (call.fn?.parent?.isTrait?.()) {
    try {
      const resolved = getCallFn(call);
      if (resolved) {
        call.fn = resolved;
        call.type = resolved.returnType;
      }
    } catch {}
  }

  if (!call.type) {
    throw new Error(
      `Could not resolve type for call ${call.fnName} at ${call.location}`
    );
  }

  return call;
};

const checkClosureCall = (call: Call): Call => {
  call.args = call.args.map(checkTypes);
  const closure = call.argAt(0);
  const closureType = getExprType(closure);
  if (!closureType?.isFnType()) {
    throw new Error(`First argument must be a closure at ${closure?.location}`);
  }
  closureType.parameters.forEach((p, i) => {
    const arg = call.argAt(i + 1);
    const argType = getExprType(arg);
    if (!typesAreCompatible(argType, p.type!)) {
      throw new Error(`Expected ${p.type?.name} at ${arg?.location}`);
    }
  });
  call.type = closureType.returnType;
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
    if (!argType) {
      throw new Error(`Unable to resolve type for ${arg.location}`);
    }

    if (type.elemType?.isUnionType()) {
      resolveUnionType(type.elemType);
      if (type.elemType.types.length === 0) {
        return;
      }
      const match = type.elemType.types.some((t) =>
        typesAreCompatible(argType, t)
      );
      if (!match) {
        throw new Error(
          `Expected ${type.elemType.name} got ${argType.name} at ${arg.location}`
        );
      }
      return;
    }

    if (!typesAreCompatible(argType, type.elemType)) {
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
    const expected = call.type?.isObjectType() ? call.type : undefined;
    const provided = literal.type?.isObjectType() ? literal.type : undefined;

    if (expected && provided) {
      const missing = expected.fields
        .filter((f) => !provided.fields.some((pf) => pf.name === f.name))
        .map((f) => f.name);

      const wrong = expected.fields
        .map((f) => {
          const match = provided.fields.find((pf) => pf.name === f.name);
          if (!match) return undefined;
          return typesAreCompatible(match.type, f.type)
            ? undefined
            : {
                name: f.name,
                expected: f.type?.name.value ?? "unknown",
                actual: match.type?.name.value ?? "unknown",
              };
        })
        .filter((f): f is { name: string; expected: string; actual: string } =>
          Boolean(f)
        );

      const extra = provided.fields
        .filter((pf) => !expected.fields.some((f) => f.name === pf.name))
        .map((f) => f.name);

      const parts: string[] = [];
      if (missing.length) parts.push(`Missing fields: ${missing.join(", ")}`);
      if (wrong.length)
        parts.push(
          `Fields with wrong types: ${wrong
            .map((w) => `${w.name} (expected ${w.expected}, got ${w.actual})`)
            .join(", ")}`
        );
      if (extra.length) parts.push(`Extra fields: ${extra.join(", ")}`);

      const details = parts.length ? ` ${parts.join(". ")}.` : "";
      throw new Error(
        `Object literal type does not match expected type ${expected.name} at ${literal.location}.${details}`
      );
    }

    throw new Error(
      `Object literal type does not match expected type ${call.type?.name} at ${literal.location}`
    );
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
    throw new Error(`${id} cannot be re-assigned at ${id.location}`);
  }

  const initExpr = call.argAt(1);
  checkTypes(initExpr);
  const initType = getExprType(initExpr);

  if (!typesAreCompatible(variable.type, initType)) {
    const variableTypeName = variable.type?.name.value ?? "unknown";
    const initTypeName = initType?.name.value ?? "unknown";
    const location = call.location ?? id.location;
    throw new Error(
      `Cannot assign ${initTypeName} to variable ${id} of type ${variableTypeName} at ${location}`
    );
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

  if (!call.type) {
    throw new Error(
      `Unable to determine return type of If at ${call.location}`
    );
  }

  const elseExpr = call.argAt(2) ? checkTypes(call.argAt(2)) : undefined;

  // Until unions are supported, return voyd if no else
  if (!elseExpr) {
    call.type = dVoid;
    return call;
  }

  const elseType = getExprType(elseExpr);

  if (!typesAreCompatible(elseType, call.type)) {
    throw new Error(
      `If condition clauses do not return same type at ${call.location}`
    );
  }

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

const checkClosureTypes = (closure: Closure): Closure => {
  checkParameters(closure.parameters);
  checkTypes(closure.body);

  if (closure.returnTypeExpr) {
    checkTypeExpr(closure.returnTypeExpr);
  }

  if (!closure.returnType) {
    throw new Error(
      `Unable to determine return type for closure at ${closure.location}`
    );
  }

  const inferredReturnType = closure.inferredReturnType;

  if (
    inferredReturnType &&
    !typesAreCompatible(inferredReturnType, closure.returnType)
  ) {
    throw new Error(
      `Closure return value type (${inferredReturnType?.name}) is not compatible with annotated return type (${closure.returnType?.name}) at ${closure.location}`
    );
  }

  return closure;
};

const checkParameters = (params: Parameter[]) => {
  params.forEach((p) => {
    if (!p.type) {
      throw new Error(
        `Unable to determine type for ${p} at ${p.name.location}`
      );
    }

    checkTypeExpr(p.typeExpr);
  });
};

const checkModuleTypes = (mod: VoydModule): VoydModule => {
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
    const annotatedName = variable.annotatedType.name.value;
    const inferredName = variable.inferredType.name.value;
    throw new Error(
      `${variable.name} is declared as ${annotatedName} but initialized with ${inferredName} at ${variable.location}`
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

  const implementedTraits = new Set<string>();
  obj.implementations.forEach((impl) => {
    if (!impl.trait) return;

    if (implementedTraits.has(impl.trait.id)) {
      throw new Error(
        `Trait ${impl.trait.name} implemented multiple times for obj ${obj.name} at ${obj.location}`
      );
    }

    implementedTraits.add(impl.trait.id);
  });

  obj.implementations.forEach(checkImpl);

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
    throw new Error(
      `Unable to fully resolve type at ${expr.location ?? expr.fnName.location}`
    );
  }

  if (expr.isCall() && hasTypeArgs(expr.type)) {
    throw new Error(
      `Type args must be resolved at ${expr.location ?? expr.fnName.location}`
    );
  }

  if (expr.isCall()) {
    return;
  }

  if (expr.isIdentifier() && !expr.is("self")) {
    const entity = expr.resolve();
    if (!entity) {
      throw new Error(`Unrecognized identifier ${expr} at ${expr.location}`);
    }

    if (!entity.isType()) {
      throw new Error(
        `Expected type, got ${entity.name.value} at ${expr.location}`
      );
    }

    if (hasTypeArgs(entity)) {
      throw new Error(
        `Type args must be resolved for ${entity.name} at ${expr.location}`
      );
    }
  }

  return checkTypes(expr);
};

const hasTypeArgs = (type?: Expr) => {
  if (!type) return false;

  if (type.isTypeAlias() && type.typeParameters) return true;
  if (type.isObjectType() && type.typeParameters) return true;

  return false;
};

const checkTypeAlias = (alias: TypeAlias): TypeAlias => {
  if (alias.typeParameters) return alias;

  if (!alias.type) {
    throw new Error(
      `Unable to determine type for ${JSON.stringify(
        alias.typeExpr,
        undefined,
        2
      )} at ${alias.location}`
    );
  }

  return alias;
};

const checkImpl = (impl: Implementation): Implementation => {
  if (impl.traitExpr.value && !impl.trait) {
    throw new Error(`Unable to resolve trait for impl at ${impl.location}`);
  }
  // Always validate method bodies
  for (const method of impl.methods) {
    checkFnTypes(method);
  }

  if (!impl.trait) return impl;

  for (const method of impl.trait.methods.toArray()) {
    if (
      !impl.methods.some((fn) =>
        typesAreCompatible(fn.getType(), method.getType())
      )
    ) {
      throw new Error(
        `Impl does not implement ${method.name} at ${impl.location}`
      );
    }
  }

  return impl;
};

const checkListTypes = (list: List) => {
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

  if (!inter.structuralType.isStructural) {
    throw new Error(
      `Structural type must be a structural type ${inter.structuralTypeExpr.value.location}`
    );
  }

  return inter;
};

const checkMatchCases = (match: Match) => {
  for (const mCase of match.cases) {
    checkTypes(mCase.expr);

    if (!mCase.matchType) {
      throw new Error(
        `Cannot resolve type for match case at ${mCase.expr.location}`
      );
    }

    if (!typesAreCompatible(mCase.expr.type, match.type)) {
      const expected = match.type?.name.value ?? "unknown";
      const actual = mCase.expr.type?.name.value ?? "unknown";
      throw new Error(
        `Match case at ${mCase.expr.location} returns ${actual} but expected ${expected}`
      );
    }
  }
};

const checkUnionMatch = (match: Match) => {
  const union = match.baseType as UnionType;

  const matched = match.cases
    .map((c) => c.matchType?.name.value)
    .filter((n): n is string => !!n);
  const unionTypes = union.types.map((t) => t.name.value);

  if (!match.defaultCase) {
    const missing = unionTypes.filter((t) => !matched.includes(t));
    if (missing.length) {
      throw new Error(
        `Match on ${union.name.value} is not exhaustive at ${match.location}. Missing cases: ${missing.join(", ")}`
      );
    }
  }

  checkMatchCases(match);

  const badCase = match.cases.find(
    (mCase) =>
      !union.types.some((type) => typesAreCompatible(mCase.matchType, type))
  );

  if (badCase) {
    const caseName = badCase.matchType?.name.value ?? "unknown";
    throw new Error(
      `Match case ${caseName} is not part of union ${union.name.value} at ${match.location}`
    );
  }

  return match;
};

/** Check a match against an object type */
const checkObjectMatch = (match: Match) => {
  const baseName = match.baseType?.name.value ?? "object";

  if (!match.defaultCase) {
    throw new Error(
      `Match on ${baseName} must have a default case at ${match.location}`
    );
  }

  if (!match.baseType || !match.baseType.isObjectType()) {
    throw new Error(
      `Cannot determine type of value being matched at ${match.location}`
    );
  }

  checkMatchCases(match);

  return match;
};

const checkUnionType = (union: UnionType) => {
  union.childTypeExprs.each(checkTypeExpr);

  if (union.types.length !== union.childTypeExprs.length) {
    throw new Error(`Unable to resolve every type in union ${union.location}`);
  }

  union.types.forEach((t) => {
    const isObjectType =
      t.isObjectType() ||
      t.isIntersectionType() ||
      t.isUnionType();
    if (!isObjectType) {
      throw new Error(
        `Union must be made up of object types ${union.location}`
      );
    }
  });

  return union;
};

const checkFixedArrayType = (array: FixedArrayType) => {
  if (!array.elemType) {
    throw new Error(`Unable to determine element type for ${array.location}`);
  }

  return array;
};
