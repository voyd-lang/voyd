import binaryen from "binaryen";
import { Expr } from "./syntax-objects/expr.js";
import {
  Type,
  Primitive,
  ObjectType,
  FixedArrayType,
  voydBaseObject,
  voydString,
  UnionType,
  IntersectionType,
} from "./syntax-objects/types.js";
import {
  binaryenTypeToHeapType,
  annotateStructNames,
  TypeBuilder,
} from "./lib/binaryen-gc/index.js";
import * as gc from "./lib/binaryen-gc/index.js";
import { TypeRef } from "./lib/binaryen-gc/types.js";
import { initExtensionHelpers } from "./codegen/rtt/extension.js";
import {
  initFieldLookupHelpers,
  initMethodLookupHelpers,
} from "./codegen/index.js";

import { compile as compileCall } from "./codegen/compile-call.js";
import { compile as compileBlock } from "./codegen/compile-block.js";
import { compile as compileMatch } from "./codegen/compile-match.js";
import { compile as compileInt } from "./codegen/compile-int.js";
import { compile as compileStringLiteral } from "./codegen/compile-string-literal.js";
import { compile as compileFloat } from "./codegen/compile-float.js";
import { compile as compileIdentifier } from "./codegen/compile-identifier.js";
import { compile as compileFunction } from "./codegen/compile-function.js";
import { compile as compileVariable } from "./codegen/compile-variable.js";
import { compile as compileDeclaration } from "./codegen/compile-declaration.js";
import { compile as compileModule } from "./codegen/compile-module.js";
import { compile as compileObjectLiteral } from "./codegen/compile-object-literal.js";
import { compile as compileType } from "./codegen/compile-type.js";
import { compile as compileBool } from "./codegen/compile-bool.js";
import { compile as compileImpl } from "./codegen/compile-impl.js";
import { compile as compileUse } from "./codegen/compile-use.js";
import { compile as compileTrait } from "./codegen/compile-trait.js";
import { compile as compileMacro } from "./codegen/compile-macro.js";
import { compile as compileMacroVariable } from "./codegen/compile-macro-variable.js";
import {
  compile as compileClosure,
  getClosureSuperType,
} from "./codegen/compile-closure.js";

const buildingTypePlaceholders = new Map<ObjectType, TypeRef>();

export const codegen = (ast: Expr) => {
  const mod = new binaryen.Module();
  mod.setFeatures(binaryen.Features.All);
  mod.setMemory(0, 1, "main_memory", []);
  const extensionHelpers = initExtensionHelpers(mod);
  const fieldLookupHelpers = initFieldLookupHelpers(mod);
  const methodLookupHelpers = initMethodLookupHelpers(mod);
  compileExpression({
    expr: ast,
    mod,
    extensionHelpers,
    fieldLookupHelpers,
    methodLookupHelpers,
  });
  return mod;
};

export const asStmt = (mod: binaryen.Module, expr: number) => {
  const type = binaryen.getExpressionType(expr);
  return type === binaryen.none || type === binaryen.unreachable
    ? expr
    : mod.drop(expr);
};

export interface CompileExprOpts<T = Expr> {
  expr: T;
  mod: binaryen.Module;
  extensionHelpers: ReturnType<typeof initExtensionHelpers>;
  fieldLookupHelpers: ReturnType<typeof initFieldLookupHelpers>;
  methodLookupHelpers: ReturnType<typeof initMethodLookupHelpers>;
  isReturnExpr?: boolean;
  loopBreakId?: string;
}

type CompilerFn = (opts: CompileExprOpts<any>) => number;

export const compilers: Record<string, CompilerFn> = {
  call: compileCall,
  block: compileBlock,
  match: compileMatch,
  int: compileInt,
  "string-literal": compileStringLiteral,
  float: compileFloat,
  identifier: compileIdentifier,
  fn: compileFunction,
  variable: compileVariable,
  declaration: compileDeclaration,
  module: compileModule,
  "object-literal": compileObjectLiteral,
  type: compileType,
  bool: compileBool,
  implementation: compileImpl,
  use: compileUse,
  trait: compileTrait,
  macro: compileMacro,
  "macro-variable": compileMacroVariable,
  closure: compileClosure,
};

export const compileExpression = (opts: CompileExprOpts): number => {
  const compiler = compilers[opts.expr.syntaxType];
  if (compiler) return compiler(opts);

  throw new Error(
    `Unrecognized expression ${opts.expr.syntaxType} ${opts.expr.location}`
  );
};

type MapBinTypeOpts = CompileExprOpts & {
  useOriginalType?: boolean; // Use the original type of the object literal
};

export const mapBinaryenType = (
  opts: MapBinTypeOpts,
  type: Type
): binaryen.Type => {
  if (isPrimitiveId(type, "bool")) return binaryen.i32;
  if (isPrimitiveId(type, "i32")) return binaryen.i32;
  if (isPrimitiveId(type, "f32")) return binaryen.f32;
  if (isPrimitiveId(type, "i64")) return binaryen.i64;
  if (isPrimitiveId(type, "f64")) return binaryen.f64;
  if (isPrimitiveId(type, "voyd") || isPrimitiveId(type, "void"))
    return binaryen.none;
  if (type === voydString) return getI32ArrayType(opts.mod);

  if (type.isObjectType()) {
    if (buildingTypePlaceholders.has(type)) {
      return buildingTypePlaceholders.get(type)!;
    }
    return buildObjectType(opts, type);
  }
  if (type.isFnType()) return getClosureSuperType(opts.mod);
  if (type.isTraitType()) return buildObjectType(opts, voydBaseObject);
  if (type.isSelfType()) return buildObjectType(opts, voydBaseObject);
  if (type.isUnionType()) return buildUnionType(opts, type);
  if (type.isFixedArrayType()) return buildFixedArrayType(opts, type);
  if (type.isIntersectionType()) return buildIntersectionType(opts, type);
  throw new Error(`Unsupported type ${type}`);
};

const isPrimitiveId = (type: Type, id: Primitive) =>
  type.isPrimitiveType() && type.name.value === id;

const buildFixedArrayType = (opts: CompileExprOpts, type: FixedArrayType) => {
  if (type.binaryenType) return type.binaryenType;
  const mod = opts.mod;
  const elemType = mapBinaryenType(opts, type.elemType!);
  type.binaryenType = gc.defineArrayType(mod, elemType, true, type.id);
  return type.binaryenType;
};

export const buildUnionType = (
  opts: MapBinTypeOpts,
  union: UnionType
): TypeRef => {
  if (union.hasAttribute("binaryenType")) {
    return union.getAttribute("binaryenType") as TypeRef;
  }

  const typeRef = mapBinaryenType(opts, voydBaseObject);
  union.setAttribute("binaryenType", typeRef);
  return typeRef;
};

export const buildIntersectionType = (
  opts: MapBinTypeOpts,
  inter: IntersectionType
): TypeRef => {
  if (inter.hasAttribute("binaryenType")) {
    return inter.getAttribute("binaryenType") as TypeRef;
  }

  const typeRef = mapBinaryenType(opts, inter.nominalType!);
  mapBinaryenType(opts, inter.structuralType!);
  inter.setAttribute("binaryenType", typeRef);
  return typeRef;
};

export const buildObjectType = (
  opts: MapBinTypeOpts,
  obj: ObjectType
): TypeRef => {
  if (opts.useOriginalType && obj.getAttribute("originalType")) {
    return obj.getAttribute("originalType") as TypeRef;
  }

  if (obj.binaryenType) return obj.binaryenType;
  if (obj.typeParameters) return opts.mod.nop();
  const mod = opts.mod;

  const builder = new TypeBuilder(1);
  try {
    const tempRef = builder.getTempRefType(0, true);
    buildingTypePlaceholders.set(obj, tempRef);

    const fields = [
      { type: opts.extensionHelpers.i32Array, name: "__ancestors_table" },
      {
        type: opts.fieldLookupHelpers.lookupTableType,
        name: "__field_index_table",
      },
      {
        type: opts.methodLookupHelpers.lookupTableType,
        name: "__method_lookup_table",
      },
      ...obj.fields.map((field) => ({
        type: mapBinaryenType(opts, field.type!),
        name: field.name,
        mutable: true,
      })),
    ];

    builder.setStruct(0, { name: obj.id, fields });

    const supertype = obj.parentObjType
      ? binaryenTypeToHeapType(mapBinaryenType(opts, obj.parentObjType))
      : undefined;
    if (supertype) builder.setSubType(0, supertype);
    builder.setOpen(0);

    const heapType = builder.build();
    annotateStructNames(mod, heapType, { name: obj.id, fields, supertype });

    obj.binaryenType = gc.binaryenTypeFromHeapType(heapType, true);
  } finally {
    buildingTypePlaceholders.delete(obj);
    builder.dispose();
  }

  mod.addGlobal(
    `__ancestors_table_${obj.id}`,
    opts.extensionHelpers.i32Array,
    false,
    opts.extensionHelpers.initExtensionArray(obj.getAncestorIds())
  );

  mod.addGlobal(
    `__field_index_table_${obj.id}`,
    opts.fieldLookupHelpers.lookupTableType,
    false,
    opts.fieldLookupHelpers.initFieldIndexTable({ ...opts, expr: obj })
  );

  if (obj.implementations?.length) {
    obj.implementations.forEach((impl) =>
      impl.methods.forEach((fn) => compileFunction({ ...opts, expr: fn }))
    );
  }

  mod.addGlobal(
    `__method_table_${obj.id}`,
    opts.methodLookupHelpers.lookupTableType,
    false,
    opts.methodLookupHelpers.initMethodTable({ ...opts, expr: obj })
  );

  const finalType = obj.binaryenType;
  if (obj.isStructural) {
    obj.setAttribute("originalType", finalType);
    obj.binaryenType = mapBinaryenType(opts, voydBaseObject);
  }

  if (opts.useOriginalType) return finalType;
  return obj.binaryenType;
};

let i32ArrayType: TypeRef | undefined = undefined;
export const getI32ArrayType = (mod: binaryen.Module) => {
  if (i32ArrayType) return i32ArrayType;
  i32ArrayType = gc.defineArrayType(mod, binaryen.i32, true);
  return i32ArrayType;
};
