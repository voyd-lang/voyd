import {
  isFloat,
  isList,
  ModuleInfo,
  toIdentifier,
  isPrimitiveType,
  CDT_ADDRESS_TYPE,
} from "../lib/index.mjs";
import { AST, Expr } from "../parser.mjs";

type TypeInfo = {
  params: VarMap;
  vars: VarMap;
  globals: VarMap;
  fns: FnMap;
};

type FnMap = Map<string, Fn[]>;
type Fn = {
  params: Param[];
  returnType?: Expr;
};

type Param = { type: Expr; label?: string };

type VarMap = Map<string, Variable>;
type Variable = {
  type: Expr;
  /** Label is used for parameter definitions where the caller must pass the label. */
  label?: string;
  /** Defaults to false if undefined */
  mutable?: boolean;
};

export const typeSystem = (ast: AST, info: ModuleInfo): AST => {
  if (!info.isRoot) return ast;
  const types: TypeInfo = {
    globals: new Map(),
    vars: new Map(),
    params: new Map(),
    fns: genFunctionMap(ast),
  };
  return ast.map((expr) => addTypeAnnotationsToExpr(expr, types));
};

const addTypeAnnotationsToExpr = (expr: Expr, types: TypeInfo): Expr => {
  if (!isList(expr)) return expr;
  return addTypeAnnotationsToFnCall(expr, types);
};

const addTypeAnnotationsToFn = (ast: AST, types: TypeInfo): AST => {
  const identifier = toIdentifier(ast[1] as string);
  const suppliedReturnType = getSuppliedReturnTypeForFn(ast);

  const scopedTypes: TypeInfo = {
    ...types,
    vars: new Map(),
    params: new Map(),
  };

  const rawParameters = ast[2] as AST;
  const parameters = registerFnParams(rawParameters, scopedTypes);

  const fn = getMatchingFn({
    identifier,
    args: rawParameters.slice(1).map((expr) => {
      if (isStruct(expr)) {
        return { type: expr };
      }

      return getInfoFromRawParam(expr as AST);
    }),
    fns: types.fns,
  });

  if (!fn) {
    throw new Error(`Could not find matching function for ${identifier}`);
  }

  const typedBlock = addTypeAnnotationsToExpr(ast[5], scopedTypes);
  if (!isList(typedBlock) || typedBlock[0] !== "typed-block") {
    throw new Error("Expected typed-block");
  }

  const inferredReturnType = assertFunctionReturnType(
    typedBlock,
    suppliedReturnType,
    identifier
  );

  fn.returnType = suppliedReturnType ?? inferredReturnType;
  const variables: [string, Expr][] = [...scopedTypes.vars].map(
    ([id, { type }]) => [id, type]
  );

  return [
    "define-function",
    identifier,
    parameters,
    ["variables", ...variables],
    ["return-type", fn.returnType!],
    typedBlock,
  ];
};

/**
 * For now, all params are assumed to be manually typed.
 * Returns the updated list of parameters
 */
const registerFnParams = (ast: AST, types: TypeInfo): AST => {
  if (ast[0] !== "parameters") {
    throw new Error("Expected function parameters");
  }

  return [
    "parameters",
    ...ast.slice(1).flatMap((expr): Expr => {
      if (!isList(expr)) {
        throw new Error("All parameters must be typed");
      }

      if (isStruct(expr)) {
        return expr.slice(1).map(registerStructParamField(types));
      }

      const { identifier, type, label } = getInfoFromRawParam(expr);
      types.params.set(identifier!, { type, label });
      return [[identifier!, type]];
    }),
  ];
};

const registerStructParamField = (
  types: TypeInfo
): ((value: Expr, index: number, array: Expr[]) => Expr) => {
  return (exp) => {
    if (!isList(exp)) {
      throw new Error("All struct parameters must be typed");
    }
    const { identifier, type, label } = getInfoFromRawParam(exp);
    types.params.set(identifier!, { type, label });
    return [identifier!, type];
  };
};

const addTypeAnnotationsToBlock = (ast: AST, types: TypeInfo): AST => {
  const annotatedArgs = ast
    .slice(1)
    .map((expr) => addTypeAnnotationsToExpr(expr, types));
  const type = getExprReturnType(
    annotatedArgs[annotatedArgs.length - 1],
    types
  );
  if (!type) {
    console.error(JSON.stringify(ast, undefined, 2));
    throw new Error("Could not determine return type of preceding block");
  }
  return ["typed-block", type, ...annotatedArgs];
};

const addTypeAnnotationsToFnCall = (ast: AST, types: TypeInfo): AST => {
  if (ast[0] === "define-function") return addTypeAnnotationsToFn(ast, types);
  if (ast[0] === "define-extern-function") return ast; // TODO: type check this mofo
  if (ast[0] === "define-type") return ast; // TODO: type check this mofo
  if (ast[0] === "define-cdt") return ast; // TODO: type check this mofo
  if (ast[0] === "block") return addTypeAnnotationsToBlock(ast, types);
  if (ast[0] === "lambda-expr") return ast;
  if (ast[0] === "quote") return ast;
  if (ast[0] === "export") return ast; // TODO
  if (ast[0] === "=") return ast; // TODO
  if (ast[0] === "root") return addTypeAnnotationToRoot(ast, types);
  if (ast[0] === "module") return addTypeAnnotationToModule(ast, types);
  if (ast[0] === "bnr" || ast[0] === "binaryen-mod") return ast;
  if (typeof ast[0] === "string" && ast[0].startsWith("define")) {
    return addTypeAnnotationToVar(ast, types);
  }
  if (isPrimitiveFn(ast[0])) {
    return addTypeAnnotationsToPrimitiveFn(ast, types);
  }

  return addTypeAnnotationToUserFnCall(ast, types);
};

const addTypeAnnotationsToPrimitiveFn = (ast: AST, types: TypeInfo): AST => {
  const annotatedArgs = ast
    .slice(1)
    .map((expr) => addTypeAnnotationsToExpr(expr, types));
  return [ast[0], ...annotatedArgs];
};

function addTypeAnnotationToUserFnCall(ast: AST, types: TypeInfo) {
  const fn = getMatchingFnForCallExpr(ast, types);
  if (!fn) {
    console.error(JSON.stringify(ast, undefined, 2));
    throw new Error("Could not find matching fn for above call expression");
  }

  const annotatedArgs = ast.slice(1).flatMap((expr, index) => {
    if (isStruct(expr)) {
      return applyStructParams(fn.params[index].type as AST, expr as AST);
    }

    return [addTypeAnnotationsToExpr(expr, types)];
  });

  return [ast[0], ...annotatedArgs];
}

/** Re-orders the supplied struct and returns it as a normal list of expressions to be passed as args */
const applyStructParams = (expectedStruct: AST, suppliedStruct: AST): AST =>
  expectedStruct.slice(1).map((expr) => {
    const labeledExpr = expr as AST;
    const label = labeledExpr[1];
    const arg = suppliedStruct
      .slice(1)
      .find((expr) => (expr as AST)[1] === label) as AST;
    if (!arg) throw new Error(`Could not find arg for field ${label}`);
    return arg[2];
  });

const addTypeAnnotationToRoot = (ast: AST, types: TypeInfo): AST =>
  ast.map((expr) => addTypeAnnotationsToExpr(expr, types));

const addTypeAnnotationToModule = (ast: AST, types: TypeInfo): AST => {
  ast[4] = (ast[4] as AST).map((expr) => addTypeAnnotationsToExpr(expr, types));
  return ast;
};

const addTypeAnnotationToVar = (ast: AST, types: TypeInfo): AST => {
  const mutable = ast[0] === "define-mut";
  const global = typeof ast[0] === "string" && ast[0].includes("global");
  const inferredType = getExprReturnType(ast[2], types);
  const annotatedInitializer = addTypeAnnotationsToExpr(ast[2], types);
  const suppliedType = isList(ast[1])
    ? typeof ast[1][2] === "string"
      ? toIdentifier(ast[1][2])
      : ast[1][2]
    : undefined;
  const identifier = isList(ast[1])
    ? toIdentifier(ast[1][1] as string)
    : toIdentifier(ast[1] as string);
  if (suppliedType && !typesMatch(suppliedType, inferredType)) {
    throw new Error(
      `${identifier} of type ${suppliedType} is not assignable to ${inferredType}`
    );
  }
  const type = suppliedType ?? inferredType;
  if (!type) {
    throw new Error(`Could not determine type for identifier ${identifier}`);
  }

  global
    ? types.globals.set(identifier, { type, mutable })
    : types.vars.set(identifier, { type, mutable });

  return [ast[0], ["labeled-expr", identifier, type], annotatedInitializer];
};

const getExprReturnType = (expr: Expr, types: TypeInfo): Expr | undefined => {
  const { params, vars, globals } = types;
  if (typeof expr === "number") return "i32";
  if (isFloat(expr)) return "f32";
  if (typeof expr === "boolean") return "i32";
  if (expr === "void") return "void";
  if (typeof expr === "string") {
    return (
      params.get(toIdentifier(expr))?.type ??
      vars.get(toIdentifier(expr))?.type ??
      globals.get(toIdentifier(expr))?.type
    );
  }
  if (!isList(expr)) {
    throw new Error(`Invalid expression ${expr}`);
  }
  if (expr[0] === "labeled-expr") {
    return getExprReturnType(expr[2], types);
  }
  if (expr[0] === "block") {
    return getExprReturnType(expr[expr.length - 1], types);
  }
  if (expr[0] === "struct") {
    return getStructLiteralType(expr, types);
  }
  if (expr[0] === "bnr" || expr[0] === "binaryen-mod") {
    return getBnrReturnType(expr);
  }
  if (expr[0] === "if") {
    return getIfReturnType(expr, types);
  }

  const fn = getMatchingFnForCallExpr(expr, types);
  return fn?.returnType;
};

/** Takes the expression form of a struct and converts it into type form */
const getStructLiteralType = (ast: AST, types: TypeInfo): AST => [
  "struct",
  ...ast.slice(1).map((labeledExpr) => {
    const identifier = toIdentifier((labeledExpr as AST)[1] as string);
    const type = getExprReturnType((labeledExpr as AST)[2], types);
    if (!type) {
      throw new Error("Could not determine type for struct literal");
    }
    return ["labeled-expr", identifier, type];
  }),
];

const getIfReturnType = (ast: AST, types: TypeInfo): Expr | undefined => {
  // TODO type check this mofo
  return getExprReturnType(ast[2], types);
};

const getBnrReturnType = (ast: AST): string => {
  const call = ast as any;
  return toIdentifier(call[1][2]);
};

const getMatchingFnForCallExpr = (
  call: AST,
  types: TypeInfo
): Fn | undefined => {
  const identifier = toIdentifier(call[0] as string);
  const args = call.slice(1).map((expr) => ({
    type: getExprReturnType(expr, types)!,
    label:
      isList(expr) && expr[0] === "labeled-expr"
        ? (expr[1] as string)
        : undefined,
  }));

  return getMatchingFn({ identifier, args, fns: types.fns });
};

const getMatchingFn = ({
  identifier,
  args,
  fns,
}: {
  identifier: string;
  args: Param[];
  fns: FnMap;
}): Fn | undefined => {
  const candidates = fns.get(identifier);
  if (!candidates) return undefined;
  return candidates.find((candidate) =>
    candidate.params.every(({ type, label }, index) => {
      const arg = args[index];
      return typesMatch(type, arg?.type) && arg?.label === label;
    })
  );
};

const typesMatch = (expected?: Expr, given?: Expr) => {
  if (isStruct(expected) && isStruct(given)) {
    return structArgsMatch(expected as AST, given as AST);
  }

  return expected === given || isStructPointerMatch(expected, given);
};

// Until a more complex type system is implemented, assume that non-primitive types
// Can be treated as i32's. This is obviously dangerous. But a type checker should catch
// the bugs this could cause before we reach the code gen phase anyway.
const isStructPointerMatch = (expected?: Expr, given?: Expr) =>
  (!isPrimitiveType(expected) && given === CDT_ADDRESS_TYPE) ||
  (!isPrimitiveType(given) && expected === CDT_ADDRESS_TYPE);

const structArgsMatch = (expected: AST, given: AST): boolean => {
  return (
    expected.length === given.length &&
    expected.slice(1).every((fieldTypeAst) =>
      given.slice(1).some((argTypeAst) => {
        // Both fieldTypeAst and argTypeAst should be labeled-exprs
        const fieldType = (fieldTypeAst as AST)[2];
        const argType = (argTypeAst as AST)[2];
        return typesMatch(fieldType, argType);
      })
    )
  );
};

const genFunctionMap = (ast: AST): FnMap => {
  return ast.reduce((map: FnMap, expr: Expr) => {
    if (!isList(expr)) return map;

    if (expr[0] !== "define-function" && expr[0] !== "define-extern-function") {
      return new Map([...map, ...genFunctionMap(expr)]);
    }

    const fnIdentifier = toIdentifier(expr[1] as string);
    const fnArray: Fn[] = map.get(fnIdentifier) ?? [];
    const returns = getSuppliedReturnTypeForFn(expr);
    const parametersIndex = expr[0] === "define-function" ? 2 : 3;
    const params: Param[] = (expr[parametersIndex] as Expr[][])
      .slice(1)
      .map((arr) => {
        if (isStruct(arr)) {
          return { type: arr };
        }

        return getInfoFromRawParam(arr);
      });

    map.set(fnIdentifier, [
      ...fnArray,
      {
        params,
        returnType: returns,
      },
    ]);
    return map;
  }, new Map());
};

const getSuppliedReturnTypeForFn = (ast: AST): Expr | undefined => {
  const returnDef = (ast[4] as AST)[1];
  // TODO: Support type literals
  return typeof returnDef === "string"
    ? toIdentifier(returnDef)
    : isList(returnDef) && returnDef[0] === "cdt-pointer"
    ? toIdentifier(returnDef[1] as string)
    : undefined;
};

function assertFunctionReturnType(
  typedBlock: AST,
  suppliedReturnType: Expr | undefined,
  identifier: string
) {
  const inferredReturnType = typedBlock[1] as string;
  const shouldCheckInferredType =
    suppliedReturnType && suppliedReturnType !== "void";
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

const getInfoFromRawParam = (ast: AST) => {
  const isLabeled = !isStruct(ast) && isList(ast[2]);
  const paramDef: AST = isLabeled ? (ast[2] as AST) : ast;
  const identifier =
    typeof paramDef[1] === "string"
      ? toIdentifier(paramDef[1] as string)
      : undefined;
  const type =
    typeof paramDef[2] === "string" ? toIdentifier(paramDef[2]) : paramDef[2];
  const label = isLabeled ? toIdentifier(ast[1] as string) : undefined;
  return { identifier, type, label };
};

const isStruct = (expr?: Expr) => isList(expr) && expr[0] === "struct";
const isPrimitiveFn = (expr?: Expr) => {
  if (typeof expr !== "string") return false;
  return new Set(["if", "="]).has(expr);
};
