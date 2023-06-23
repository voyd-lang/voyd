import binaryen from "binaryen";
import {
  Expr,
  Fn,
  FnType,
  Identifier,
  Int,
  List,
  Primitive,
  Type,
  Variable,
  Global,
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

interface CompileExprOpts<T = Expr> {
  expr: T;
  mod: binaryen.Module;
  // TODO Really don't think this is necessary
  parent: Expr;
}

const compileExpression = (opts: CompileExprOpts): number => {
  const { expr, mod } = opts;
  if (expr.isList()) return compileList({ ...opts, expr });
  if (expr.isInt()) return mod.i32.const(expr.value);
  if (expr.isFloat()) return mod.f32.const(expr.value);
  if (expr.isIdentifier()) return compileIdentifier({ ...opts, expr });
  if (expr.isFn()) return compileFunction({ ...opts, expr });
  if (expr.isVariable()) return compileVariable({ ...opts, expr });
  if (expr.isGlobal()) return compileGlobal({ ...opts, expr });

  if (expr.isBool()) {
    return expr.value ? mod.i32.const(1) : mod.i32.const(0);
  }

  throw new Error(`Unrecognized expression ${expr}`);
};

const compileIdentifier = (opts: CompileExprOpts<Identifier>) => {
  const { expr, mod } = opts;

  const entity = expr.resolveEntity(expr);
  if (!entity) {
    throw new Error(`Unrecognized symbol ${expr.value}`);
  }

  if (entity.syntaxType === "global") {
    return mod.global.get(entity.id, mapBinaryenType(entity.getType()));
  }

  if (entity.syntaxType === "variable" || entity.syntaxType === "parameter") {
    return mod.local.get(entity.getIndex(), mapBinaryenType(entity.getType()));
  }

  throw new Error(`Cannot compile identifier ${expr}`);
};

type CompileListOpts = CompileExprOpts<List>;

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

  if (expr.first()?.isIdentifier()) {
    return compileFunctionCall({ ...opts, expr });
  }

  return mod.nop();
};

const compileRootExpr = (opts: CompileListOpts): number => {
  for (const module of opts.expr.rest()) {
    if (!module.isList() || !module.calls("module")) {
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
  if (expr.calls("quote")) return (expr.at(1) as Int).value; // TODO: This is an ugly hack to get constants that the compiler needs to know at compile time for ex bnr calls;
  if (expr.calls("=")) return compileAssign(opts);
  if (expr.calls("if")) return compileIf(opts);

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
    return mod.return_call(fn.fnId, args, mapBinaryenType(fn.returnType));
  }

  return mod.call(fn.fnId, args, mapBinaryenType(fn.returnType));
};

const compileAssign = (opts: CompileFnCallOpts): number => {
  const { expr, mod } = opts;
  const identifier = expr.at(1) as Identifier;
  const value = compileExpression({ ...opts, expr: expr.at(2)! });
  const entity = identifier.resolve();
  if (!entity) {
    throw new Error(`${identifier} not found in scope`);
  }

  if (entity.syntaxType === "global" && entity.isMutable) {
    return mod.global.set(entity.id, value);
  }

  if (entity.syntaxType === "variable" && entity.isMutable) {
    return mod.local.set(entity.getIndex(), value);
  }

  throw new Error(`${identifier} cannot be re-assigned`);
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

const compileVariable = (opts: CompileExprOpts<Variable>): number => {
  const { expr, mod } = opts;
  return mod.local.set(
    expr.getIndex(),
    expr.initializer
      ? compileExpression({ ...opts, expr: expr.initializer })
      : mod.nop()
  );
};

const compileGlobal = (opts: CompileExprOpts<Global>): number => {
  const { expr, mod } = opts;
  mod.addGlobal(
    expr.id,
    mapBinaryenType(expr.getType()),
    expr.isMutable,
    expr.initializer
      ? compileExpression({ ...opts, expr: expr.initializer })
      : mod.nop()
  );
  return mod.nop();
};

const compileFunction = (opts: CompileExprOpts<Fn>): number => {
  const { expr: fn, mod } = opts;
  if (fn.isExternal) return compileExternFn(opts);
  const parameterTypes = getFunctionParameterTypes(fn);
  const returnType = mapBinaryenType(fn.getReturnType());
  const body = compileExpression({ ...opts, expr: fn.body });
  const variableTypes = getFunctionVarTypes(fn); // TODO: Vars should probably be registered with the function type rather than body (for consistency).

  mod.addFunction(fn.id, parameterTypes, returnType, variableTypes, body);
  mod.addFunctionExport(fn.id, fn.id);
  return mod.nop();
};

const compileExternFn = (opts: CompileExprOpts<Fn>) => {
  const { expr: fn, mod } = opts;
  const parameterTypes = getFunctionParameterTypes(fn);

  mod.addFunctionImport(
    fn.id,
    fn.externalNamespace!,
    fn.getName(),
    parameterTypes,
    mapBinaryenType(fn.getReturnType())
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

const getFunctionParameterTypes = (fn: Fn) => {
  const types = fn.parameters.map((param) => mapBinaryenType(param.getType()));
  return binaryen.createType(types);
};

const getFunctionVarTypes = (fn: Fn) =>
  fn.variables.map((v) => mapBinaryenType(v.getType()));

const mapBinaryenType = (type: Type): binaryen.Type => {
  if (isPrimitiveId(type, "i32")) return binaryen.i32;
  if (isPrimitiveId(type, "f32")) return binaryen.f32;
  if (isPrimitiveId(type, "i64")) return binaryen.i64;
  if (isPrimitiveId(type, "f64")) return binaryen.f64;
  if (isPrimitiveId(type, "void")) return binaryen.none;
  if (type.isStructType()) return binaryen.i32;
  throw new Error(`Unsupported type ${type}`);
};

const isPrimitiveId = (type: Type, id: Primitive) =>
  type.isPrimitiveType() && type.name.value === id;
