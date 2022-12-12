import binaryen from "binaryen";
import { isFloat } from "./lib/is-float.mjs";
import { isList } from "./lib/is-list.mjs";
import { toIdentifier } from "./lib/to-identifier.mjs";
import { AST, Expr } from "./parser.mjs";

let mod: binaryen.Module | undefined = undefined;

// TODO Handle scoping better
export const genWasmCode = (ast: AST) => {
  mod = new binaryen.Module();
  mod.setMemory(5, 150);
  const typeIdentifiers = new Map();
  const functionMap = genFunctionMap(ast, typeIdentifiers);
  compileExpression({
    expr: ast,
    mod,
    parameters: new Map(),
    vars: new Map(),
    globals: new Map(),
    functionMap,
    typeIdentifiers,
  });
  mod.autoDrop();
  return mod;
};

interface CompileExpressionOpts {
  expr: Expr;
  mod: binaryen.Module;
  parameters: VarMap;
  vars: VarMap;
  globals: GlobalMap;
  functionMap: FnMap;
  typeIdentifiers: TypeIdentifiers;
}

type FnMap = Map<string, Fn[]>;
type Fn = {
  binaryenId: string;
  /** returns and parameters are the type identifier */
  signature: {
    paramTypeIds: string[];
    variableTypeIds: string[];
    returnTypeIds: string;
  };
  returnType: number;
};
type VarMap = Map<string, { index: number; type: number; typeId: string }>;
type GlobalMap = Map<string, { name: string; type: number; typeId: string }>;

/** Name / Alias, should eventually lead to a native WASM type */
type TypeIdentifiers = Map<string, string>;

const compileExpression = (opts: CompileExpressionOpts): number => {
  const { expr, mod } = opts;
  if (isList(expr)) return compileList({ ...opts, expr: expr });
  if (Number.isInteger(expr)) return mod.i32.const(expr as number);
  if (typeof expr === "number") return mod.f32.const(expr);
  if (typeof expr === "string" && isFloat(expr)) return compileFloat(mod, expr);
  if (typeof expr === "string") return compileSymbol({ ...opts, expr });
  if (typeof expr === "boolean") {
    return expr ? mod.i32.const(1) : mod.i32.const(2);
  }
  throw new Error(`Unrecognized expression ${expr}`);
};

const compileFloat = (mod: binaryen.Module, flt: string) =>
  mod.f32.const(Number(flt.replace("/float", "")));

const compileSymbol = (opts: CompileExpressionOpts) => {
  const { expr, parameters, mod, vars, globals } = opts;
  if (typeof expr !== "string") {
    throw new Error("Expected symbol");
  }

  if (expr[0] === '"') {
    throw new Error("String literals not yet supported");
  }

  const id = toIdentifier(expr);
  const global = globals.get(id);
  if (global) {
    return mod.global.get(global.name, global.type);
  }

  const info = parameters.get(id) ?? vars.get(id);
  if (!info) {
    throw new Error(`Unrecognized symbol ${expr}`);
  }

  return mod.local.get(info.index, info.type);
};

interface CompileListOpts extends CompileExpressionOpts {
  expr: AST;
}

const compileList = (opts: CompileListOpts): number => {
  const { expr, mod } = opts;

  // TODO: Move bloc, root, and export to compileFunctionCall
  if (expr[0] === "block") {
    const block = expr
      .slice(1)
      .map((expr) => compileExpression({ ...opts, expr }));
    return mod.block(null, block, binaryen.auto);
  }

  if (expr[0] === "root") {
    return compileRootExpr({ ...opts, expr });
  }

  // TODO: Implement export logic etc. Probably can be handled by a macro.
  if (expr[0] === "export") {
    return mod.nop();
  }

  if (typeof expr[0] === "string") {
    return compileFunctionCall({ ...opts, expr });
  }

  return mod.nop();
};

const compileRootExpr = (opts: CompileListOpts): number => {
  for (const module of opts.expr.slice(1)) {
    if (!isList(module) || module[0] !== "module") {
      throw new Error(
        "Expected module, got: " + JSON.stringify(module, null, 2)
      );
    }
    (module[4] as AST).forEach((expr) => compileExpression({ ...opts, expr }));
  }
  return opts.mod.nop();
};

interface CompileFnCallOpts extends CompileListOpts {
  isReturnCall?: boolean;
}

const compileFunctionCall = (opts: CompileFnCallOpts): number => {
  const { expr, functionMap, mod, isReturnCall } = opts;
  const identifier = toIdentifier(expr[0] as string);

  if (identifier === "define-type") return mod.nop();
  if (identifier === "lambda-expr") return mod.nop();
  if (identifier === "define-function") return compileFunction(opts);
  if (identifier === "host-num") return expr[1] as number;
  if (identifier === "define-extern-function") return compileExternFn(opts);
  if (identifier === "=") return compileAssign(opts);
  if (identifier.startsWith("define")) return compileDefine(opts);
  if (identifier === "return-call") {
    return compileFunctionCall({
      ...opts,
      expr: expr.slice(1),
      isReturnCall: true,
    });
  }
  if (identifier === "if") return compileIf(opts);
  if (identifier === "binaryen-mod" || identifier === "bnr") {
    return compileBnrCall(opts);
  }

  const fn = getMatchingFnForCallExpr(
    expr,
    functionMap,
    opts.parameters,
    opts.vars,
    opts.globals
  );
  if (!fn) {
    throw new Error(`Function ${identifier} not found`);
  }

  const args = expr
    .slice(1)
    .map((expr) => compileExpression({ ...opts, expr }));

  if (isReturnCall) {
    return mod.return_call(fn.binaryenId, args, fn.returnType);
  }

  return mod.call(fn.binaryenId, args, fn.returnType);
};

const compileAssign = (opts: CompileFnCallOpts): number => {
  const { expr, mod, vars, globals, typeIdentifiers } = opts;
  const identifier = toIdentifier(expr[1] as string);
  const value = compileExpression({ ...opts, expr: expr[2] });
  const variable = vars.get(identifier);
  if (variable) {
    return mod.local.set(variable.index, value);
  }

  const global = globals.get(identifier);
  if (global) {
    return mod.global.set(global.name, value);
  }

  throw new Error(`${identifier} not found in scope`);
};

const compileBnrCall = (opts: CompileListOpts): number => {
  const { expr } = opts;
  const call = expr as any;
  const namespaceId = toIdentifier(call[1][0]);
  const funcId = toIdentifier(call[1][1]);
  const args = call[2];
  const namespace =
    namespaceId === "mod" ? opts.mod : (opts.mod as any)[namespaceId];
  const func = namespace[funcId];
  return func(
    ...(args?.map((expr: Expr) => compileExpression({ ...opts, expr })) ?? [])
  );
};

const compileDefine = (opts: CompileFnCallOpts): number => {
  const { expr, mod, vars, globals, typeIdentifiers } = opts;
  const defineIdentifier = toIdentifier(expr[0] as string);
  const identifier = toIdentifier((expr as string[][])[1][1]);
  const value = compileExpression({ ...opts, expr: expr[2] });

  if (defineIdentifier.includes("global")) {
    const type = toIdentifier((expr as string[][])[1][2]);
    const binType = mapBinaryenType(type, typeIdentifiers);
    mod.addGlobal(identifier, binType, defineIdentifier.includes("mut"), value);
    globals.set(identifier, {
      name: identifier,
      type: binType,
      typeId: type,
    });
    return mod.nop();
  }

  const variable = vars.get(identifier);
  if (!variable) throw new Error(`Variable, ${identifier} not found`);
  return mod.local.set(variable.index, value);
};

const compileFunction = (opts: CompileListOpts): number => {
  const { expr, mod, functionMap } = opts;
  const identifier = toIdentifier(expr[1] as string);
  const { parameters, parameterTypes } = getFunctionParameters(
    expr[2] as AST,
    opts.typeIdentifiers
  );
  const { variables, variableTypes } = getFunctionVars(
    expr[3] as AST,
    opts.typeIdentifiers,
    parameters.size
  );
  const returnType = mapBinaryenType(
    (expr[4] as AST)[1] as string,
    opts.typeIdentifiers
  );
  const fn = getMatchingFn({
    identifier,
    paramTypeIds: [...parameters.values()].map((p) => p.typeId),
    fnMap: functionMap,
  });
  if (!fn) {
    throw new Error(`Could not find matching function for ${identifier}`);
  }

  const body = compileList({
    ...opts,
    expr: expr[5] as AST,
    parameters,
    vars: variables,
  });
  mod.addFunction(
    fn.binaryenId,
    parameterTypes,
    returnType,
    variableTypes,
    body
  );
  mod.addFunctionExport(fn.binaryenId, fn.binaryenId);
  return mod.nop();
};

const compileExternFn = (opts: CompileListOpts) => {
  const { expr, mod, functionMap } = opts;
  const identifier = toIdentifier(expr[1] as string);
  const namespace = toIdentifier((expr as any)[2][1]);
  const { parameters, parameterTypes } = getFunctionParameters(
    expr[3] as AST,
    opts.typeIdentifiers
  );
  const returnType = mapBinaryenType(
    (expr[4] as AST)[1] as string,
    opts.typeIdentifiers
  );
  const fn = getMatchingFn({
    identifier,
    paramTypeIds: [...parameters.values()].map((p) => p.typeId),
    fnMap: functionMap,
  });
  if (!fn) {
    throw new Error(`Could not find matching function for ${identifier}`);
  }

  mod.addFunctionImport(
    fn.binaryenId,
    namespace,
    identifier,
    parameterTypes,
    returnType
  );
  return mod.nop();
};

const compileIf = (opts: CompileListOpts) => {
  const { expr, mod } = opts;
  const conditionNode = expr[1];
  const ifTrueNode = expr[2];
  const ifFalseNode = expr[3];
  const condition = compileExpression({ ...opts, expr: conditionNode });
  const ifTrue = compileExpression({ ...opts, expr: ifTrueNode });
  const ifFalse =
    ifFalseNode !== undefined
      ? compileExpression({ ...opts, expr: ifFalseNode })
      : undefined;
  return mod.if(condition, ifTrue, ifFalse);
};

const getFunctionParameters = (ast: AST, typeIdentifiers: TypeIdentifiers) => {
  if (ast[0] !== "parameters") {
    throw new Error("Expected function parameters");
  }

  const { parameters, types } = ast.slice(1).reduce(
    (prev, expr, index) => {
      if (!isList(expr)) {
        throw new Error("All parameters must be typed");
      }
      const typeId = toIdentifier(expr[1] as string);
      const type = mapBinaryenType(typeId, typeIdentifiers);

      prev.parameters.set(toIdentifier(expr[0] as string), {
        index,
        type,
        typeId,
      });
      prev.types.push(type);
      return prev;
    },
    { parameters: new Map(), types: [] } as {
      parameters: VarMap;
      types: number[];
    }
  );

  return {
    parameters,
    parameterTypes: binaryen.createType(types),
  };
};

const getFunctionVars = (
  ast: AST,
  typeIdentifiers: TypeIdentifiers,
  indexOffset: number
) => {
  if (ast[0] !== "variables") {
    throw new Error("Expected function variables");
  }

  const { variables, variableTypes } = ast.slice(1).reduce(
    (prev, expr, index) => {
      if (!isList(expr)) {
        throw new Error("All variables must be typed");
      }
      const typeId = toIdentifier(expr[1] as string);
      const type = mapBinaryenType(typeId, typeIdentifiers);

      prev.variables.set(toIdentifier(expr[0] as string), {
        index: index + indexOffset,
        type,
        typeId,
      });
      prev.variableTypes.push(type);
      return prev;
    },
    { variables: new Map(), variableTypes: [] } as {
      variables: VarMap;
      variableTypes: number[];
    }
  );

  return {
    variables,
    variableTypes,
  };
};

const getMatchingFnForCallExpr = (
  call: AST,
  fnMap: FnMap,
  paramMap: VarMap,
  varMap: VarMap,
  globals: GlobalMap
): Fn | undefined => {
  const identifier = toIdentifier(call[0] as string);
  const paramTypeIds = call
    .slice(1)
    .map(
      (expr) =>
        getExprReturnTypeId(expr, fnMap, paramMap, varMap, globals) as string
    );

  return getMatchingFn({ identifier, paramTypeIds, fnMap });
};

const getMatchingFn = ({
  identifier,
  paramTypeIds,
  fnMap,
}: {
  identifier: string;
  paramTypeIds: string[];
  fnMap: FnMap;
}): Fn | undefined => {
  const candidates = fnMap.get(identifier);
  if (!candidates) return undefined;
  return candidates.find((candidate) =>
    candidate.signature.paramTypeIds.every(
      (typeId, index) => paramTypeIds[index] === typeId
    )
  );
};

const getExprReturnTypeId = (
  expr: Expr,
  fnMap: FnMap,
  paramMap: VarMap,
  varMap: VarMap,
  globals: GlobalMap
): string | undefined => {
  if (typeof expr === "number") return "i32";
  if (typeof expr === "string" && expr.startsWith("/float")) return "f32";
  if (typeof expr === "boolean") return "i32";
  if (typeof expr === "string" && expr === "void") return expr;
  if (typeof expr === "string") {
    return (
      paramMap.get(toIdentifier(expr))?.typeId ??
      varMap.get(toIdentifier(expr))?.typeId ??
      globals.get(toIdentifier(expr))?.typeId
    );
  }
  if (isList(expr) && expr[0] === "block") {
    return getExprReturnTypeId(
      expr[expr.length - 1]!,
      fnMap,
      paramMap,
      varMap,
      globals
    );
  }
  return getMatchingFnForCallExpr(expr, fnMap, paramMap, varMap, globals)
    ?.signature.returnTypeIds;
};

const genFunctionMap = (ast: AST, typeIdentifiers: TypeIdentifiers): FnMap => {
  return ast.reduce((map: FnMap, expr: Expr) => {
    if (!isList(expr)) return map;

    if (expr[0] === "define-type") {
      typeIdentifiers.set(toIdentifier(expr[1] as string), expr[2] as string);
      return map;
    }

    if (expr[0] !== "define-function" && expr[0] !== "define-extern-function") {
      return new Map([...map, ...genFunctionMap(expr, typeIdentifiers)]);
    }

    const fnIdentifier = toIdentifier(expr[1] as string);
    const fnArray: Fn[] = map.get(fnIdentifier) ?? [];
    const returns = toIdentifier((expr[4] as AST)[1] as string);
    const parametersIndex = expr[0] === "define-function" ? 2 : 3;
    const parameters = (expr[parametersIndex] as string[][])
      .slice(1)
      .map((arr) => toIdentifier(arr[1]));
    const variables =
      expr[0] === "define-function"
        ? (expr[parametersIndex + 1] as string[][])
            .slice(1)
            .map((arr) => toIdentifier(arr[1]))
        : [];
    map.set(fnIdentifier, [
      ...fnArray,
      {
        binaryenId: `${fnIdentifier}${fnArray.length}`,
        signature: {
          returnTypeIds: returns,
          variableTypeIds: variables,
          paramTypeIds: parameters,
        },
        returnType: mapBinaryenType(returns, typeIdentifiers),
      },
    ]);
    return map;
  }, new Map());
};

const mapBinaryenType = (
  typeIdentifier: string,
  typeIdentifiers: TypeIdentifiers
): binaryen.Type => {
  if (typeIdentifier === "i32") return binaryen.i32;
  if (typeIdentifier === "f32") return binaryen.f32;
  if (typeIdentifier === "void") return binaryen.none;
  if (typeIdentifiers.has(typeIdentifier)) {
    return mapBinaryenType(
      typeIdentifiers.get(typeIdentifier)!,
      typeIdentifiers
    );
  }
  throw new Error(`Unsupported type ${typeIdentifier}`);
};
