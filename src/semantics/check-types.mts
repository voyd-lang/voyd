import {
  List,
  Expr,
  noop,
  Identifier,
  ObjectType,
  Type,
  i32,
  f32,
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
} from "../syntax-objects/index.mjs";
import { NamedEntity } from "../syntax-objects/named-entity.mjs";

export const checkTypes = (expr: Expr | undefined): Expr => {
  if (!expr) return noop();
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
  return expr;
};

const checkBlockTypes = (block: Block): Block => {
  block.body = block.body.map(checkTypes);
  block.type = resolveExprType(block.lastExpr());
  return block;
};

const checkCallTypes = (call: Call): Call | ObjectLiteral => {
  if (call.calls("export")) return checkExport(call);
  if (call.calls("if")) return checkIf(call);
  if (call.calls("binaryen")) return checkBinaryenCall(call);
  if (call.calls(":")) return checkLabeledArg(call);
  if (call.calls("=")) return checkAssign(call);
  call.args = call.args.map(checkTypes);

  const memberAccessCall = getMemberAccessCall(call);
  if (memberAccessCall) return memberAccessCall;

  const type = getIdentifierType(call.fnName);
  if (type?.isObjectType()) {
    return checkObjectLiteralInit(call, type);
  }

  call.fn = resolveCallFn(call);
  if (!call.fn) {
    throw new Error(`Could not resolve fn ${call.fnName} at ${call.location}`);
  }

  call.type = call.fn.getReturnType();
  return call;
};

const checkObjectLiteralInit = (
  call: Call,
  type: ObjectType
): ObjectLiteral => {
  const literal = call.argAt(0);
  if (!literal?.isObjectLiteral()) {
    throw new Error(`Expected object literal, got ${literal}`);
  }

  if (!typesAreEquivalent(literal.type, type)) {
    throw new Error(`Object literal type does not match expected type`);
  }

  literal.type = type;
  return literal;
};

const getMemberAccessCall = (call: Call): Call | undefined => {
  if (call.args.length > 1) return;
  const a1 = call.argAt(0);
  if (!a1) return;
  const a1Type = resolveExprType(a1);
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

const checkAssign = (call: Call) => {
  const id = call.argAt(0);
  if (!id?.isIdentifier()) {
    throw new Error(`Can only assign to variables for now ${id}`);
  }

  const variable = id.resolve();
  if (!variable || !variable.isVariable()) {
    throw new Error(`Unrecognized variable ${id} at ${id.location}`);
  }

  if (!variable.isMutable) {
    throw new Error(`${id} cannot be re-assigned`);
  }

  const initType = resolveExprType(call.argAt(1));

  if (!typesAreEquivalent(variable.type, initType)) {
    throw new Error(`${id} cannot be assigned to ${initType}`);
  }

  return call;
};

const checkIdentifier = (id: Identifier) => {
  const entity = id.resolve();
  if (!entity) {
    throw new Error(`Unrecognized identifier, ${id}`);
  }

  if (entity.isVariable()) {
    if ((id.location?.startIndex ?? 0) <= (entity.location?.startIndex ?? 0)) {
      throw new Error(`${id} used before defined`);
    }
  }

  return id;
};

const checkIf = (call: Call) => {
  const condType = resolveExprType(call.argAt(0));
  if (!condType || !typesAreEquivalent(condType, bool)) {
    throw new Error("If conditions must resolve to a boolean");
  }
  const thenExpr = call.argAt(1);
  const elseExpr = call.argAt(2);

  // Until unions are supported, return void if no else
  if (!elseExpr) {
    call.type = dVoid;
    return call;
  }

  const thenType = resolveExprType(thenExpr);
  const elseType = resolveExprType(elseExpr);

  // Until unions are supported, throw an error when types don't match
  if (!typesAreEquivalent(thenType, elseType)) {
    throw new Error("If condition clauses do not return same type");
  }

  call.type = thenType;
  return call;
};

const checkBinaryenCall = (call: Call) => {
  const returnTypeCall = call.callArgAt(2);
  call.type = resolveExprType(returnTypeCall.argAt(1));
  return call;
};

const checkLabeledArg = (call: Call) => {
  const expr = call.argAt(1);
  checkTypes(expr);
  call.type = resolveExprType(expr);
  return call;
};

const checkExport = (call: Call) => {
  const block = call.argAt(0);
  if (!block?.isBlock()) {
    throw new Error("Expected export to contain block");
  }

  checkTypes(block);

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

const checkUse = (use: Use) => {
  const path = use.path;

  const entities = resolveUsePath(path);
  if (entities instanceof Array) {
    entities.forEach((e) => use.parent?.registerEntity(e));
  } else {
    use.parent?.registerEntity(entities);
  }

  return use;
};

const resolveUsePath = (path: List): NamedEntity | NamedEntity[] => {
  if (!path.calls("::")) {
    throw new Error(`Invalid use statement ${path}`);
  }

  const [_, left, right] = path.toArray();
  const resolvedModule = left?.isList()
    ? resolveUsePath(left)
    : left?.isIdentifier()
    ? resolveUseIdentifier(left)
    : undefined;

  if (
    !resolvedModule ||
    resolvedModule instanceof Array ||
    !resolvedModule.isModule()
  ) {
    throw new Error(`Invalid use statement, not a module ${path}`);
  }

  const module =
    resolvedModule.phase < 3
      ? checkModuleTypes(resolvedModule)
      : resolvedModule;

  if (!right?.isIdentifier()) {
    throw new Error(`Invalid use statement, expected identifier, got ${right}`);
  }

  if (right?.is("all")) {
    return module.getAllEntities().filter((e) => e.isExported);
  }

  const entity = module.resolveChildEntity(right);
  if (entity && !entity.isExported) {
    throw new Error(
      `Invalid use statement, entity ${right} not is not exported`
    );
  }

  if (entity) {
    return entity;
  }

  const fns = module.resolveChildFns(right).filter((f) => f.isExported);
  if (!fns.length) {
    throw new Error(`No exported entities with name ${right}`);
  }

  return fns;
};

const resolveUseIdentifier = (identifier: Identifier) => {
  if (identifier.is("super")) {
    return identifier.parentModule?.parentModule;
  }

  return identifier.resolve();
};

const checkFnTypes = (fn: Fn): Fn => {
  checkParameters(fn.parameters);

  if (fn.returnTypeExpr) {
    fn.returnType = resolveExprType(fn.returnTypeExpr);
  }

  fn.body = checkTypes(fn.body);

  const inferredReturnType = resolveExprType(fn.body);
  if (!inferredReturnType) {
    throw new Error(
      `Unable to determine fn return type, ${fn.name} ${fn.location}`
    );
  }

  if (!fn.returnType) {
    fn.returnType = inferredReturnType;
    return fn;
  }

  if (!typesAreEquivalent(inferredReturnType, fn.returnType)) {
    throw new Error(
      `Fn, ${fn.name}, return value type (${inferredReturnType?.name}) is not compatible with annotated return type (${fn.returnType?.name}) at ${fn.location}`
    );
  }

  return fn;
};

const checkParameters = (params: Parameter[]) => {
  params.forEach((p) => {
    if (!p.typeExpr) {
      throw new Error(`Unable to determine type for ${p}`);
    }

    const type = resolveExprType(p.typeExpr);
    if (!type) {
      throw new Error(`Unable to resolve type for ${p}`);
    }

    p.type = type;
  });
};

const checkModuleTypes = (mod: VoidModule): VoidModule => {
  mod.phase = 3;
  mod.each(checkTypes);
  mod.phase = 4;
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
  const initializer = checkTypes(variable.initializer);
  variable.initializer = initializer;
  const inferredType = resolveExprType(initializer);

  if (!inferredType) {
    throw new Error(
      `Enable to determine variable initializer return type ${variable.name}`
    );
  }

  if (variable.typeExpr) {
    variable.type = resolveExprType(variable.typeExpr);
  }

  if (variable.type && !typesAreEquivalent(variable.type, inferredType)) {
    throw new Error(
      `${variable.name} of type ${variable.type} is not assignable to ${inferredType}`
    );
  }

  variable.type = variable.type ?? inferredType;

  return variable;
};

const checkObjectType = (obj: ObjectType): ObjectType => {
  obj.fields.forEach((field) => {
    field.typeExpr = checkTypes(field.typeExpr);
    const type = resolveExprType(field.typeExpr);

    if (!type) {
      throw new Error(`Unable to determine type for ${field.typeExpr}`);
    }

    field.type = type;
  });

  return obj;
};

const checkTypeAlias = (alias: TypeAlias): TypeAlias => {
  alias.typeExpr = checkTypes(alias.typeExpr);
  alias.type = resolveExprType(alias.typeExpr);

  if (!alias.type) {
    throw new Error(`Unable to determine type for ${alias.typeExpr}`);
  }

  return alias;
};

const checkListTypes = (list: List) => {
  console.log("Unexpected list");
  console.log(JSON.stringify(list, undefined, 2));
  return list.map(checkTypes);
};

const checkObjectLiteralType = (obj: ObjectLiteral) => {
  obj.fields.forEach((field) => {
    field.initializer = checkTypes(field.initializer);
    field.type = resolveExprType(field.initializer);
  });

  if (!obj.type) {
    obj.type = new ObjectType({
      ...obj.metadata,
      name: `ObjectLiteral-${obj.syntaxId}`,
      value: obj.fields.map((f) => ({
        name: f.name,
        typeExpr: f.initializer,
        type: f.type,
      })),
    });
  }

  return obj;
};

export const resolveExprType = (expr?: Expr): Type | undefined => {
  if (!expr) return;
  if (expr.isInt()) return i32;
  if (expr.isFloat()) return f32;
  if (expr.isBool()) return bool;
  if (expr.isIdentifier()) return getIdentifierType(expr);
  if (expr.isCall()) {
    if (!expr.type) checkTypes(expr);
    return expr.type;
  }
  if (expr.isFn()) return expr.getType();
  if (expr.isTypeAlias()) return expr.type;
  if (expr.isType()) return expr;
  if (expr.isBlock()) return expr.type;
  if (expr.isObjectLiteral()) return expr.type;
};

const getIdentifierType = (id: Identifier): Type | undefined => {
  const entity = id.resolve();
  if (!entity) return;
  if (entity.isVariable()) return entity.type;
  if (entity.isGlobal()) return entity.type;
  if (entity.isParameter()) return entity.type;
  if (entity.isFn()) return entity.getType();
  if (entity.isTypeAlias()) return entity.type;
  if (entity.isType()) return entity;
};

const resolveCallFn = (call: Call): Fn | undefined => {
  const candidates = call.resolveFns(call.fnName);
  if (!candidates) return undefined;
  return candidates.find((candidate) => {
    const params = candidate.parameters;
    return params.every((p, index) => {
      const arg = call.argAt(index);
      if (!arg) return false;
      const argType = resolveExprType(arg);
      if (!argType) {
        throw new Error(`Could not determine type for ${arg}`);
      }
      const argLabel = getExprLabel(arg);
      const labelsMatch = p.label === argLabel;
      return typesAreEquivalent(p.type!, argType) && labelsMatch;
    });
  });
};

const getExprLabel = (expr?: Expr): string | undefined => {
  if (!expr?.isCall()) return;
  if (!expr.calls(":")) return;
  const id = expr.argAt(0);
  if (!id?.isIdentifier()) return;
  return id.value;
};

const typesAreEquivalent = (a?: Type, b?: Type): boolean => {
  if (!a || !b) return false;

  if (a.isPrimitiveType() && b.isPrimitiveType()) {
    return a.id === b.id;
  }

  if (a.isObjectType() && b.isObjectType()) {
    return a.fields.every((field) => {
      const match = b.fields.find((f) => f.name === field.name);
      return match && typesAreEquivalent(field.type, match.type);
    });
  }

  return false;
};
