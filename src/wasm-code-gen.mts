import binaryen from "binaryen";
import {
  bool,
  dVoid,
  Expr,
  f32,
  f64,
  FnType,
  i32,
  i64,
  Identifier,
  Int,
  isBool,
  isComment,
  isFloat,
  isIdentifier,
  isInt,
  isList,
  isStructType,
  List,
  Type,
} from "./lib/index.mjs";

let mod: binaryen.Module | undefined = undefined;

// TODO Handle scoping
export const genWasmCode = (ast: List) => {
  mod = new binaryen.Module();
  mod.setMemory(1, 150, "buffer");
  mod.setFeatures(binaryen.Features.All);
  compileExpression({ expr: ast, mod, parent: ast });
  mod.autoDrop();
  return mod;
};

interface CompileExpressionOpts {
  expr: Expr;
  mod: binaryen.Module;
  parent: Expr;
}

const compileExpression = (opts: CompileExpressionOpts): number => {
  const { expr, mod } = opts;
  if (isList(expr)) return compileList({ ...opts, expr: expr });
  if (isInt(expr)) return mod.i32.const(expr.value);
  if (isFloat(expr)) return mod.f32.const(expr.value);
  if (isComment(expr)) return mod.nop();
  if (isIdentifier(expr)) return compileIdentifier({ ...opts, expr });
  if (isBool(bool)) {
    return expr.value ? mod.i32.const(1) : mod.i32.const(0);
  }
  throw new Error(`Unrecognized expression ${expr.value}`);
};

const compileIdentifier = (
  opts: CompileExpressionOpts & { expr: Identifier }
) => {
  const { expr, mod } = opts;

  const variable = expr.getVar(expr);
  if (!variable) {
    throw new Error(`Unrecognized symbol ${expr.value}`);
  }

  if (variable?.kind === "global") {
    return mod.global.get(expr.value, mapBinaryenType(variable.type!));
  }

  return mod.local.get(variable.index, mapBinaryenType(variable.type!));
};

type CompileListOpts = CompileExpressionOpts & { expr: List };

const compileList = (opts: CompileListOpts): number => {
  const { expr, mod } = opts;

  // TODO: Move bloc, root, and export to compileFunctionCall
  if (expr.calls("typed-block")) {
    const block = expr.value
      .slice(2)
      .map((expr) => compileExpression({ ...opts, expr }));
    return mod.block(null, block, binaryen.auto);
  }

  if (expr.calls("root")) {
    return compileRootExpr({ ...opts, expr });
  }

  // TODO: Implement export logic etc. Probably can be handled by a macro.
  if (expr.calls("export")) {
    return mod.nop();
  }

  if (isIdentifier(expr.first())) {
    return compileFunctionCall({ ...opts, expr });
  }

  return mod.nop();
};

const compileRootExpr = (opts: CompileListOpts): number => {
  for (const module of opts.expr.rest()) {
    if (!isList(module) || !module.calls("module")) {
      throw new Error(
        "Expected module, got: " + JSON.stringify(module, null, 2)
      );
    }
    (module.at(4) as List).value.forEach((expr) =>
      compileExpression({ ...opts, expr })
    );
  }
  return opts.mod.nop();
};

interface CompileFnCallOpts extends CompileListOpts {
  isReturnCall?: boolean;
}

const compileFunctionCall = (opts: CompileFnCallOpts): number => {
  const { expr, mod, isReturnCall } = opts;
  if (expr.calls("define-type")) return mod.nop();
  if (expr.calls("define-cdt")) return mod.nop();
  if (expr.calls("lambda-expr")) return mod.nop();
  if (expr.calls("define-function")) return compileFunction(opts);
  if (expr.calls("quote")) return (expr.at(1) as Int).value; // TODO: This is an ugly hack to get constants that the compiler needs to know at compile time for ex bnr calls
  if (expr.calls("define-extern-function")) return compileExternFn(opts);
  if (expr.calls("=")) return compileAssign(opts);
  if (expr.calls("if")) return compileIf(opts);

  const isVarDef =
    expr.calls("define") ||
    expr.calls("define-mut") ||
    expr.calls("define-global") ||
    expr.calls("define-mut-global");

  if (isVarDef) return compileDefine(opts);

  if (expr.calls("return-call")) {
    return compileFunctionCall({
      ...opts,
      expr: expr.slice(1),
      isReturnCall: true,
    });
  }

  if (expr.calls("labeled-expr")) {
    return compileExpression({ ...opts, expr: expr.at(2)! });
  }

  if (expr.calls("binaryen-mod") || expr.calls("bnr")) {
    return compileBnrCall(opts);
  }

  const fnId = expr.first() as Identifier;
  const fn = fnId.getTypeOf() as FnType | undefined;
  if (!fn) {
    throw new Error(`Function ${fnId.value} not found`);
  }

  const args = expr.rest().map((expr) => compileExpression({ ...opts, expr }));

  if (isReturnCall) {
    return mod.return_call(fn.binaryenId, args, mapBinaryenType(fn.returns!));
  }

  return mod.call(fn.binaryenId, args, mapBinaryenType(fn.returns!));
};

const compileAssign = (opts: CompileFnCallOpts): number => {
  const { expr, mod } = opts;
  const identifier = expr.at(1) as Identifier;
  const value = compileExpression({ ...opts, expr: expr.at(2)! });
  const variable = identifier.def;
  if (!variable) {
    throw new Error(`${identifier.value} not found in scope`);
  }

  if (variable.kind === "global" && variable.mut) {
    return mod.global.set(identifier.value, value);
  }

  if (variable?.mut) {
    return mod.local.set(variable.index, value);
  }

  throw new Error(`${identifier.value} is not mutable`);
};

const compileBnrCall = (opts: CompileListOpts): number => {
  const { expr } = opts;
  const namespaceId = (expr.at(1)! as List).at(0) as Identifier;
  const funcId = (expr.at(1)! as List).at(1) as Identifier;
  const args = expr.at(2) as List | undefined;
  const namespace =
    namespaceId.value === "mod"
      ? opts.mod
      : (opts.mod as any)[namespaceId.value];
  const func = namespace[funcId.value];
  return func(
    ...(args?.value.map((expr: Expr) => compileExpression({ ...opts, expr })) ??
      [])
  );
};

const compileDefine = (opts: CompileFnCallOpts): number => {
  const { expr, mod } = opts;
  const identifier = expr.at(1) as Identifier;
  const value = compileExpression({ ...opts, expr: expr.at(2)! });

  if (expr.calls("define-global") || expr.calls("define-mut-global")) {
    const type = identifier.getTypeOf()!;
    const binType = mapBinaryenType(type);
    mod.addGlobal(
      identifier.value,
      binType,
      expr.calls("define-mut-global"),
      value
    );
    return mod.nop();
  }

  const info = identifier.setVar(identifier, {
    type: identifier.getTypeOf()!,
    mut: expr.calls("define-mut"),
    kind: "var",
  })!;
  return mod.local.set(info.index, value);
};

const compileFunction = (opts: CompileListOpts): number => {
  const { expr, mod } = opts;
  const fnId = expr.at(1) as Identifier;
  const fn = fnId.getTypeOf() as FnType;
  const parameterTypes = getFunctionParameterTypes(2, expr);
  const returnType = mapBinaryenType(fn.returns!);
  const body = compileList({ ...opts, expr: expr.at(4) as List });
  const variableTypes = getFunctionVarTypes(expr); // TODO: Vars should probably be registered with the function type rather than body (for consistency).

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
  const { expr, mod } = opts;
  const fnId = expr.at(1) as Identifier;
  const fn = fnId.getTypeOf() as FnType;
  const namespace = (expr.at(2) as List).at(1) as Identifier;
  const parameterTypes = getFunctionParameterTypes(3, expr);
  const returnType = mapBinaryenType(fn.returns!);

  mod.addFunctionImport(
    fn.binaryenId,
    namespace.value,
    fnId.value,
    parameterTypes,
    returnType
  );
  return mod.nop();
};

const compileIf = (opts: CompileListOpts) => {
  const { expr, mod } = opts;
  const conditionNode = expr.at(1)!;
  const ifTrueNode = expr.at(2)!;
  const ifFalseNode = expr.at(3)!;
  const condition = compileExpression({ ...opts, expr: conditionNode });
  const ifTrue = compileExpression({ ...opts, expr: ifTrueNode });
  const ifFalse =
    ifFalseNode !== undefined
      ? compileExpression({ ...opts, expr: ifFalseNode })
      : undefined;
  return mod.if(condition, ifTrue, ifFalse);
};

const getFunctionParameterTypes = (paramIndex: number, fnDef: List) => {
  const parameters = fnDef.at(paramIndex) as List;
  const types = parameters.slice(1).value.map((expr) => {
    const list = expr as List;
    const identifier = list.first() as Identifier;
    return mapBinaryenType(identifier.getTypeOf()!);
  });
  return binaryen.createType(types);
};

const getFunctionVarTypes = (fn: Expr) =>
  fn.getAllFnVars().map((v) => mapBinaryenType(v.type!));

const mapBinaryenType = (type: Type): binaryen.Type => {
  if (type.is(i32)) return binaryen.i32;
  if (type.is(f32)) return binaryen.f32;
  if (type.is(i64)) return binaryen.i64;
  if (type.is(f64)) return binaryen.f64;
  if (type.is(dVoid)) return binaryen.none;
  if (isStructType(type)) return binaryen.i32;
  throw new Error(`Unsupported type ${type.value}`);
};
