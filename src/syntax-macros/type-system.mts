import {
  isFloat,
  isList,
  ModuleInfo,
  CDT_ADDRESS_TYPE,
  List,
  Expr,
  Identifier,
  isIdentifier,
  isInt,
  isBool,
  FnType,
  Type,
  Id,
  StructType,
  isStructType,
  PrimitiveType,
  WasmStackType,
  isPrimitiveType,
  i32,
  bool,
  dVoid,
  f32,
  f64,
  i64,
} from "../lib/index.mjs";

export const typeSystem = (list: List, info: ModuleInfo): List => {
  if (!info.isRoot) return list;
  initTypes(list);
  return list.map((expr) => addTypeAnnotationsToExpr(expr, list));
};

const addTypeAnnotationsToExpr = (
  expr: Expr | undefined,
  parent: Expr
): Expr => {
  if (!expr) return new List({});
  if (!isList(expr)) return expr;
  return addTypeAnnotationsToFnCall(expr, parent);
};

const addTypeAnnotationsToFn = (list: List, parent: Expr): List => {
  list.setAsFn();
  const identifier = list.at(1) as Identifier;
  const rawParameters = list.at(2) as List;
  const fn = getMatchingFn({
    identifier,
    args: rawParameters,
    parent: list,
  });

  if (!fn) {
    throw new Error(`Could not find matching function for ${identifier}`);
  }

  const parameters = annotateFnParams(rawParameters, fn);

  const typedBlock = addTypeAnnotationsToExpr(list.at(4), parent);
  if (!isList(typedBlock) || typedBlock.calls("typed-block")) {
    throw new Error("Expected typed-block");
  }

  // Function types are (((paramIdentifier | false) paramType)* returnType:Expr | false) (at this point)
  const suppliedReturnType = fn.returns;

  const inferredReturnType = assertFunctionReturnType(
    typedBlock,
    suppliedReturnType,
    identifier
  );

  const returnType = suppliedReturnType ?? inferredReturnType;
  if (!returnType) {
    console.error(JSON.stringify(list, undefined, 2));
    throw new Error("Could not determine return type of fn");
  }

  fn.returns = returnType;

  return new List({
    value: [
      "define-function",
      fn,
      parameters,
      ["return-type", returnType!],
      typedBlock,
    ],
    context: list,
  });
};

/**
 * For now, all params are assumed to be manually typed.
 * Returns the updated list of parameters
 */
const annotateFnParams = (list: List, parent: Expr): List => {
  if (list.calls("parameters")) {
    throw new Error("Expected function parameters");
  }

  return new List({
    value: [
      "parameters",
      ...list.slice(1).value.flatMap((expr): Expr[] => {
        if (!isList(expr)) {
          throw new Error("All parameters must be typed");
        }

        if (isStruct(expr)) {
          return expr
            .slice(1)
            .value.map((value) => registerStructParamField(value, parent));
        }

        const { identifier, type, label } = getInfoFromRawParam(expr);
        identifier!.setTypeOf(type);
        parent.setVar(identifier!, { kind: "param", type });
        const value = [identifier!, type];
        if (label) value.push(label);
        return [new List({ value, context: expr })];
      }),
    ],
    context: list,
  });
};

const registerStructParamField = (value: Expr, parent: Expr): Expr => {
  if (!isList(value)) {
    throw new Error("All struct parameters must be typed");
  }
  const { identifier, type } = getInfoFromRawParam(value);
  identifier!.setTypeOf(type);
  parent.setVar(identifier!, { kind: "param", type });
  return new List({ value: [identifier!, type] });
};

const addTypeAnnotationsToBlock = (list: List, parent: Expr): List => {
  const annotatedArgs = list
    .slice(1)
    .map((expr) => addTypeAnnotationsToExpr(expr, parent));

  const type = getExprReturnType(annotatedArgs.at(-1));

  if (!type) {
    console.error(JSON.stringify(list, undefined, 2));
    throw new Error("Could not determine return type of preceding block");
  }

  return new List({
    value: ["typed-block", type, ...annotatedArgs.value],
    context: list,
  });
};

const addTypeAnnotationsToFnCall = (list: List, parent: Expr): List => {
  if (list.calls("define-function")) {
    return addTypeAnnotationsToFn(list, parent);
  }
  if (list.calls("define-extern-function")) return list; // TODO: type check this mofo
  if (list.calls("define-type")) return list;
  if (list.calls("define-cdt")) return list;
  if (list.calls("block")) return addTypeAnnotationsToBlock(list, parent);
  if (list.calls("lambda-expr")) return list;
  if (list.calls("quote")) return list;
  if (list.calls("export")) return list; // TODO
  if (list.calls("=")) return list; // TODO
  if (list.calls("root")) return addTypeAnnotationToRoot(list);
  if (list.calls("module")) return addTypeAnnotationToModule(list);
  if (list.calls("bnr") || list.calls("binaryen-mod")) return list;
  if (
    typeof list.at(0)?.value === "string" &&
    (list.at(0)!.value as string).startsWith("define")
  ) {
    return addTypeAnnotationToVar(list, parent);
  }
  if (isPrimitiveFn(list.at(0))) {
    return addTypeAnnotationsToPrimitiveFn(list, parent);
  }

  return addTypeAnnotationToUserFnCall(list, parent);
};

const addTypeAnnotationsToPrimitiveFn = (list: List, parent: Expr): List => {
  const annotatedArgs = list
    .slice(1)
    .value.map((expr) => addTypeAnnotationsToExpr(expr, parent));
  return new List({ value: [list.first()!, ...annotatedArgs], context: list });
};

function addTypeAnnotationToUserFnCall(list: List, parent: Expr) {
  const fn = getMatchingFnForCallExpr(list);
  if (!fn) {
    console.error(JSON.stringify(list, undefined, 2));
    throw new Error("Could not find matching fn for above call expression");
  }

  const annotatedArgs = list.slice(1).value.flatMap((expr, index) => {
    const paramType = (fn.getTypeOf() as FnType).getParam(index);
    if (isStructType(paramType) && isStruct(expr)) {
      return applyStructParams(paramType, expr as List);
    }

    return [addTypeAnnotationsToExpr(expr, parent)];
  });

  return new List({ value: [fn, ...annotatedArgs], context: list });
}

/** Re-orders the supplied struct and returns it as a normal list of expressions to be passed as args */
const applyStructParams = (
  expectedStruct: StructType,
  suppliedStruct: List
): Expr[] =>
  expectedStruct.value.map(({ name }) => {
    const arg = suppliedStruct
      .slice(1)
      .value.find((expr) => (expr as List).at(1)?.is(name)) as List;
    if (!arg) throw new Error(`Could not find arg for field ${name}`);
    return arg.at(2)!;
  });

const addTypeAnnotationToRoot = (list: List): List =>
  list.map((expr) => addTypeAnnotationsToExpr(expr, list));

const addTypeAnnotationToModule = (list: List): List => {
  list.value[4] = (list.value[4] as List).map((expr) =>
    addTypeAnnotationsToExpr(expr, list)
  );
  return list;
};

const addTypeAnnotationToVar = (list: List, parent: Expr): List => {
  const varFnId = list.at(0) as Identifier;
  const mut = varFnId.value.includes("define-mut");
  const global = varFnId.value.includes("global");
  const initializer = list.at(2);
  const inferredType = getExprReturnType(initializer);
  const annotatedInitializer = addTypeAnnotationsToExpr(list.at(2), parent);
  // Get identifier from a potentially untyped definition
  const identifier = isList(list.at(1))
    ? ((list.at(1) as List).at(1) as Identifier) // Typed case
    : (list.at(1) as Identifier); // Untyped case
  const suppliedType = isList(list.at(1))
    ? isStruct(list.at(1) as List)
      ? typedStructListToStructType(list.at(1) as List)
      : list.getType(identifier)!
    : undefined;

  if (suppliedType && !typesMatch(suppliedType, inferredType)) {
    throw new Error(
      `${identifier} of type ${suppliedType} is not assignable to ${inferredType}`
    );
  }

  const type = suppliedType ?? inferredType;
  if (!type) {
    throw new Error(`Could not determine type for identifier ${identifier}`);
  }

  identifier.setTypeOf(type);
  parent.setVar(identifier, { kind: global ? "global" : "var", mut, type });

  return new List({
    value: [varFnId, identifier, annotatedInitializer],
    context: list,
  });
};

const getExprReturnType = (expr?: Expr): Type | undefined => {
  if (!expr) return;
  if (isInt(expr)) return i32;
  if (isFloat(expr)) return f32;
  if (isBool(expr)) return bool;
  if (expr.is("void")) return dVoid;
  if (isIdentifier(expr)) return expr.getTypeOf();
  if (!isList(expr)) throw new Error(`Invalid expression ${expr}`);

  if (expr.calls("labeled-expr")) return getExprReturnType(expr.at(2));
  if (expr.calls("block")) getExprReturnType(expr.at(-1));
  if (expr.calls("struct")) return getStructLiteralType(expr);
  if (expr.calls("bnr") || expr.calls("binaryen-mod")) {
    return getBnrReturnType(expr);
  }
  if (expr.calls("if")) return getIfReturnType(expr);

  const fn = getMatchingFnForCallExpr(expr);
  return fn?.props.get("returnType");
};

/** Takes the expression form of a struct and converts it into type form */
const getStructLiteralType = (ast: List): StructType =>
  new StructType({
    value: ast.slice(1).value.map((labeledExpr) => {
      const list = labeledExpr as List;
      const identifier = list.at(1) as Identifier;
      const type = getExprReturnType(list.at(2));
      if (!type) {
        throw new Error("Could not determine type for struct literal");
      }
      return { name: identifier.value, type };
    }),
    parent: ast,
  });

// TODO type check this mofo
const getIfReturnType = (list: List): Type | undefined =>
  getExprReturnType(list.at(2));

const getBnrReturnType = (call: List): Type | undefined => {
  const info = call.at(1) as List | undefined;
  const id = info?.at(2) as Identifier;
  return new PrimitiveType({ context: id, value: id.value as WasmStackType });
};

const getMatchingFnForCallExpr = (call: List): FnType | undefined => {
  const identifier = call.first() as Identifier;
  const args = call.slice(1);
  const fn = getMatchingFn({ identifier, args, parent: call });
  if (fn) identifier.setTypeOf(fn);
  return fn;
};

const getMatchingFn = ({
  identifier,
  args,
  parent,
}: {
  identifier: Identifier;
  args: List;
  parent: Expr;
}): FnType | undefined => {
  const candidates = parent.getFns(identifier);
  if (!candidates) return undefined;
  return candidates.find((candidate) => {
    const params = candidate.value.params;
    return params.every((p, index) => {
      const arg = args.at(index);
      if (!arg) return false;
      const argType = getExprReturnType(arg);
      const argLabel = getExprLabel(arg);
      const labelsMatch = p.label === argLabel;
      return typesMatch(p.type, argType) && labelsMatch;
    });
  });
};

const getExprLabel = (expr?: Expr): string | undefined => {
  if (!isList(expr)) return;
  if (!expr.first()?.is("labeled-expr")) return;
  return expr.at(1)!.value as string;
};

const typesMatch = (expected?: Type, given?: Type) => {
  if (isStructType(expected) && isStructType(given)) {
    return structArgsMatch(expected, given);
  }

  return expected?.is(given) || isStructPointerMatch(expected, given);
};

// Until a more complex type system is implemented, assume that non-primitive types
// Can be treated as i32's.
const isStructPointerMatch = (expected?: Type, given?: Expr) =>
  (!isPrimitiveType(expected) && given?.is(CDT_ADDRESS_TYPE)) ||
  (!isPrimitiveType(given) && expected?.is(CDT_ADDRESS_TYPE));

const structArgsMatch = (expected: StructType, given: StructType): boolean => {
  return (
    expected.value.length === given.value.length &&
    expected.value.every((field) =>
      given.value.some((arg) => typesMatch(field.type, arg.type))
    )
  );
};

const initTypes = (list: List) => {
  list.setType("i32", i32);
  list.setType("f32", f32);
  list.setType("i32", i64);
  list.setType("f32", f64);
  list.setType("bool", bool);
  list.setType("void", dVoid);
  return list.value.forEach((expr) => {
    if (!isList(expr)) return;
    const isFnDef =
      expr.calls("define-function") || expr.calls("define-extern-function");

    if (isFnDef) {
      initFn(expr, list);
      return;
    }

    if (expr.calls("define-type")) {
      const id = expr.at(1) as Identifier;
      const val = expr.at(2) as Expr;
      id.binding = expr;

      // Todo support more than primitives and structs;
      const type = isStruct(val)
        ? typedStructListToStructType(val as List)
        : list.getType(id)!;

      list.setType(id, type);
    }
  });
};

const initFn = (expr: List, parent: Expr) => {
  const fnIdentifier = expr.at(1) as Identifier;
  fnIdentifier.binding = expr;
  const parametersIndex = expr.first()?.is("define-function") ? 2 : 3;
  const params = (expr.at(parametersIndex) as List).value.slice(1).map((p) => {
    // For now assume all params are either structs or labeled expressions
    const { label, identifier, type } = getInfoFromRawParam(p as List);
    if (identifier) {
      identifier.setTypeOf(type);
    }

    return { label: label?.value, name: identifier?.value, type };
  });
  const suppliedReturnType = getSuppliedReturnTypeForFn(expr);

  const fnType = new FnType({
    context: expr,
    value: { params, returns: suppliedReturnType },
  });
  fnIdentifier.setTypeOf(fnType);

  parent.setFn(fnIdentifier, fnType);
};

const getSuppliedReturnTypeForFn = (list: List): Type | undefined => {
  const returnDef = (list.at(3) as List).at(1) as Identifier;
  return list.getType(returnDef);
};

const getInfoFromRawParam = (list: List) => {
  const isLabeled = !isStruct(list) && isList(list.at(2));
  const paramDef = isLabeled ? (list.at(2) as List) : list;
  const identifier = isStruct(list)
    ? undefined
    : (paramDef.at(1) as Identifier);
  const type = isStruct(list)
    ? typedStructListToStructType(list)
    : list.getType(paramDef.at(2)! as Identifier)!;
  const label = isLabeled ? (list.at(1) as Identifier) : undefined;
  return { identifier, type, label };
};

const typedStructListToStructType = (list: List): StructType => {
  return new StructType({
    context: list,
    value: list.value.map((v) => {
      // v is always a labeled expression
      const labeledExpr = v as List;
      const name = labeledExpr.at(2) as Identifier;
      const typeId = labeledExpr.at(2) as Identifier;
      const type = list.getType(typeId);
      if (!type) {
        throw new Error(`Unrecognized type ${typeId.value}`);
      }
      return { name: name.value, type };
    }),
  });
};

function assertFunctionReturnType(
  typedBlock: List,
  suppliedReturnType: Type | undefined,
  identifier: Id
): Type {
  const inferredReturnType = typedBlock.at(1) as Type;
  const shouldCheckInferredType =
    suppliedReturnType && !suppliedReturnType?.is("void");
  const typeMismatch =
    shouldCheckInferredType &&
    !typesMatch(suppliedReturnType, inferredReturnType);

  if (typeMismatch) {
    throw new Error(
      `Expected fn ${identifier} to return ${suppliedReturnType}, got ${inferredReturnType}`
    );
  }
  return inferredReturnType;
}

const isStruct = (expr?: Expr) => isList(expr) && expr.calls("struct");
const isPrimitiveFn = (expr?: Expr) => {
  if (typeof expr !== "string") return false;
  return new Set(["if", "="]).has(expr);
};
