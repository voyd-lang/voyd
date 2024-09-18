import binaryen from "binaryen";
import { Call } from "./syntax-objects/call.js";
import { Expr } from "./syntax-objects/expr.js";
import { Fn } from "./syntax-objects/fn.js";
import { Identifier } from "./syntax-objects/identifier.js";
import { Int } from "./syntax-objects/int.js";
import {
  Type,
  Primitive,
  ObjectType,
  DsArrayType,
} from "./syntax-objects/types.js";
import { Variable } from "./syntax-objects/variable.js";
import { Block } from "./syntax-objects/block.js";
import { Declaration } from "./syntax-objects/declaration.js";
import { VoidModule } from "./syntax-objects/module.js";
import { ObjectLiteral } from "./syntax-objects/object-literal.js";
import {
  binaryenTypeToHeapType,
  defineStructType,
  initStruct,
  refCast,
  structGetFieldValue,
} from "./lib/binaryen-gc/index.js";
import * as gc from "./lib/binaryen-gc/index.js";
import { TypeRef } from "./lib/binaryen-gc/types.js";
import { getExprType } from "./semantics/resolution/get-expr-type.js";
import { Match, MatchCase } from "./syntax-objects/match.js";
import { initExtensionHelpers } from "./assembler/extension-helpers.js";
import { returnCall } from "./assembler/return-call.js";
import { Float } from "./syntax-objects/float.js";
import { initFieldLookupHelpers } from "./assembler/field-lookup-helpers.js";
import { murmurHash3 } from "./lib/murmur-hash.js";

export const assemble = (ast: Expr) => {
  const mod = new binaryen.Module();
  mod.setMemory(1, 150, "buffer");
  mod.setFeatures(binaryen.Features.All);
  const extensionHelpers = initExtensionHelpers(mod);
  const fieldLookupHelpers = initFieldLookupHelpers(mod);
  compileExpression({ expr: ast, mod, extensionHelpers, fieldLookupHelpers });
  mod.autoDrop();
  return mod;
};

interface CompileExprOpts<T = Expr> {
  expr: T;
  mod: binaryen.Module;
  extensionHelpers: ReturnType<typeof initExtensionHelpers>;
  fieldLookupHelpers: ReturnType<typeof initFieldLookupHelpers>;
  isReturnExpr?: boolean;
}

const compileExpression = (opts: CompileExprOpts): number => {
  const { expr, mod, isReturnExpr } = opts;
  opts.isReturnExpr = false;
  // These can take isReturnExpr
  if (expr.isCall()) return compileCall({ ...opts, expr, isReturnExpr });
  if (expr.isBlock()) return compileBlock({ ...opts, expr, isReturnExpr });
  if (expr.isMatch()) return compileMatch({ ...opts, expr, isReturnExpr });
  if (expr.isInt()) return compileInt({ ...opts, expr });
  if (expr.isFloat()) return compileFloat({ ...opts, expr });
  if (expr.isIdentifier()) return compileIdentifier({ ...opts, expr });
  if (expr.isFn()) return compileFunction({ ...opts, expr });
  if (expr.isVariable()) return compileVariable({ ...opts, expr });
  if (expr.isDeclaration()) return compileDeclaration({ ...opts, expr });
  if (expr.isModule()) return compileModule({ ...opts, expr });
  if (expr.isObjectLiteral()) return compileObjectLiteral({ ...opts, expr });
  if (expr.isType()) return compileType({ ...opts, expr });
  if (expr.isImpl()) return mod.nop();
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

const compileInt = (opts: CompileExprOpts<Int>) => {
  const val = opts.expr.value;
  if (typeof val === "number") {
    return opts.mod.i32.const(val);
  }

  const i64Int = val.value;
  const low = Number(i64Int & BigInt(0xffffffff)); // Extract lower 32 bits
  const high = Number((i64Int >> BigInt(32)) & BigInt(0xffffffff)); // Extract higher 32 bits
  return opts.mod.i64.const(low, high);
};

const compileFloat = (opts: CompileExprOpts<Float>) => {
  const val = opts.expr.value;
  if (typeof val === "number") {
    return opts.mod.f32.const(val);
  }

  return opts.mod.f64.const(val.value);
};

const compileType = (opts: CompileExprOpts<Type>) => {
  const type = opts.expr;

  if (type.isObjectType()) {
    buildObjectType(opts, type);
    return opts.mod.nop();
  }

  return opts.mod.nop();
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
    opts.expr.body.map((expr, index, array) => {
      if (index === array.length - 1) {
        return compileExpression({ ...opts, expr, isReturnExpr: true });
      }

      return compileExpression({ ...opts, expr, isReturnExpr: false });
    })
  );
};

const compileMatch = (opts: CompileExprOpts<Match>) => {
  const { expr } = opts;

  const constructIfChain = (cases: MatchCase[]): number => {
    const nextCase = cases.shift();
    if (!nextCase) return opts.mod.unreachable();

    if (!cases.length) {
      return compileExpression({ ...opts, expr: nextCase.expr });
    }

    return opts.mod.if(
      opts.mod.call(
        "__extends",
        [
          opts.mod.i32.const(nextCase.matchType!.syntaxId),
          structGetFieldValue({
            mod: opts.mod,
            fieldType: opts.extensionHelpers.i32Array,
            fieldIndex: 0,
            exprRef: compileIdentifier({ ...opts, expr: expr.bindIdentifier }),
          }),
        ],
        binaryen.i32
      ),
      compileExpression({ ...opts, expr: nextCase.expr }),
      constructIfChain(cases)
    );
  };

  return constructIfChain(
    expr.defaultCase ? [...expr.cases, expr.defaultCase] : expr.cases
  );
};

const compileIdentifier = (opts: CompileExprOpts<Identifier>) => {
  const { expr, mod } = opts;

  const entity = expr.resolve();
  if (!entity) {
    throw new Error(`Unrecognized symbol ${expr.value}`);
  }

  if (entity.isVariable() || entity.isParameter()) {
    const type = mapBinaryenType(opts, entity.originalType ?? entity.type!);
    const get = mod.local.get(entity.getIndex(), type);
    if (entity.requiresCast) {
      return refCast(mod, get, mapBinaryenType(opts, entity.type!));
    }
    return get;
  }

  throw new Error(`Cannot compile identifier ${expr}`);
};

const compileCall = (opts: CompileExprOpts<Call>): number => {
  const { expr, mod, isReturnExpr } = opts;
  if (expr.calls("quote")) return (expr.argAt(0) as { value: number }).value; // TODO: This is an ugly hack to get constants that the compiler needs to know at compile time for ex bnr calls;
  if (expr.calls("=")) return compileAssign(opts);
  if (expr.calls("if")) return compileIf(opts);
  if (expr.calls("export")) return compileExport(opts);
  if (expr.calls("mod")) return mod.nop();
  if (expr.calls("member-access")) return compileObjMemberAccess(opts);

  if (expr.calls("binaryen")) {
    return compileBnrCall(opts);
  }

  if (!expr.fn) {
    throw new Error(`No function found for call ${expr.location}`);
  }

  if (expr.fn.isObjectType()) {
    return compileObjectInit(opts);
  }

  const args = expr.args
    .toArray()
    .map((expr) => compileExpression({ ...opts, expr, isReturnExpr: false }));

  const id = expr.fn!.id;
  const returnType = mapBinaryenType(opts, expr.fn!.returnType!);

  if (isReturnExpr) {
    return returnCall(mod, id, args, returnType);
  }

  return mod.call(id, args, returnType);
};

const compileObjectInit = (opts: CompileExprOpts<Call>) => {
  const { expr, mod } = opts;

  const objectType = getExprType(expr) as ObjectType;
  const objectBinType = mapBinaryenType(opts, objectType);
  const obj = expr.argAt(0) as ObjectLiteral;

  return initStruct(mod, binaryenTypeToHeapType(objectBinType), [
    mod.global.get(
      `__ancestors_table_${objectType.id}`,
      opts.extensionHelpers.i32Array
    ),
    mod.global.get(
      `__field_index_table_${objectType.id}`,
      opts.extensionHelpers.i32Array
    ),
    ...obj.fields.map((field) =>
      compileExpression({
        ...opts,
        expr: field.initializer,
        isReturnExpr: false,
      })
    ),
  ]);
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
  const value = compileExpression({
    ...opts,
    expr: expr.argAt(1)!,
    isReturnExpr: false,
  });
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
  const namespace = (expr.labeledArgAt(1) as Identifier).value;
  const args = expr.labeledArgAt(2) as Call;

  const func =
    namespace === "gc"
      ? (...args: unknown[]) => (gc as any)[funcId.value](opts.mod, ...args)
      : (opts.mod as any)[namespace][funcId.value];

  return func(
    ...(args.argArrayMap((expr: Expr) => {
      if (expr?.isCall() && expr.calls("BnrType")) {
        const type = getExprType(expr.typeArgs?.at(0));
        if (!type) return opts.mod.nop();
        return mapBinaryenType(opts, type);
      }

      if (expr?.isCall() && expr.calls("BnrConst")) {
        const arg = expr.argAt(0);
        if (!arg) return opts.mod.nop();
        if ("value" in arg) return arg.value;
      }

      return compileExpression({ ...opts, expr });
    }) ?? [])
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
  if (fn.genericInstances) {
    fn.genericInstances.forEach((instance) =>
      compileFunction({ ...opts, expr: instance })
    );
    return mod.nop();
  }

  if (fn.typeParameters) {
    return mod.nop();
  }

  const parameterTypes = getFunctionParameterTypes(opts, fn);
  const returnType = mapBinaryenType(opts, fn.getReturnType());

  const body = compileExpression({
    ...opts,
    expr: fn.body!,
    isReturnExpr: true,
  });

  const variableTypes = getFunctionVarTypes(opts, fn); // TODO: Vars should probably be registered with the function type rather than body (for consistency).

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
  const parameterTypes = getFunctionParameterTypes(opts, fn);

  mod.addFunctionImport(
    fn.id,
    namespace,
    fn.getNameStr(),
    parameterTypes,
    mapBinaryenType(opts, fn.getReturnType())
  );

  return mod.nop();
};

const compileObjectLiteral = (opts: CompileExprOpts<ObjectLiteral>) => {
  const { expr: obj, mod } = opts;

  const objectType = getExprType(obj) as ObjectType;
  const literalBinType = mapBinaryenType(opts, objectType);

  return initStruct(mod, binaryenTypeToHeapType(literalBinType), [
    mod.global.get(
      `__ancestors_table_${objectType.id}`,
      opts.extensionHelpers.i32Array
    ),
    mod.global.get(
      `__field_index_table_${objectType.id}`,
      opts.extensionHelpers.i32Array
    ),
    ...obj.fields.map((field) =>
      compileExpression({ ...opts, expr: field.initializer })
    ),
  ]);
};

const compileIf = (opts: CompileExprOpts<Call>) => {
  const { expr, mod } = opts;
  const conditionNode = expr.exprArgAt(0);
  const ifTrueNode = expr.labeledArgAt(1);
  const ifFalseNode = expr.optionalLabeledArgAt(2);
  const condition = compileExpression({
    ...opts,
    expr: conditionNode,
    isReturnExpr: false,
  });
  const ifTrue = compileExpression({ ...opts, expr: ifTrueNode });
  const ifFalse =
    ifFalseNode !== undefined
      ? compileExpression({ ...opts, expr: ifFalseNode })
      : undefined;

  return mod.if(condition, ifTrue, ifFalse);
};

const getFunctionParameterTypes = (opts: CompileExprOpts, fn: Fn) => {
  const types = fn.parameters.map((param) =>
    mapBinaryenType(opts, param.type!)
  );
  return binaryen.createType(types);
};

const getFunctionVarTypes = (opts: CompileExprOpts, fn: Fn) =>
  fn.variables.map((v) => mapBinaryenType(opts, v.type!));

const mapBinaryenType = (opts: CompileExprOpts, type: Type): binaryen.Type => {
  if (isPrimitiveId(type, "bool")) return binaryen.i32;
  if (isPrimitiveId(type, "i32")) return binaryen.i32;
  if (isPrimitiveId(type, "f32")) return binaryen.f32;
  if (isPrimitiveId(type, "i64")) return binaryen.i64;
  if (isPrimitiveId(type, "f64")) return binaryen.f64;
  if (isPrimitiveId(type, "void")) return binaryen.none;
  if (type.isObjectType()) return buildObjectType(opts, type);
  if (type.isDsArrayType()) return buildDsArrayType(opts, type);
  throw new Error(`Unsupported type ${type}`);
};

const isPrimitiveId = (type: Type, id: Primitive) =>
  type.isPrimitiveType() && type.name.value === id;

const buildDsArrayType = (opts: CompileExprOpts, type: DsArrayType) => {
  if (type.binaryenType) return type.binaryenType;
  const mod = opts.mod;
  const elemType = mapBinaryenType(opts, type.elemType!);
  type.binaryenType = gc.defineArrayType(mod, elemType, true, type.id);
  return type.binaryenType;
};

// Marks the start of the fields in an object after RTT info fields
const OBJECT_FIELDS_OFFSET = 2;

/** TODO: Skip building types for object literals that are part of an initializer of an obj */
const buildObjectType = (opts: CompileExprOpts, obj: ObjectType): TypeRef => {
  if (obj.binaryenType) return obj.binaryenType;
  if (obj.typeParameters) return opts.mod.nop();
  const mod = opts.mod;

  const binaryenType = defineStructType(mod, {
    name: obj.id,
    fields: [
      // Reference to the RTT Ancestors Table
      {
        type: opts.extensionHelpers.i32Array,
        name: "__ancestors_table",
      },
      {
        type: opts.fieldLookupHelpers.lookupTableType,
        name: "__field_index_table",
      },
      // Reference to the field index lookup function
      // TODO
      // Fields
      ...obj.fields.map((field) => ({
        type: mapBinaryenType(opts, field.type!),
        name: field.name,
      })),
    ],
    supertype: obj.parentObjType
      ? binaryenTypeToHeapType(mapBinaryenType(opts, obj.parentObjType))
      : undefined,
  });

  // Set RTT Ancestors Table (So we don't have to re-calculate it every time)
  mod.addGlobal(
    `__ancestors_table_${obj.id}`,
    opts.extensionHelpers.i32Array,
    false,
    opts.extensionHelpers.initExtensionArray(obj.getAncestorIds())
  );

  // Set Field Index Table
  // Set RTT Table (So we don't have to re-calculate it every time)
  mod.addGlobal(
    `__field_index_table_${obj.id}`,
    opts.extensionHelpers.i32Array,
    false,
    opts.fieldLookupHelpers.initFieldIndexTable(
      obj.fields.map((field) => murmurHash3(field.name))
    )
  );

  obj.binaryenType = binaryenType;

  if (obj.implementations?.length) {
    obj.implementations.forEach((impl) =>
      impl.methods.forEach((fn) => compileFunction({ ...opts, expr: fn }))
    );
  }

  return binaryenType;
};

const compileObjMemberAccess = (opts: CompileExprOpts<Call>) => {
  const { expr, mod } = opts;
  const obj = expr.exprArgAt(0);
  const member = expr.identifierArgAt(1);
  const objValue = compileExpression({ ...opts, expr: obj });
  const type = getExprType(obj) as ObjectType;
  const memberIndex = type.getFieldIndex(member) + OBJECT_FIELDS_OFFSET;
  const field = type.getField(member)!;
  return structGetFieldValue({
    mod,
    fieldIndex: memberIndex,
    fieldType: mapBinaryenType(opts, field.type!),
    exprRef: objValue,
  });
};
