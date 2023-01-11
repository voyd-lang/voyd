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
  noop,
  isFnType,
} from "../lib/index.mjs";
import { getIdStr } from "../lib/syntax/get-id-str.mjs";

export const typeSystem = (list: List, info: ModuleInfo): List => {
  if (!info.isRoot) return list;
  initTypes(list);
  return addTypeAnnotationsToExpr(list) as List;
};

const addTypeAnnotationsToExpr = (expr: Expr | undefined): Expr => {
  if (!expr) return noop();
  if (!isList(expr)) return expr;
  return addTypeAnnotationsToFnCall(expr);
};

const addTypeAnnotationsToFnCall = (list: List): List => {
  if (list.calls("define-function")) return addTypeAnnotationsToFn(list);
  if (list.calls("define-extern-function")) return list; // TODO: type check this mofo
  if (list.calls("define-type")) return list;
  if (list.calls("define-cdt")) return list;
  if (list.calls("block")) return addTypeAnnotationsToBlock(list);
  if (list.calls("lambda-expr")) return list;
  if (list.calls("struct")) return list;
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

const addTypeAnnotationsToFn = (list: List): List => {
  list.setAsFn();
  const identifier = list.at(1) as Identifier;
  const rawParameters = list.at(2) as List;
  const fn = list.getTypeOf();

  if (!isFnType(fn)) {
    throw new Error(`Could not find matching function for ${identifier.value}`);
  }

  const parameters = annotateFnParams(rawParameters);

  const typedBlock = addTypeAnnotationsToExpr(list.at(4));
  if (!isList(typedBlock) || !typedBlock.calls("typed-block")) {
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

  // Note to future self. This is why references can be so nice to have. But we should probably have an &mut syntax
  fn.returns = returnType;
  identifier.setTypeOf(fn);

  return new List({
    value: [
      "define-function",
      identifier,
      parameters,
      ["return-type", returnType!],
      typedBlock,
    ],
    from: list,
  });
};

/**
 * For now, all params are assumed to be manually typed.
 * Returns the updated list of parameters
 */
const annotateFnParams = (params: List): List => {
  if (!params.calls("parameters")) {
    throw new Error("Expected function parameters");
  }

  const fnDef = params.getParent() as List;

  return new List({
    value: [
      "parameters",
      ...params.slice(1).value.flatMap((expr): Expr[] => {
        if (!isList(expr)) {
          throw new Error("All parameters must be typed");
        }

        if (isStruct(expr)) {
          return expr
            .slice(1)
            .value.map((value) => registerStructParamField(value, fnDef));
        }

        const { identifier, type, label } = getInfoFromRawParam(expr);
        identifier!.setTypeOf(type);
        fnDef.setVar(identifier!, { kind: "param", type });
        const value = [identifier!, type];
        if (label) value.push(label);
        return [new List({ value, from: expr })];
      }),
    ],
    from: params,
  });
};

const registerStructParamField = (value: Expr, fnDef: Expr): Expr => {
  if (!isList(value)) {
    throw new Error("All struct parameters must be typed");
  }
  const { identifier, type } = getInfoFromRawParam(value);
  identifier!.setTypeOf(type);
  fnDef.setVar(identifier!, { kind: "param", type });
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
    from: list,
  });
};

const addTypeAnnotationsToPrimitiveFn = (list: List): List => {
  const annotatedArgs = list
    .slice(1)
    .value.map((expr) => addTypeAnnotationsToExpr(expr));
  return new List({ value: [list.first()!, ...annotatedArgs], from: list });
};

function addTypeAnnotationToUserFnCall(list: List) {
  const identifier = list.first() as Identifier;
  list.rest().forEach(addTypeAnnotationsToExpr);
  const fn = getMatchingFnForCallExpr(list);
  if (!fn) {
    console.error(JSON.stringify(list, undefined, 2));
    throw new Error("Could not find matching fn for above call expression");
  }

  const annotatedArgs = list.slice(1).value.flatMap((expr, index) => {
    const paramType = fn.getParam(index);
    if (isStructType(paramType) && isStruct(expr)) {
      return applyStructParams(paramType, expr as List);
    }

    return [addTypeAnnotationsToExpr(expr)];
  });

  identifier.setTypeOf(fn);
  return new List({ value: [identifier, ...annotatedArgs], from: list });
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
  list.map((expr) => addTypeAnnotationsToExpr(expr));

const addTypeAnnotationToModule = (list: List): List => {
  list.value[4] = (list.value[4] as List).map((expr) =>
    addTypeAnnotationsToExpr(expr)
  );
  return list;
};

const addTypeAnnotationToVar = (list: List): List => {
  const varFnId = list.at(0) as Identifier;
  const mut = varFnId.value.includes("define-mut");
  const global = varFnId.value.includes("global");
  const initializer = list.at(2);
  const inferredType = getExprReturnType(initializer);
  const annotatedInitializer = addTypeAnnotationsToExpr(initializer?.clone());
  // Get identifier from a potentially untyped definition
  const def = list.at(1)!;
  const identifier = isList(def)
    ? (def.at(1) as Identifier) // Typed case
    : (def as Identifier); // Untyped case
  const suppliedType = isList(def)
    ? isStruct(def)
      ? typedStructListToStructType(def)
      : getTypeFromLabeledExpr(def)
    : undefined;

  if (suppliedType && !typesMatch(suppliedType, inferredType)) {
    throw new Error(
      `${identifier} of type ${suppliedType} is not assignable to ${inferredType}`
    );
  }

  const type = suppliedType ?? inferredType;
  if (!type) {
    throw new Error(
      `Could not determine type for identifier ${identifier.value}`
    );
  }

  identifier.setTypeOf(type);
  list
    .getParent()
    ?.setVar(identifier, { kind: global ? "global" : "var", mut, type });

  return new List({
    value: [varFnId, identifier, annotatedInitializer],
    from: list,
  });
};

const getTypeFromLabeledExpr = (def: List): Type | undefined => {
  if (!def.calls("labeled-expr")) {
    throw new Error("Expected labeled expression");
  }
  const typeId = def.at(2);
  if (!isIdentifier(typeId)) {
    throw new Error("Param type annotations must be identifiers (for now)");
  }

  return def.getType(typeId);
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
  if (expr.calls("block")) return getExprReturnType(expr.at(-1));
  if (expr.calls("struct")) return getStructLiteralType(expr);
  if (expr.calls("bnr") || expr.calls("binaryen-mod")) {
    return getBnrReturnType(expr);
  }
  if (expr.calls("if")) return getIfReturnType(expr);

  const fn = getMatchingFnForCallExpr(expr);
  return fn?.returns;
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
  return new PrimitiveType({ from: id, value: id.value as WasmStackType });
};

const getMatchingFnForCallExpr = (call: List): FnType | undefined => {
  const identifier = call.first() as Identifier;
  const args = call.slice(1);
  const fn = getMatchingFn({ identifier, args });
  if (fn) identifier.setTypeOf(fn);
  return fn;
};

const getMatchingFn = ({
  identifier,
  args,
}: {
  identifier: Identifier;
  args: List;
}): FnType | undefined => {
  const candidates = identifier.getFns(identifier);
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
  list.setType("i64", i64);
  list.setType("f64", f64);
  list.setType("bool", bool);
  list.setType("void", dVoid);
  const scan = (expr: Expr) => {
    if (!isList(expr)) return;
    const isFnDef =
      expr.calls("define-function") || expr.calls("define-extern-function");

    if (isFnDef) {
      initFn(expr);
      return;
    }

    if (expr.calls("define-type")) {
      const id = expr.at(1) as Identifier;
      const val = expr.at(2) as Expr;

      // Todo support more than primitives and structs;
      const type = isStruct(val)
        ? typedStructListToStructType(val as List)
        : list.getType(id)!;

      list.setType(id, type);
      return;
    }

    if (expr.calls("export")) {
      initExport(expr);
      return;
    }

    expr.value.forEach(scan);
  };
  return scan(list);
};

const initFn = (expr: List) => {
  const parent = expr.getParent()!;
  const fnIdentifier = expr.at(1) as Identifier;
  const paramsIndex = expr.calls("define-function") ? 2 : 3;
  const params = (expr.at(paramsIndex) as List).value.slice(1).map((p) => {
    // For now assume all params are either structs or labeled expressions
    const { label, identifier, type } = getInfoFromRawParam(p as List);
    if (identifier) {
      identifier.setTypeOf(type);
    }

    return { label: label?.value, name: identifier?.value, type };
  });
  const suppliedReturnType = getSuppliedReturnTypeForFn(expr, paramsIndex + 1);

  const fnType = new FnType({
    from: expr,
    value: { params, returns: suppliedReturnType },
  });

  expr.setTypeOf(fnType);
  fnIdentifier.setTypeOf(fnType);
  parent.setFn(fnIdentifier, fnType);
};

const initExport = (exp: List) => {
  // Module Block > Module > Root Block (hopefully this applies to other places an export might occur)
  const target = exp.getParent()?.getParent()?.getParent();
  if (!target) {
    throw new Error("Nothing to export to");
  }

  const exportId = exp.at(1);
  if (!isIdentifier(exportId)) {
    throw new Error("Missing identifier in export");
  }

  const params = exp.at(2);
  if (isList(params) && params.calls("parameters")) {
    initFnExport(exportId, params, target);
    return;
  }
};

const initFnExport = (fnId: Identifier, params: List, exportTarget: Expr) => {
  const candidates = fnId.getFns(fnId);
  const fn = candidates.find((candidate) =>
    candidate.value.params.every((param, index) => {
      const p = params.at(index + 1);
      if (!isList(p)) return false;
      const { label, identifier, type } = getInfoFromRawParam(p as List);
      const identifiersMatch = identifier ? identifier.is(param.name) : true;
      const labelsMatch = label ? label.is(param.label) : true;
      const typesDoMatch = typesMatch(param.type, type);
      return typesDoMatch && identifiersMatch && labelsMatch;
    })
  );
  if (fn) exportTarget.setFn(fnId, fn);
};

const getSuppliedReturnTypeForFn = (
  list: List,
  defIndex: number
): Type | undefined => {
  const definition = list.at(defIndex);
  if (!isList(definition)) return undefined;
  const identifier = definition.at(1); // Todo: Support inline context data types?
  if (!isIdentifier(identifier)) return undefined;
  return list.getType(identifier);
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
    from: list,
    value: list.value.slice(1).map((v) => {
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
  if (!isIdentifier(expr)) return false;
  return new Set(["if", "="]).has(getIdStr(expr));
};
