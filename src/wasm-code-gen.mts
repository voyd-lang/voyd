import binaryen from "binaryen";
import { Call } from "./syntax-objects/call.mjs";
import { Expr } from "./syntax-objects/expr.mjs";
import { Fn } from "./syntax-objects/fn.mjs";
import { Identifier } from "./syntax-objects/identifier.mjs";
import { Int } from "./syntax-objects/int.mjs";
import { Type, Primitive } from "./syntax-objects/types.mjs";
import { Variable } from "./syntax-objects/variable.mjs";
import { Block } from "./syntax-objects/block.mjs";
import { Declaration } from "./syntax-objects/declaration.mjs";
import { VoidModule } from "./syntax-objects/module.mjs";

export const genWasmCode = (ast: Expr) => {
  const mod = new binaryen.Module();
  mod.setMemory(1, 150, "buffer");
  mod.setFeatures(binaryen.Features.All);
  compileExpression({ expr: ast, mod });
  mod.autoDrop();
  return mod;
};

interface CompileExprOpts<T = Expr> {
  expr: T;
  mod: binaryen.Module;
}

const compileExpression = (opts: CompileExprOpts): number => {
  const { expr, mod } = opts;
  if (expr.isCall()) return compileCall({ ...opts, expr });
  if (expr.isInt()) return mod.i32.const(expr.value);
  if (expr.isFloat()) return mod.f32.const(expr.value);
  if (expr.isIdentifier()) return compileIdentifier({ ...opts, expr });
  if (expr.isFn()) return compileFunction({ ...opts, expr });
  if (expr.isVariable()) return compileVariable({ ...opts, expr });
  if (expr.isBlock()) return compileBlock({ ...opts, expr });
  if (expr.isDeclaration()) return compileDeclaration({ ...opts, expr });
  if (expr.isModule()) return compileModule({ ...opts, expr });
  if (expr.isType()) return mod.nop();
  if (expr.isUse()) return mod.nop();

  if (expr.isBool()) {
    return expr.value ? mod.i32.const(1) : mod.i32.const(0);
  }

  throw new Error(
    `Unrecognized expression ${expr.syntaxType} ${expr.location}`
  );
};

const compileModule = (opts: CompileExprOpts<VoidModule>) => {
  return opts.mod.block(
    opts.expr.id,
    opts.expr.value.map((expr) => compileExpression({ ...opts, expr }))
  );
};

const compileBlock = (opts: CompileExprOpts<Block>) => {
  return opts.mod.block(
    null,
    opts.expr.body.toArray().map((expr) => compileExpression({ ...opts, expr }))
  );
};

const compileIdentifier = (opts: CompileExprOpts<Identifier>) => {
  const { expr, mod } = opts;

  const entity = expr.resolveEntity(expr);
  if (!entity) {
    throw new Error(`Unrecognized symbol ${expr.value}`);
  }

  // if (entity.isGlobal()) {
  //   return mod.global.get(entity.id, mapBinaryenType(entity.getType()));
  // }

  if (entity.isVariable() || entity.isParameter()) {
    return mod.local.get(entity.getIndex(), mapBinaryenType(entity.type!));
  }

  throw new Error(`Cannot compile identifier ${expr}`);
};

const compileCall = (opts: CompileExprOpts<Call>): number => {
  const { expr, mod } = opts;
  if (expr.calls("quote")) return (expr.argAt(0) as Int).value; // TODO: This is an ugly hack to get constants that the compiler needs to know at compile time for ex bnr calls;
  if (expr.calls("=")) return compileAssign(opts);
  if (expr.calls("if")) return compileIf(opts);

  if (expr.calls("binaryen")) {
    return compileBnrCall(opts);
  }

  const args = expr.args
    .toArray()
    .map((expr) => compileExpression({ ...opts, expr }));

  return mod.call(expr.fn!.id, args, mapBinaryenType(expr.fn!.returnType!));
};

const compileAssign = (opts: CompileExprOpts<Call>): number => {
  const { expr, mod } = opts;
  const identifier = expr.argAt(0) as Identifier;
  const value = compileExpression({ ...opts, expr: expr.argAt(1)! });
  const entity = identifier.resolve();
  if (!entity) {
    throw new Error(`${identifier} not found in scope`);
  }

  if (entity.isVariable()) {
    return mod.local.set(entity.getIndex(), value);
  }

  throw new Error(`${identifier} cannot be re-assigned`);
};

const compileBnrCall = (opts: CompileExprOpts<Call>): number => {
  const { expr } = opts;
  const funcId = expr.callArgAt(1).identifierArgAt(1);
  const args = expr.callArgAt(3).callArgAt(0);
  const func = (opts.mod as any)[funcId.value];
  return func(
    ...(args.argArrayMap((expr: Expr) =>
      compileExpression({ ...opts, expr })
    ) ?? [])
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

const compileFunction = (opts: CompileExprOpts<Fn>): number => {
  const { expr: fn, mod } = opts;
  const parameterTypes = getFunctionParameterTypes(fn);
  const returnType = mapBinaryenType(fn.getReturnType());
  const body = compileExpression({ ...opts, expr: fn.body! });
  const variableTypes = getFunctionVarTypes(fn); // TODO: Vars should probably be registered with the function type rather than body (for consistency).

  mod.addFunction(fn.id, parameterTypes, returnType, variableTypes, body);
  mod.addFunctionExport(fn.id, fn.id);
  return mod.nop();
};

const compileDeclaration = (opts: CompileExprOpts<Declaration>) => {
  const { expr: decl, mod } = opts;

  decl.fns.forEach((expr) =>
    compileExternFn({ ...opts, expr, namespace: decl.namespace })
  );

  return mod.nop();
};

const compileExternFn = (opts: CompileExprOpts<Fn> & { namespace: string }) => {
  const { expr: fn, mod, namespace } = opts;
  const parameterTypes = getFunctionParameterTypes(fn);

  mod.addFunctionImport(
    fn.id,
    namespace,
    fn.getNameStr(),
    parameterTypes,
    mapBinaryenType(fn.getReturnType())
  );

  return mod.nop();
};

const compileIf = (opts: CompileExprOpts<Call>) => {
  const { expr, mod } = opts;
  const conditionNode = expr.exprArgAt(0);
  const ifTrueNode = expr.exprArgAt(1);
  const ifFalseNode = expr.argAt(2);
  const condition = compileExpression({ ...opts, expr: conditionNode });
  const ifTrue = compileExpression({ ...opts, expr: ifTrueNode });
  const ifFalse =
    ifFalseNode !== undefined
      ? compileExpression({ ...opts, expr: ifFalseNode })
      : undefined;

  return mod.if(condition, ifTrue, ifFalse);
};

const getFunctionParameterTypes = (fn: Fn) => {
  const types = fn.parameters.map((param) => mapBinaryenType(param.type!));
  return binaryen.createType(types);
};

const getFunctionVarTypes = (fn: Fn) =>
  fn.variables.map((v) => mapBinaryenType(v.type!));

const mapBinaryenType = (type: Type): binaryen.Type => {
  if (isPrimitiveId(type, "bool")) return binaryen.i32;
  if (isPrimitiveId(type, "i32")) return binaryen.i32;
  if (isPrimitiveId(type, "f32")) return binaryen.f32;
  if (isPrimitiveId(type, "i64")) return binaryen.i64;
  if (isPrimitiveId(type, "f64")) return binaryen.f64;
  if (isPrimitiveId(type, "void")) return binaryen.none;
  if (type.isObjectType()) return binaryen.i32;
  throw new Error(`Unsupported type ${type}`);
};

const isPrimitiveId = (type: Type, id: Primitive) =>
  type.isPrimitiveType() && type.name.value === id;
