import binaryen from "binaryen";
import { isFloat } from "./lib/is-float.mjs";
import { isList } from "./lib/is-list.mjs";
import { AST, Expr } from "./parser.mjs";

export const genWasmCode = (ast: AST) => {
  const mod = new binaryen.Module();
  const functionMap = genFunctionMap(ast);
  compileExpression({ expr: ast, mod, parameters: new Map(), functionMap });
  return mod;
};

interface CompileExpressionOpts {
  expr: Expr;
  mod: binaryen.Module;
  parameters: ParameterMap;
  functionMap: FnMap;
}

const compileExpression = (opts: CompileExpressionOpts): number => {
  const { expr, mod } = opts;
  if (isList(expr)) return compileList({ ...opts, expr: expr });
  if (Number.isInteger(expr)) return mod.i32.const(expr as number);
  if (typeof expr === "number") return mod.f32.const(expr);
  if (typeof expr === "string" && isFloat(expr)) return compileFloat(mod, expr);
  if (typeof expr === "string") return compileSymbol({ ...opts, expr });
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

  if (expr[0] === "block") {
    const block = expr
      .slice(1)
      .map((expr) => compileExpression({ ...opts, expr }));
    return mod.block(null, block, binaryen.auto);
  }

  if (typeof expr[0] === "string") {
    return compileFunctionCall({ ...opts, expr });
  }

  return mod.nop();
};

const compileFunctionCall = (opts: CompileListOpts) => {
  const { expr, functionMap, mod } = opts;
  const identifier = toIdentifier(expr[0] as string);

  if (identifier === "define-function") return compileFunction(opts);
  if (identifier === "if") return compileIf(opts);
  if (identifier === "binaryen-mod") return compileBinaryenModCall(opts);

  const fn = getMatchingFnForCallExpr(expr, functionMap, opts.parameters);
  if (!fn) {
    throw new Error(`Function ${identifier} not found`);
  }

  const args = expr
    .slice(1)
    .map((expr) => compileExpression({ ...opts, expr }));

  return mod.call(fn.binaryenId, args, fn.returnType);
};

const compileBinaryenModCall = (opts: CompileListOpts): number => {
  const { expr } = opts;
  const call = expr as any;
  const namespace = call[1][0];
  const func = call[1][1];
  const args = call[2];
  return (opts.mod as any)[namespace][func](
    ...args.map((expr: Expr) => compileExpression({ ...opts, expr }))
  );
};

const compileFunction = (opts: CompileListOpts): number => {
  const { expr, mod, functionMap, parameters: paramMap } = opts;
  const identifier = toIdentifier(expr[1] as string);
  const returnType = mapBinaryenType((expr[4] as AST)[1] as string);
  const { parameters, parameterTypes } = getFunctionParameters(expr[2] as AST);
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

const getFunctionParameters = (ast: AST) => {
  if (ast[0] !== "parameters") {
    throw new Error("Expected function parameters");
  }

  const { parameters, types } = ast.slice(1).reduce(
    (prev, expr, index) => {
      if (!isList(expr)) {
        throw new Error("All parameters must be typed");
      }
      const typeId = toIdentifier(expr[1] as string);
      const type = mapBinaryenType(typeId);

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
    .map((expr) => getExprReturnTypeId(expr, fnMap, paramMap))
    .filter(Boolean) as string[];
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
  if (typeof expr === "string") {
    return paramMap.get(toIdentifier(expr))?.typeId;
  }
  return getMatchingFnForCallExpr(expr, fnMap, paramMap)?.signature
    .returnTypeIds;
};

const genFunctionMap = (ast: AST): FnMap => {
  return ast.reduce((map: FnMap, expr: Expr) => {
    if (!isList(expr)) return map;

    if (expr[0] === "define-function") {
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
          returnType: mapBinaryenType(returns),
        },
      ]);
      return map;
    }

    return new Map([...map, ...genFunctionMap(expr)]);
  }, new Map());
};

const mapBinaryenType = (typeIdentifier: string): binaryen.Type => {
  if (typeIdentifier === "i32") return binaryen.i32;
  if (typeIdentifier === "f32") return binaryen.f32;
  throw new Error(`Unsupported type ${typeIdentifier}`);
};

const toIdentifier = (str: string): string => str.replace(/\'/g, "");
