import binaryen from "binaryen";
import { isFloat } from "./lib/is-float.mjs";
import { isList } from "./lib/is-list.mjs";
import { toIdentifier } from "./lib/to-identifier.mjs";
import { AST, Expr } from "./parser.mjs";

let mod: binaryen.Module | undefined = undefined;

// TODO Handle scoping better
export const genWasmCode = (ast: AST) => {
  mod = new binaryen.Module();
  const typeIdentifiers = new Map();
  const functionMap = genFunctionMap(ast, typeIdentifiers);
  compileExpression({
    expr: ast,
    mod,
    parameters: new Map(),
    functionMap,
    typeIdentifiers,
  });
  return mod;
};

interface CompileExpressionOpts {
  expr: Expr;
  mod: binaryen.Module;
  parameters: ParameterMap;
  functionMap: FnMap;
  typeIdentifiers: TypeIdentifiers;
}

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
  const { expr, parameters, mod } = opts;
  if (typeof expr !== "string") {
    throw new Error("Expected symbol");
  }

  if (expr[0] === '"') {
    throw new Error("String literals not yet supported");
  }

  const info = parameters.get(toIdentifier(expr));
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

const compileFunctionCall = (opts: CompileFnCallOpts) => {
  const { expr, functionMap, mod, isReturnCall } = opts;
  const identifier = toIdentifier(expr[0] as string);

  if (identifier === "define-type") return compileType(opts);
  if (identifier === "lambda-expr") return mod.nop();
  if (identifier === "define-function") return compileFunction(opts);
  if (identifier === "define-external-function") return compileExternFn(opts);
  if (identifier === "return-call") {
    return compileFunction({ ...opts, expr: expr.slice(1) });
  }
  if (identifier === "if") return compileIf(opts);
  if (identifier === "binaryen-mod") return compileBinaryenModCall(opts);

  const fn = getMatchingFnForCallExpr(expr, functionMap, opts.parameters);
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

const compileType = (opts: CompileListOpts): number => {
  const { expr } = opts;
  const identifier = toIdentifier(expr[0] as string);
  /** TODO support more complex types... Somehow. */
  const typeIdentifier = toIdentifier(expr[1] as string);
  opts.typeIdentifiers.set(identifier, typeIdentifier);
  return opts.mod.nop();
};

const compileBinaryenModCall = (opts: CompileListOpts): number => {
  const { expr } = opts;
  const call = expr as any;
  const namespaceId = toIdentifier(call[1][0]);
  const funcId = toIdentifier(call[1][1]);
  const args = call[2];
  const namespace =
    namespaceId === "mod" ? opts.mod : (opts.mod as any)[namespaceId];
  const func = namespace[funcId];
  return func(
    ...args.map((expr: Expr) => compileExpression({ ...opts, expr }))
  );
};

const compileFunction = (opts: CompileListOpts): number => {
  const { expr, mod, functionMap } = opts;
  const identifier = toIdentifier(expr[1] as string);
  const { parameters, parameterTypes } = getFunctionParameters(
    expr[2] as AST,
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

  const body = compileList({
    ...opts,
    expr: expr[5] as AST,
    parameters,
  });
  mod.addFunction(fn.binaryenId, parameterTypes, returnType, [], body);
  mod.addFunctionExport(fn.binaryenId, fn.binaryenId);
  return mod.nop();
};

const compileExternFn = (opts: CompileListOpts) => {
  const { expr, mod, functionMap } = opts;
  const identifier = toIdentifier(expr[1] as string);
  const namespace = toIdentifier(expr[2] as string);
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
  const ifFalse = ifFalseNode
    ? compileExpression({ ...opts, expr: ifFalseNode })
    : undefined;
  return mod.if(condition, ifTrue, ifFalse);
};

type ParameterMap = Map<
  string,
  { index: number; type: number; typeId: string }
>;

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
      parameters: ParameterMap;
      types: number[];
    }
  );

  return {
    parameters,
    parameterTypes: binaryen.createType(types),
  };
};

type FnMap = Map<string, Fn[]>;
type Fn = {
  binaryenId: string;
  /** returns and parameters are the type identifier */
  signature: { paramTypeIds: string[]; returnTypeIds: string };
  returnType: number;
};

const getMatchingFnForCallExpr = (
  call: AST,
  fnMap: FnMap,
  paramMap: ParameterMap
): Fn | undefined => {
  const identifier = toIdentifier(call[0] as string);
  const paramTypeIds = call
    .slice(1)
    .map((expr) => getExprReturnTypeId(expr, fnMap, paramMap) as string);
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
  paramMap: ParameterMap
): string | undefined => {
  if (typeof expr === "number") return "i32";
  if (typeof expr === "string" && expr.startsWith("/float")) return "f32";
  if (typeof expr === "boolean") return "i32";
  if (typeof expr === "string") {
    return paramMap.get(toIdentifier(expr))?.typeId;
  }
  return getMatchingFnForCallExpr(expr, fnMap, paramMap)?.signature
    .returnTypeIds;
};

const genFunctionMap = (ast: AST, typeIdentifiers: TypeIdentifiers): FnMap => {
  return ast.reduce((map: FnMap, expr: Expr) => {
    if (!isList(expr)) return map;

    if (expr[0] !== "define-function" && expr[0] !== "define-extern-function") {
      return new Map([...map, ...genFunctionMap(expr, typeIdentifiers)]);
    }

    const fnIdentifier = toIdentifier(expr[1] as string);
    const fnArray: Fn[] = map.get(fnIdentifier) ?? [];
    const returns = toIdentifier((expr[4] as AST)[1] as string);
    const parameters = (expr[2] as string[][])
      .slice(1)
      .map((arr) => toIdentifier(arr[1]));
    map.set(fnIdentifier, [
      ...fnArray,
      {
        binaryenId: `${fnIdentifier}${fnArray.length}`,
        signature: { returnTypeIds: returns, paramTypeIds: parameters },
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
