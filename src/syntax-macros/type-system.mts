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
  /** returns and parameters are the type identifier */
  params: { type: string; label?: string }[];
  returnType?: string;
};

type VarMap = Map<string, Variable>;
type Variable = {
  type: string;
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
  addFnParams(ast[2] as AST, scopedTypes);
  const fn = getMatchingFn({
    identifier,
    params: [...scopedTypes.params.values()],
    fns: types.fns,
  });
  if (!fn) {
    throw new Error(`Could not find matching function for ${identifier}`);
  }
  const typedBlock = addTypeAnnotationsToExpr(ast[5], scopedTypes);
  if (!isList(typedBlock) || typedBlock[0] !== "typed-block") {
    throw new Error("Expected typed-block");
  }
  const inferredReturnType = typedBlock[1] as string;
  if (!suppliedMatchesInferredType(suppliedReturnType, inferredReturnType)) {
    throw new Error(
      `Expected fn ${identifier} to return ${suppliedReturnType}, got ${inferredReturnType}`
    );
  }
  fn.returnType = suppliedReturnType ?? inferredReturnType;
  const variables: [string, string][] = [...scopedTypes.vars].map(
    ([id, { type }]) => [id, type]
  );

  return [
    "define-function",
    identifier,
    ast[2],
    ["variables", ...variables],
    ["return-type", fn.returnType!],
    typedBlock,
  ];
};

/** For now, all params are assumed to be manually typed */
const addFnParams = (ast: AST, types: TypeInfo) => {
  if (ast[0] !== "parameters") {
    throw new Error("Expected function parameters");
  }

  for (const expr of ast.slice(1)) {
    if (!isList(expr)) {
      throw new Error("All parameters must be typed");
    }

    const identifier = toIdentifier(expr[0] as string);
    const type = toIdentifier(expr[1] as string);
    const label =
      typeof expr[2] === "string" ? toIdentifier(expr[2]) : undefined;
    types.params.set(identifier, { type, label });
  }
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
  if (ast[0] === "root") return addTypeAnnotationToRoot(ast, types);
  if (ast[0] === "module") return addTypeAnnotationToModule(ast, types);
  if (ast[0] === "bnr" || ast[0] === "binaryen-mod") return ast;
  if (typeof ast[0] === "string" && ast[0].startsWith("define")) {
    return addTypeAnnotationToVar(ast, types);
  }

  const annotatedArgs = ast
    .slice(1)
    .map((expr) => addTypeAnnotationsToExpr(expr, types));
  return [ast[0], ...annotatedArgs];
};

const addTypeAnnotationToRoot = (ast: AST, types: TypeInfo): AST =>
  ast.map((expr) => addTypeAnnotationsToExpr(expr, types));

const addTypeAnnotationToModule = (ast: AST, types: TypeInfo): AST => {
  ast[4] = (ast[4] as AST).map((expr) => addTypeAnnotationsToExpr(expr, types));
  return ast;
};

const addTypeAnnotationToVar = (ast: AST, types: TypeInfo): AST => {
  const mutable = ast[0] === "define-mut";
  const global = typeof ast[0] === "string" && ast[0].includes("global");
  const annotatedInitializer = addTypeAnnotationsToExpr(ast[2], types);
  const inferredType = getExprReturnType(annotatedInitializer, types);
  const suppliedType = isList(ast[1])
    ? toIdentifier(ast[1][2] as string)
    : undefined;
  const identifier = isList(ast[1])
    ? toIdentifier(ast[1][1] as string)
    : toIdentifier(ast[1] as string);
  if (!suppliedMatchesInferredType(suppliedType, inferredType)) {
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

const getExprReturnType = (expr: Expr, types: TypeInfo): string | undefined => {
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
  if (expr[0] === "typed-block") {
    return expr[1] as string;
  }
  if (expr[0] === "bnr" || expr[0] === "binaryen-mod") {
    return getBnrReturnType(expr);
  }
  if (expr[0] === "if") {
    return getIfReturnType(expr, types);
  }

  return getMatchingFnForCallExpr(expr, types)?.returnType;
};

const getIfReturnType = (ast: AST, types: TypeInfo): string | undefined => {
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
  const parameters = call.slice(1).map((expr) => ({
    type: getExprReturnType(expr, types) as string,
    label:
      isList(expr) && expr[0] === "labeled-expr"
        ? (expr[1] as string)
        : undefined,
  }));

  return getMatchingFn({ identifier, params: parameters, fns: types.fns });
};

const getMatchingFn = ({
  identifier,
  params,
  fns,
}: {
  identifier: string;
  params: { type: string; label?: string }[];
  fns: FnMap;
}): Fn | undefined => {
  const candidates = fns.get(identifier);
  if (!candidates) return undefined;
  return candidates.find((candidate) =>
    candidate.params.every(({ type, label }, index) => {
      const arg = params[index];
      // Until a more complex type system is implemented, assume that non-primitive types
      // Can be treated as i32's. This is obviously dangerous. But a type checker should catch
      // the bugs this could cause before we reach the code gen phase anyway.
      return (
        (arg?.type === type ||
          (!isPrimitiveType(arg?.type) && type === CDT_ADDRESS_TYPE)) &&
        arg?.label === label
      );
    })
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
    const returns = getSuppliedReturnTypeForFn(ast);
    const parametersIndex = expr[0] === "define-function" ? 2 : 3;
    const params = (expr[parametersIndex] as string[][])
      .slice(1)
      .map((arr) => ({ type: toIdentifier(arr[1]), label: arr[2] }));
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

const getSuppliedReturnTypeForFn = (ast: AST): string | undefined => {
  const returnDef = (ast[4] as AST)[1];
  // TODO: Support type literals
  return typeof returnDef === "string"
    ? toIdentifier(returnDef)
    : isList(returnDef) && returnDef[0] === "cdt-pointer"
    ? toIdentifier(returnDef[1] as string)
    : undefined;
};

const suppliedMatchesInferredType = (
  suppliedType: string | undefined,
  inferredType: string | undefined
) =>
  !(
    suppliedType &&
    suppliedType !== "void" &&
    inferredType &&
    inferredType !== suppliedType &&
    // This is a temp hack for checking memory allocation, where the supplied type is a CDT and the inferred type is CDT_ADDRESS_TYPE
    !(!isPrimitiveType(suppliedType) && inferredType === CDT_ADDRESS_TYPE)
  );
