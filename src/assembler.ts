import binaryen from "binaryen";
import { Expr } from "./syntax-objects/expr.js";
import {
  Type,
  Primitive,
  ObjectType,
  FixedArrayType,
  voydBaseObject,
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
import { initExtensionHelpers } from "./assembler/rtt/extension.js";
import { initFieldLookupHelpers } from "./assembler/index.js";

import { compile as compileCall } from "./assembler/compile-call.js";
import { compile as compileBlock } from "./assembler/compile-block.js";
import { compile as compileMatch } from "./assembler/compile-match.js";
import { compile as compileInt } from "./assembler/compile-int.js";
import { compile as compileStringLiteral } from "./assembler/compile-string-literal.js";
import { compile as compileFloat } from "./assembler/compile-float.js";
import { compile as compileIdentifier } from "./assembler/compile-identifier.js";
import { compile as compileFunction } from "./assembler/compile-function.js";
import { compile as compileVariable } from "./assembler/compile-variable.js";
import { compile as compileDeclaration } from "./assembler/compile-declaration.js";
import { compile as compileModule } from "./assembler/compile-module.js";
import { compile as compileObjectLiteral } from "./assembler/compile-object-literal.js";
import { compile as compileType } from "./assembler/compile-type.js";
import { compile as compileBool } from "./assembler/compile-bool.js";
import { compile as compileImpl } from "./assembler/compile-impl.js";
import { compile as compileUse } from "./assembler/compile-use.js";
import { compile as compileTrait } from "./assembler/compile-trait.js";
import { compile as compileMacro } from "./assembler/compile-macro.js";
import { compile as compileMacroVariable } from "./assembler/compile-macro-variable.js";

const buildingTypePlaceholders = new Map<ObjectType, TypeRef>();

export const assemble = (ast: Expr) => {
  const mod = new binaryen.Module();
  mod.setFeatures(binaryen.Features.All);
  mod.setMemory(0, 1, null, []);
  const extensionHelpers = initExtensionHelpers(mod);
  const fieldLookupHelpers = initFieldLookupHelpers(mod);
  compileExpression({ expr: ast, mod, extensionHelpers, fieldLookupHelpers });
  mod.autoDrop();
  return mod;
};

export interface CompileExprOpts<T = Expr> {
  expr: T;
  mod: binaryen.Module;
  extensionHelpers: ReturnType<typeof initExtensionHelpers>;
  fieldLookupHelpers: ReturnType<typeof initFieldLookupHelpers>;
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
};

export const compileExpression = (opts: CompileExprOpts): number => {
  const compiler = compilers[opts.expr.syntaxType];
  if (compiler) {
    const isReturnExpr = opts.isReturnExpr;
    opts.isReturnExpr = false;
    return compiler({ ...opts, isReturnExpr } as any);
  }

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
  if (isPrimitiveId(type, "voyd")) return binaryen.none;
  if (isPrimitiveId(type, "string")) return getI32ArrayType(opts.mod);

  if (type.isObjectType()) {
    if (buildingTypePlaceholders.has(type)) {
      return buildingTypePlaceholders.get(type)!;
    }
    return buildObjectType(opts, type);
  }
  if (type.isTraitType()) return buildObjectType(opts, voydBaseObject);
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

