import binaryen from "binaryen";
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
  functionMap: FunctionMap;
}

const compileExpression = (opts: CompileExpressionOpts): number => {
  const { expr, mod } = opts;
  if (isList(expr)) return compileList({ ...opts, expr: expr });
  if (Number.isInteger(expr)) return mod.i32.const(expr as number);
  if (typeof expr === "number") return mod.f32.const(expr);
  if (typeof expr === "string") return compileSymbol({ ...opts, expr });
  throw new Error(`Unrecognized expression ${expr}`);
};

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

  const functionInfo = functionMap.get(identifier);
  if (!functionInfo) {
    throw new Error(`Function ${identifier} not found`);
  }

  const args = expr
    .slice(1)
    .map((expr) => compileExpression({ ...opts, expr }));

  return mod.call(identifier, args, functionInfo.returnType);
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
  const { expr, mod } = opts;
  const identifier = toIdentifier(expr[1] as string);
  const returnType = mapBinaryenType((expr[4] as AST)[1] as string);
  const { parameters, parameterTypes } = getFunctionParameters(expr[2] as AST);
  const body = compileList({
    ...opts,
    expr: expr[5] as AST,
    parameters,
  });
  mod.addFunction(identifier, parameterTypes, returnType, [], body);
  mod.addFunctionExport(identifier, identifier);
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

type ParameterMap = Map<string, { index: number; type: number }>;

const getFunctionParameters = (ast: AST) => {
  if (ast[0] !== "parameters") {
    throw new Error("Expected function parameters");
  }

  const { parameters, types } = ast.slice(1).reduce(
    (prev, expr, index) => {
      if (!isList(expr)) {
        throw new Error("All parameters must be typed");
      }
      const type = mapBinaryenType(expr[1] as string);

      prev.parameters.set(toIdentifier(expr[0] as string), { index, type });
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

type FunctionMap = Map<string, { returnType: number }>;

const genFunctionMap = (ast: AST): FunctionMap => {
  return ast.reduce((map: FunctionMap, expr: Expr) => {
    if (!isList(expr)) return map;

    if (ast[0] === "define-function") {
      map.set(toIdentifier(ast[1] as string), {
        returnType: mapBinaryenType(toIdentifier((ast[4] as AST)[1] as string)),
      });
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
