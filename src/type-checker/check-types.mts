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
  return expr;
};

const checkBlockTypes = (block: Block): Block => {
  return block.each(checkTypes);
};

const checkCallTypes = (call: Call): Call => {
  if (call.calls("export")) return checkExport(call);
  if (call.calls("if")) return checkIf(call);
  if (call.calls("use")) return checkUse(call);
  if (call.calls("binaryen")) return checkBinaryenCall(call);
  if (call.calls(":")) return checkLabeledArg(call);
  call.eachArg(checkTypes);
  call.fn = resolveCallFn(call);
  if (!call.fn) {
    throw new Error(`Could not resolve fn ${call.fnName}`);
  }
  call.type = call.fn.getReturnType();
  return call;
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

// TODO: Maybe type check this??
const checkBinaryenCall = (call: Call) => {
  call.type = resolveExprType(call.argAt(2));
  return call;
};

const checkLabeledArg = (call: Call) => {
  checkTypes(call.argAt(1));
  return call;
};

const checkExport = (call: Call) => {
  const block = call.argAt(0);
  if (!block?.isBlock()) {
    throw new Error("Expected export to contain block");
  }

  const entities = block.getAllEntities();
  entities.forEach((e) => {
    e.isExported = true;
    call.parent?.registerEntity(e);
  });

  return call;
};

const checkUse = (use: Call) => {
  const path = use.argAt(0);
  if (!path?.isCall()) throw new Error("Expected use path");

  const entities = resolveUsePath(path);
  if (entities instanceof Array) {
    entities.forEach((e) => use.parent?.registerEntity(e));
  } else {
    use.parent?.registerEntity(entities);
  }
  return use;
};

const resolveUsePath = (path: Call): NamedEntity | NamedEntity[] => {
  if (!path.calls("::")) {
    throw new Error(`Invalid use statement ${path}`);
  }

  const [left, right] = [path.argAt(0), path.argAt(1)];
  const resolvedModule = left?.isCall()
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
    resolvedModule.phase < 4
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
  checkTypes(fn.body);

  if (fn.returnTypeExpr) {
    fn.returnType = resolveExprType(fn.returnType);
  }

  const inferredReturnType = resolveExprType(fn.body);
  if (!inferredReturnType) {
    throw new Error(`Unable to determine fn return type, ${fn.name}`);
  }

  if (!fn.returnType) {
    fn.returnType = inferredReturnType;
    return fn;
  }

  if (!typesAreEquivalent(inferredReturnType, fn.returnType)) {
    throw new Error(`Fn ${fn.name} return value does not match return type`);
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
  body.value.forEach((expr) => {
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

const resolveExprType = (expr?: Expr): Type | undefined => {
  if (!expr) return;
  if (expr.isInt()) return i32;
  if (expr.isFloat()) return f32;
  if (expr.isBool()) return bool;
  if (expr.isIdentifier()) return getIdentifierType(expr);
  if (expr.isCall()) return expr.type;
  if (expr.isFn()) return expr.getType();
  if (expr.isType()) return expr;
  if (expr.isBlock()) return resolveExprType(expr.lastExpr());
};

const getIdentifierType = (id: Identifier): Type | undefined => {
  const entity = id.resolve();
  if (!entity) return;
  if (entity.isVariable()) return entity.type;
  if (entity.isGlobal()) return entity.type;
  if (entity.isParameter()) return entity.type;
  if (entity.isFn()) return entity.getType();
  if (entity.isType()) return entity;
};

/** Takes the expression form of a struct and converts it into type form */
const getObjectLiteralType = (ast: List): ObjectType =>
  new ObjectType({
    ...ast.metadata,
    name: "literal",
    value: ast.slice(1).value.map((labeledExpr) => {
      const list = labeledExpr as List;
      const identifier = list.at(1) as Identifier;
      const type = resolveExprType(list.at(2));
      if (!type) {
        throw new Error("Could not determine type for struct literal");
      }
      return { name: identifier.value, type };
    }),
  });

const checkListTypes = (list: List) => {
  console.log("Unexpected list");
  console.log(JSON.stringify(list, undefined, 2));
  return list.map(checkTypes);
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
  return false;
};
