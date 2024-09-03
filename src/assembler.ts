import binaryen from "binaryen";
import { Call } from "./syntax-objects/call.js";
import { Expr } from "./syntax-objects/expr.js";
import { Fn } from "./syntax-objects/fn.js";
import { Identifier } from "./syntax-objects/identifier.js";
import { Int } from "./syntax-objects/int.js";
import { Type, Primitive, ObjectType } from "./syntax-objects/types.js";
import { Variable } from "./syntax-objects/variable.js";
import { Block } from "./syntax-objects/block.js";
import { Declaration } from "./syntax-objects/declaration.js";
import { VoidModule } from "./syntax-objects/module.js";
import { ObjectLiteral } from "./syntax-objects/object-literal.js";
import {
  binaryenTypeToHeapType,
  defineStructType,
  initStruct,
  structGetFieldValue,
} from "./lib/binaryen-gc/index.js";
import { HeapTypeRef } from "./lib/binaryen-gc/types.js";
import { getExprType } from "./semantics/resolution/get-expr-type.js";

export const assemble = (ast: Expr) => {
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
  if (expr.isObjectLiteral()) return compileObjectLiteral({ ...opts, expr });
  if (expr.isType()) return mod.nop();
  if (expr.isUse()) return mod.nop();
  if (expr.isMacro()) return mod.nop();
  if (expr.isMacroVariable()) return mod.nop();

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

  const entity = expr.resolve();
  if (!entity) {
    throw new Error(`Unrecognized symbol ${expr.value}`);
  }

  if (entity.isVariable() || entity.isParameter()) {
    const type = mapBinaryenType(mod, entity.type!);
    return mod.local.get(entity.getIndex(), type);
  }

  throw new Error(`Cannot compile identifier ${expr}`);
};

const compileCall = (opts: CompileExprOpts<Call>): number => {
  const { expr, mod } = opts;
  if (expr.calls("quote")) return (expr.argAt(0) as Int).value; // TODO: This is an ugly hack to get constants that the compiler needs to know at compile time for ex bnr calls;
  if (expr.calls("=")) return compileAssign(opts);
  if (expr.calls("if")) return compileIf(opts);
  if (expr.calls("export")) return compileExport(opts);
  if (expr.calls("member-access")) return compileObjMemberAccess(opts);

  if (expr.calls("binaryen")) {
    return compileBnrCall(opts);
  }

  const args = expr.args
    .toArray()
    .map((expr) => compileExpression({ ...opts, expr }));

  if (!expr.fn) {
    throw new Error(`No function found for call ${expr.location}`);
  }

  if (expr.fn.isObjectType()) {
    return compileObjectInit(opts);
  }

  return mod.call(
    expr.fn!.id,
    args,
    mapBinaryenType(mod, expr.fn!.returnType!)
  );
};

const compileObjectInit = (opts: CompileExprOpts<Call>) => {
  const { expr, mod } = opts;

  const objectType = mapBinaryenType(mod, expr.type!);
  const obj = expr.argAt(0) as ObjectLiteral;

  return initStruct(
    mod,
    binaryenTypeToHeapType(objectType),
    obj.fields.map((field) =>
      compileExpression({ ...opts, expr: field.initializer })
    )
  );
};

const compileExport = (opts: CompileExprOpts<Call>) => {
  const expr = opts.expr.exprArgAt(0);
  const result = compileExpression({ ...opts, expr });

  if (expr.parentModule?.isIndex && expr.isBlock()) {
    expr.getAllEntities().forEach((entity) => {
      if (entity.isFn()) {
        opts.mod.addFunctionExport(entity.id, entity.name.value);
      }
    });
  }

  return result;
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
  const funcId = expr.labeledArgAt(0) as Identifier;
  const argTypes = expr.labeledArgAt(1) as Call;
  const namespace = argTypes.identifierArgAt(0).value;
  const args = expr.labeledArgAt(3) as Call;
  const func = (opts.mod as any)[namespace][funcId.value];
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
  const parameterTypes = getFunctionParameterTypes(mod, fn);
  const returnType = mapBinaryenType(mod, fn.getReturnType());
  const body = compileExpression({ ...opts, expr: fn.body! });
  const variableTypes = getFunctionVarTypes(mod, fn); // TODO: Vars should probably be registered with the function type rather than body (for consistency).

  mod.addFunction(fn.id, parameterTypes, returnType, variableTypes, body);

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
  const parameterTypes = getFunctionParameterTypes(mod, fn);

  mod.addFunctionImport(
    fn.id,
    namespace,
    fn.getNameStr(),
    parameterTypes,
    mapBinaryenType(mod, fn.getReturnType())
  );

  return mod.nop();
};

const compileObjectLiteral = (opts: CompileExprOpts<ObjectLiteral>) => {
  const { expr: obj, mod } = opts;

  const literalType = mapBinaryenType(mod, obj.type!);

  return initStruct(
    mod,
    binaryenTypeToHeapType(literalType),
    obj.fields.map((field) =>
      compileExpression({ ...opts, expr: field.initializer })
    )
  );
};

const compileIf = (opts: CompileExprOpts<Call>) => {
  const { expr, mod } = opts;
  const conditionNode = expr.exprArgAt(0);
  const ifTrueNode = expr.labeledArgAt(1);
  const ifFalseNode = expr.optionalLabeledArgAt(2);
  const condition = compileExpression({ ...opts, expr: conditionNode });
  const ifTrue = compileExpression({ ...opts, expr: ifTrueNode });
  const ifFalse =
    ifFalseNode !== undefined
      ? compileExpression({ ...opts, expr: ifFalseNode })
      : undefined;

  return mod.if(condition, ifTrue, ifFalse);
};

const getFunctionParameterTypes = (mod: binaryen.Module, fn: Fn) => {
  const types = fn.parameters.map((param) => mapBinaryenType(mod, param.type!));
  return binaryen.createType(types);
};

const getFunctionVarTypes = (mod: binaryen.Module, fn: Fn) =>
  fn.variables.map((v) => mapBinaryenType(mod, v.type!));

const mapBinaryenType = (mod: binaryen.Module, type: Type): binaryen.Type => {
  if (isPrimitiveId(type, "bool")) return binaryen.i32;
  if (isPrimitiveId(type, "i32")) return binaryen.i32;
  if (isPrimitiveId(type, "f32")) return binaryen.f32;
  if (isPrimitiveId(type, "i64")) return binaryen.i64;
  if (isPrimitiveId(type, "f64")) return binaryen.f64;
  if (isPrimitiveId(type, "void")) return binaryen.none;
  if (type.isObjectType()) {
    return type.binaryenType ? type.binaryenType : buildObjectType(mod, type);
  }
  throw new Error(`Unsupported type ${type}`);
};

const isPrimitiveId = (type: Type, id: Primitive) =>
  type.isPrimitiveType() && type.name.value === id;

const buildObjectType = (
  mod: binaryen.Module,
  obj: ObjectType
): HeapTypeRef => {
  const binaryenType = defineStructType(mod, {
    name: obj.id,
    fields: obj.fields.map((field) => ({
      type: mapBinaryenType(mod, field.type!),
      name: field.name,
    })),
    supertype: obj.parentObj
      ? binaryenTypeToHeapType(mapBinaryenType(mod, obj.parentObj))
      : undefined,
  });
  obj.binaryenType = binaryenType;
  return binaryenType;
};

const compileObjMemberAccess = (opts: CompileExprOpts<Call>) => {
  const { expr, mod } = opts;
  const obj = expr.exprArgAt(0);
  const member = expr.identifierArgAt(1);
  const objValue = compileExpression({ ...opts, expr: obj });
  const type = getExprType(obj) as ObjectType;
  const memberIndex = type.getFieldIndex(member);
  const field = type.getField(member)!;
  return structGetFieldValue({
    mod,
    fieldIndex: memberIndex,
    fieldType: mapBinaryenType(mod, field.type!),
    exprRef: objValue,
  });
};
