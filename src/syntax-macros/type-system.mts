import {
  isFloat,
  isList,
  ModuleInfo,
  isPrimitiveType,
  CDT_ADDRESS_TYPE,
  List,
  Expr,
  Identifier,
  isIdentifier,
  isInt,
  isBool,
  Bool,
} from "../lib/index.mjs";

export const typeSystem = (list: List, info: ModuleInfo): List => {
  if (!info.isRoot) return list;
  setFunctionMap(list);
  return list.map((expr) => addTypeAnnotationsToExpr(expr));
};

const addTypeAnnotationsToExpr = (expr?: Expr): Expr => {
  if (!expr) return new List({});
  if (!isList(expr)) return expr;
  return addTypeAnnotationsToFnCall(expr);
};

const addTypeAnnotationsToFn = (list: List): List => {
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

  const typedBlock = addTypeAnnotationsToExpr(list.at(4));
  if (!isList(typedBlock) || typedBlock.at(0)?.is("typed-block")) {
    throw new Error("Expected typed-block");
  }

  // Function types are (((paramIdentifier | false) paramType)* returnType:Expr | false) (at this point)
  const fnType = fn.getType() as List | undefined;
  const suppliedReturnType = fnType?.at(1);

  const inferredReturnType = assertFunctionReturnType(
    typedBlock,
    suppliedReturnType,
    identifier.value
  );

  const returnType = suppliedReturnType ?? inferredReturnType;

  const newBody = new List({
    value: [
      "define-function",
      fn,
      parameters,
      ["return-type", returnType!],
      typedBlock,
    ],
    context: fn,
  });

  fn.bind = newBody;
  return newBody;
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
        identifier!.setType(type);
        identifier!.setKind("param");
        parent.setVar(identifier!);
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
  identifier!.setType(type);
  parent.setVar(identifier!);
  return new List({ value: [identifier!, type] });
};

const addTypeAnnotationsToBlock = (list: List): List => {
  const annotatedArgs = list
    .slice(1)
    .map((expr) => addTypeAnnotationsToExpr(expr));

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

const addTypeAnnotationsToFnCall = (list: List): List => {
  if (list.calls("define-function")) return addTypeAnnotationsToFn(list);
  if (list.calls("define-extern-function")) return list; // TODO: type check this mofo
  if (list.calls("define-type")) return list; // TODO: type check this mofo
  if (list.calls("define-cdt")) return list; // TODO: type check this mofo
  if (list.calls("block")) return addTypeAnnotationsToBlock(list);
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
    return addTypeAnnotationToVar(list);
  }
  if (isPrimitiveFn(list.at(0))) {
    return addTypeAnnotationsToPrimitiveFn(list);
  }

  return addTypeAnnotationToUserFnCall(list);
};

const addTypeAnnotationsToPrimitiveFn = (list: List): List => {
  const annotatedArgs = list
    .slice(1)
    .value.map((expr) => addTypeAnnotationsToExpr(expr));
  return new List({ value: [list.first()!, ...annotatedArgs], context: list });
};

function addTypeAnnotationToUserFnCall(list: List) {
  const fn = getMatchingFnForCallExpr(list);
  if (!fn) {
    console.error(JSON.stringify(list, undefined, 2));
    throw new Error("Could not find matching fn for above call expression");
  }

  const annotatedArgs = list.slice(1).value.flatMap((expr, index) => {
    const paramType = (fn.getType() as List).at(index);
    if (isStruct(paramType) && isStruct(expr)) {
      return applyStructParams(paramType as List, expr as List);
    }

    return [addTypeAnnotationsToExpr(expr)];
  });

  return new List({ value: [fn, ...annotatedArgs], context: list });
}

/** Re-orders the supplied struct and returns it as a normal list of expressions to be passed as args */
const applyStructParams = (expectedStruct: List, suppliedStruct: List): List =>
  expectedStruct.slice(1).map((expr) => {
    const labeledExpr = expr as List;
    const label = labeledExpr.at(1) as Identifier;
    const arg = suppliedStruct
      .slice(1)
      .value.find((expr) => (expr as List).at(1)?.is(label)) as List;
    if (!arg) throw new Error(`Could not find arg for field ${label}`);
    return arg.at(2)!;
  });

const addTypeAnnotationToRoot = (ast: List): List =>
  ast.map((expr) => addTypeAnnotationsToExpr(expr));

const addTypeAnnotationToModule = (list: List): List => {
  list.value[4] = (list.value[4] as List).map((expr) =>
    addTypeAnnotationsToExpr(expr)
  );
  return list;
};

const addTypeAnnotationToVar = (list: List): List => {
  const varFnId = list.at(0) as Identifier;
  const mutable = varFnId.value.includes("define-mut");
  const global = varFnId.value.includes("global");
  const initializer = list.at(2);
  const inferredType = getExprReturnType(initializer);
  const annotatedInitializer = addTypeAnnotationsToExpr(list.at(2));
  const suppliedType = isList(list.at(1))
    ? (list.at(1) as List).at(2)
    : undefined;

  // Get identifier from a potentially untyped definition
  const identifier = isList(list.at(1))
    ? ((list.at(1) as List).at(1) as Identifier) // Typed case
    : (list.at(1) as Identifier); // Untyped case

  if (suppliedType && !typesMatch(suppliedType, inferredType)) {
    throw new Error(
      `${identifier} of type ${suppliedType} is not assignable to ${inferredType}`
    );
  }

  const type = suppliedType ?? inferredType;
  if (!type) {
    throw new Error(`Could not determine type for identifier ${identifier}`);
  }

  identifier.setType(type);
  identifier.setKind(global ? "global" : "var");
  identifier.isMutable = mutable;

  return new List({
    value: [varFnId, identifier, annotatedInitializer],
    context: list,
  });
};

const getExprReturnType = (expr?: Expr): Expr | undefined => {
  if (!expr) return;
  if (isInt(expr)) return i32;
  if (isFloat(expr)) return f32;
  if (isBool(expr)) return bool;
  if (expr.is("void")) return dVoid;
  if (isIdentifier(expr)) return expr.getType();
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
const getStructLiteralType = (ast: List): List =>
  new List({
    value: [
      "struct",
      ...ast.slice(1).value.map((labeledExpr) => {
        const list = labeledExpr as List;
        const identifier = list.at(1) as Identifier;
        const type = getExprReturnType(list.at(2));
        if (!type) {
          throw new Error("Could not determine type for struct literal");
        }
        return ["labeled-expr", identifier, type];
      }),
    ],
    parent: ast,
  });

const getIfReturnType = (list: List): Expr | undefined => {
  // TODO type check this mofo
  return getExprReturnType(list.at(2));
};

const getBnrReturnType = (call: List): Expr | undefined => {
  const info = call.at(1) as List | undefined;
  return info?.at(2);
};

const getMatchingFnForCallExpr = (call: List): Identifier | undefined => {
  const identifier = call.first() as Identifier;
  const args = call.slice(1);
  return getMatchingFn({ identifier, args, parent: call });
};

const getMatchingFn = ({
  identifier,
  args,
  parent,
}: {
  identifier: Identifier;
  args: List;
  parent: Expr;
}): Identifier | undefined => {
  const candidates = parent.getFns(identifier);
  if (!candidates) return undefined;
  return candidates.find((candidate) => {
    // Function types are (((paramIdentifier | false) paramType)* returnType:Expr)
    const params = (candidate.getType() as List).at(0) as List;
    return params.value.every((p, index) => {
      const arg = args.at(index);
      if (!arg) return false;
      const argType = getExprReturnType(arg);
      const argLabel = getExprLabel(arg);
      const paramInfo = p as List;
      const param = isIdentifier(paramInfo.at(0))
        ? (paramInfo.at(0) as Identifier)
        : undefined;
      const labelsMatch = param?.label === argLabel;
      return typesMatch((p as Identifier).getType(), argType) && labelsMatch;
    });
  });
};

const getExprLabel = (expr?: Expr): string | undefined => {
  if (!isList(expr)) return;
  if (!expr.first()?.is("labeled-expr")) return;
  return expr.at(1)!.value as string;
};

const typesMatch = (expected?: Expr, given?: Expr) => {
  if (isStruct(expected) && isStruct(given)) {
    return structArgsMatch(expected as List, given as List);
  }

  return expected?.is(given) || isStructPointerMatch(expected, given);
};

// Until a more complex type system is implemented, assume that non-primitive types
// Can be treated as i32's. This is obviously dangerous. But a type checker should catch
// the bugs this could cause before we reach the code gen phase anyway.
const isStructPointerMatch = (expected?: Expr, given?: Expr) =>
  (!isPrimitiveType(expected) && given?.is(CDT_ADDRESS_TYPE)) ||
  (!isPrimitiveType(given) && expected?.is(CDT_ADDRESS_TYPE));

const structArgsMatch = (expected: List, given: List): boolean => {
  return (
    expected.value.length === given.value.length &&
    expected.slice(1).value.every((fieldTypeList) =>
      given.slice(1).value.some((argTypeList) => {
        // Both fieldTypeAst and argTypeAst should be labeled-exprs
        const fieldType = (fieldTypeList as List).at(2);
        const argType = (argTypeList as List).at(2);
        return typesMatch(fieldType, argType);
      })
    )
  );
};

const setFunctionMap = (list: List) => {
  return list.value.forEach((expr) => {
    if (!isList(expr)) return;

    const isFnDef =
      expr.first()?.is("define-function") &&
      expr.first()?.is("define-extern-function");

    if (!isFnDef) {
      setFunctionMap(expr);
      return;
    }

    const fnIdentifier = expr.at(1) as Identifier;
    fnIdentifier.bind = expr;
    const parametersIndex = expr.first()?.is("define-function") ? 2 : 3;
    const params = (expr.at(parametersIndex) as List).slice(1).map((p) => {
      // For now assume all params are either structs or labeled expressions
      const { label, identifier, type } = getInfoFromRawParam(p as List);
      if (identifier) {
        identifier.setKind("param");
        identifier.setType(type);
        identifier.label = label?.value;
      }

      return new List({
        parent: expr,
        value: [identifier ?? new Bool({ value: false }), type],
      });
    });
    const suppliedReturnType = getSuppliedReturnTypeForFn(expr);
    const value: Expr[] = [params];
    if (suppliedReturnType) value.push(suppliedReturnType);
    fnIdentifier.setType(new List({ value, parent: expr }));

    list.setFn(fnIdentifier);
  });
};

const getSuppliedReturnTypeForFn = (list: List): Expr | undefined => {
  const returnDef = (list.at(3) as List).at(1);
  return isIdentifier(returnDef)
    ? returnDef
    : isList(returnDef) && returnDef.at(0)?.is("cdt-pointer")
    ? returnDef.at(1)!
    : returnDef;
};

const getInfoFromRawParam = (list: List) => {
  const isLabeled = !isStruct(list) && isList(list.at(2));
  const paramDef = isLabeled ? (list.at(2) as List) : list;
  const identifier = isStruct(list)
    ? undefined
    : (paramDef.at(1) as Identifier);
  const type = isStruct(list) ? list : paramDef.at(2)!;
  const label = isLabeled ? (list.at(1) as Identifier) : undefined;
  return { identifier, type, label };
};

function assertFunctionReturnType(
  typedBlock: List,
  suppliedReturnType: Expr | undefined,
  identifier: string
) {
  const inferredReturnType = typedBlock.at(1);
  const shouldCheckInferredType =
    suppliedReturnType && suppliedReturnType?.is("void");
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

const isStruct = (expr?: Expr) => isList(expr) && expr.first()?.is("struct");
const isPrimitiveFn = (expr?: Expr) => {
  if (typeof expr !== "string") return false;
  return new Set(["if", "="]).has(expr);
};

const i32 = Identifier.from("i32");
const f32 = Identifier.from("f32");
const bool = Identifier.from("i32");
const dVoid = Identifier.from("void");
