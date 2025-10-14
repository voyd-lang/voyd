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
  FnType,
  TupleType,
  TypeAlias,
} from "./syntax-objects/types.js";
import { TraitType } from "./syntax-objects/types/trait.js";
import { List } from "./syntax-objects/list.js";
import { Parameter } from "./syntax-objects/parameter.js";
import { Variable } from "./syntax-objects/variable.js";
import { Implementation } from "./syntax-objects/implementation.js";
import {
  ObjectLiteral,
  ObjectLiteralField,
} from "./syntax-objects/object-literal.js";
import { MatchCase } from "./syntax-objects/match.js";
import { Fn } from "./syntax-objects/fn.js";
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
  resetClosureTypeCaches,
} from "./codegen/compile-closure.js";

let currentCodegenRun = 0;
const BINARYEN_MODULE_ATTR = "binaryen:moduleId";

const recordModuleId = (
  subject: { setAttribute?: (key: string, value: unknown) => void },
  moduleId: number
): void => {
  subject.setAttribute?.(BINARYEN_MODULE_ATTR, moduleId);
};

const readModuleId = (
  subject: { getAttribute?: (key: string) => unknown }
): number | undefined => {
  const value = subject.getAttribute?.(BINARYEN_MODULE_ATTR);
  return typeof value === "number" ? value : undefined;
};

export const cacheFnBinaryenType = (fn: Fn, typeRef: number): void => {
  fn.setAttribute?.("binaryenType", typeRef);
  fn.setAttribute?.("binaryenTypeModule", currentCodegenRun);
};

export const getCachedFnBinaryenType = (fn: Fn): number | undefined => {
  const moduleId = fn.getAttribute?.("binaryenTypeModule");
  if (moduleId === currentCodegenRun) {
    return fn.getAttribute?.("binaryenType") as number | undefined;
  }
  return undefined;
};

const prepareForCodegen = (ast: Expr): void => {
  currentCodegenRun += 1;
  buildingTypePlaceholders.clear();
  fixedArrayTypeCache.clear();
  i32ArrayType = undefined;
  resetClosureTypeCaches();
  clearBinaryenTypeAttributes(voydBaseObject);
  voydBaseObject.binaryenType = undefined;
  if (Array.isArray(voydBaseObject.fields)) {
    voydBaseObject.fields.forEach((field) => {
      field.binaryenGetterType = undefined;
      field.binaryenSetterType = undefined;
    });
  }
  clearBinaryenArtifacts(ast);
};

const clearBinaryenTypeAttributes = (type: Type): void => {
  type.setAttribute?.("binaryenType", undefined);
  type.setAttribute?.("originalType", undefined);
};

const clearFieldBinaryenMetadata = (field: ObjectLiteralField | ObjectType["fields"][number]): void => {
  if (!field) return;
  (field as any).binaryenGetterType = undefined;
  (field as any).binaryenSetterType = undefined;
};

const clearBinaryenArtifacts = (root: Expr): void => {
  const visitedExpr = new Set<Expr>();
  const visitedTypes = new Set<Type>();
  const visitedParameters = new Set<Parameter>();
  const visitedVariables = new Set<Variable>();
  const visitedImplementations = new Set<Implementation>();

  const visitList = (list?: List<Expr>): void => {
    if (!list) return;
    list.each((item) => visitExpr(item));
  };

  const visitMatchCase = (caseItem: MatchCase): void => {
    clearType(caseItem.matchType as Type | undefined);
    if (caseItem.matchTypeExpr) visitExpr(caseItem.matchTypeExpr);
    visitExpr(caseItem.expr);
  };

  const visitImplementation = (impl: Implementation): void => {
    if (visitedImplementations.has(impl)) return;
    visitedImplementations.add(impl);
    clearType(impl.targetType);
    clearType(impl.trait as Type | undefined);
    visitExpr(impl.targetTypeExpr.value);
    visitExpr(impl.body.value);
    visitExpr(impl.traitExpr.value);
    impl.typeParams.toArray().forEach((param) => visitExpr(param));
    impl.exports.forEach((fn) => visitExpr(fn));
    impl.methods.forEach((fn) => visitExpr(fn));
  };

  const visitObjectLiteral = (literal: ObjectLiteral): void => {
    clearType(literal.type as Type | undefined);
    literal.fields.forEach((field) => {
      clearFieldBinaryenMetadata(field);
      clearType(field.type as Type | undefined);
      visitExpr(field.initializer);
    });
  };

  const visitVariable = (variable: Variable): void => {
    if (visitedVariables.has(variable)) return;
    visitedVariables.add(variable);
    clearType(variable.type);
    clearType(variable.originalType);
    clearType(variable.annotatedType);
    clearType(variable.inferredType);
    if (variable.typeExpr) visitExpr(variable.typeExpr);
    visitExpr(variable.initializer);
  };

  const visitParameter = (parameter: Parameter): void => {
    if (visitedParameters.has(parameter)) return;
    visitedParameters.add(parameter);
    clearType(parameter.type);
    clearType(parameter.originalType);
    if (parameter.typeExpr) visitExpr(parameter.typeExpr);
  };

  const clearObjectType = (obj: ObjectType): void => {
    clearBinaryenTypeAttributes(obj);
    obj.binaryenType = undefined;
    obj.appliedTypeArgs?.forEach((arg) => clearType(arg));
    obj.fields.forEach((field) => {
      clearFieldBinaryenMetadata(field);
      clearType(field.type as Type | undefined);
    });
    clearType(obj.parentObjType);
    if (obj.parentObjExpr) visitExpr(obj.parentObjExpr);
    obj.genericInstances?.forEach((inst) => clearType(inst));
    clearType(obj.genericParent);
    obj.typeParameters?.forEach((param) => visitExpr(param));
    obj.implementations?.forEach((impl) => visitExpr(impl));
  };

  const clearTraitType = (trait: TraitType): void => {
    clearBinaryenTypeAttributes(trait);
    trait.appliedTypeArgs?.forEach((arg) => clearType(arg));
    trait.genericInstances?.forEach((inst) => clearType(inst));
    clearType(trait.genericParent);
    trait.methods.toArray().forEach((method) => visitExpr(method));
    trait.implementations?.forEach((impl) => visitExpr(impl));
    trait.typeParameters?.forEach((param) => visitExpr(param));
  };

  const clearType = (type?: Type): void => {
    if (!type || visitedTypes.has(type)) return;
    visitedTypes.add(type);
    clearBinaryenTypeAttributes(type);

    if ((type as TypeAlias).isTypeAlias?.()) {
      const alias = type as TypeAlias;
      if (alias.typeExpr) visitExpr(alias.typeExpr);
      clearType(alias.type);
      return;
    }

    if ((type as UnionType).isUnionType?.()) {
      const union = type as UnionType;
      union.types.forEach((child) => clearType(child));
      return;
    }

    if ((type as IntersectionType).isIntersectionType?.()) {
      const inter = type as IntersectionType;
      clearType(inter.nominalType);
      clearType(inter.structuralType);
      if (inter.nominalTypeExpr) visitExpr(inter.nominalTypeExpr.value);
      if (inter.structuralTypeExpr) visitExpr(inter.structuralTypeExpr.value);
      return;
    }

    if ((type as TupleType).isTupleType?.()) {
      const tuple = type as TupleType;
      tuple.value.forEach((entry) => clearType(entry));
      return;
    }

    if ((type as FixedArrayType).isFixedArrayType?.()) {
      const arr = type as FixedArrayType;
      arr.binaryenType = undefined;
      clearType(arr.elemType);
      visitExpr(arr.elemTypeExpr);
      return;
    }

    if ((type as FnType).isFnType?.()) {
      const fnType = type as FnType;
      clearType(fnType.returnType);
      fnType.parameters.forEach((param) => visitParameter(param));
      if (fnType.returnTypeExpr) visitExpr(fnType.returnTypeExpr);
      return;
    }

    if ((type as ObjectType).isObjectType?.()) {
      clearObjectType(type as ObjectType);
      return;
    }

    if ((type as TraitType).isTraitType?.()) {
      clearTraitType(type as TraitType);
    }
  };

  const visitExpr = (expr?: Expr): void => {
    if (!expr || visitedExpr.has(expr)) return;
    visitedExpr.add(expr);

    if (expr.isModule()) {
      expr.each((child) => visitExpr(child));
      return;
    }

    if (expr.isFn()) {
      expr.setAttribute?.("binaryenType", undefined);
      clearType(expr.returnType);
      clearType(expr.inferredReturnType);
      clearType(expr.annotatedReturnType);
      expr.appliedTypeArgs?.forEach((arg) => clearType(arg));
      expr.parameters.forEach((param) => visitParameter(param));
      expr.variables.forEach((variable) => visitVariable(variable));
      expr.typeParameters?.forEach((param) => visitExpr(param));
      expr.genericInstances?.forEach((inst) => visitExpr(inst));
      visitExpr(expr.body ?? undefined);
      if (expr.returnTypeExpr) visitExpr(expr.returnTypeExpr);
      return;
    }

    if (expr.isClosure()) {
      clearType(expr.returnType);
      clearType(expr.inferredReturnType);
      clearType(expr.annotatedReturnType);
      expr.parameters.forEach((param) => visitParameter(param));
      expr.variables.forEach((variable) => visitVariable(variable));
      expr.captures.forEach((capture) => visitExpr(capture));
      if (expr.returnTypeExpr) visitExpr(expr.returnTypeExpr);
      visitExpr(expr.body);
      return;
    }

    if (expr.isVariable()) {
      visitVariable(expr);
      return;
    }

    if (expr.isParameter()) {
      visitParameter(expr);
      return;
    }

    if (expr.isBlock()) {
      clearType(expr.type);
      expr.body.forEach((child) => visitExpr(child));
      return;
    }

    if (expr.isCall()) {
      clearType(expr.type);
      visitExpr(expr.fnName);
      visitList(expr.args);
      visitList(expr.typeArgs ?? undefined);
      const fn = expr.fn;
      if (fn) {
        if (fn.isFn?.()) visitExpr(fn as unknown as Expr);
        if ((fn as ObjectType).isObjectType?.()) clearType(fn as ObjectType);
      }
      return;
    }

    if (expr.isObjectLiteral()) {
      visitObjectLiteral(expr);
      return;
    }

    if (expr.isArrayLiteral()) {
      expr.elements.forEach((element) => visitExpr(element));
      return;
    }

    if (expr.isMatch()) {
      clearType(expr.type);
      clearType(expr.baseType);
      visitExpr(expr.operand);
      if (expr.bindVariable) visitVariable(expr.bindVariable);
      visitExpr(expr.bindIdentifier);
      expr.cases.forEach((caseItem) => visitMatchCase(caseItem));
      if (expr.defaultCase) visitMatchCase(expr.defaultCase);
      return;
    }

    if (expr.isImpl()) {
      visitImplementation(expr);
      return;
    }

    if (expr.isDeclaration()) {
      expr.fns.forEach((fn) => visitExpr(fn));
      return;
    }

    if (expr.isGlobal()) {
      clearType(expr.type);
      visitExpr(expr.initializer);
      return;
    }

    if (expr.isTrait()) {
      clearType(expr);
      return;
    }

    if (expr.isType()) {
      clearType(expr);
      return;
    }

    if (expr.isIdentifier()) {
      clearType(expr.type);
      return;
    }

    if (expr.isList()) {
      visitList(expr);
    }
  };

  visitExpr(root);
};

export const codegen = (ast: Expr) => {
  prepareForCodegen(ast);
  const mod = new binaryen.Module();
  mod.setFeatures(binaryen.Features.All);
  mod.setMemory(0, 1, "main_memory", []);
  const extensionHelpers = initExtensionHelpers(mod);
  const fieldLookupHelpers = initFieldLookupHelpers(mod);
  const methodLookupHelpers = initMethodLookupHelpers(mod);
  const addedGlobals = new Set<string>();
  compileExpression({
    expr: ast,
    mod,
    extensionHelpers,
    fieldLookupHelpers,
    methodLookupHelpers,
    addedGlobals,
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
  addedGlobals: Set<string>;
  isReturnExpr?: boolean;
  loopBreakId?: string;
}

type CompilerFn = (opts: CompileExprOpts<any>) => number;

export const compilers: Record<string, CompilerFn> = {
  call: compileCall,
  block: compileBlock,
  match: compileMatch,
  int: compileInt,
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

type MapBinTypeOpts = CompileExprOpts;

// Structural object types may be cloned and therefore have different object
// identities even if they represent the same logical type. Cache entries are
// keyed by the object's id to ensure stable lookups.
const buildingTypePlaceholders = new Map<string | ObjectType, TypeRef>();
const getPlaceholderKey = (obj: ObjectType) =>
  obj.isStructural ? obj.id : obj;

export const mapBinaryenType = (
  opts: MapBinTypeOpts,
  type: Type
): binaryen.Type => {
  if (type.isObjectType()) {
    type = ensureCanonicalObjectInstance(type);
    if (
      type.binaryenType !== undefined &&
      readModuleId(type) === currentCodegenRun
    ) {
      return type.binaryenType;
    }
  }
  if (type.isTraitType()) {
    type = ensureCanonicalTraitInstance(type);
  }
  if (isPrimitiveId(type, "bool")) return binaryen.i32;
  if (isPrimitiveId(type, "i32")) return binaryen.i32;
  if (isPrimitiveId(type, "f32")) return binaryen.f32;
  if (isPrimitiveId(type, "i64")) return binaryen.i64;
  if (isPrimitiveId(type, "f64")) return binaryen.f64;
  if (isPrimitiveId(type, "voyd") || isPrimitiveId(type, "void"))
    return binaryen.none;

  if (type.isObjectType()) {
    if (readModuleId(type) !== currentCodegenRun) {
      type.binaryenType = undefined;
      recordModuleId(type, currentCodegenRun);
    }
    const key = getPlaceholderKey(type);
    if (buildingTypePlaceholders.has(key)) {
      return buildingTypePlaceholders.get(key)!;
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

const ensureCanonicalObjectInstance = (obj: ObjectType): ObjectType => {
  const parent = obj.genericParent;
  if (!parent) return obj;

  const orphanSnapshot = obj.getAttribute?.("canon:orphanSnapshot") as
    | {
        canonical?: { id?: string };
      }
    | undefined;
  if (orphanSnapshot?.canonical?.id && parent.genericInstances?.length) {
    const canonicalMatch = parent.genericInstances.find(
      (candidate) => candidate.id === orphanSnapshot.canonical?.id
    );
    if (canonicalMatch) return canonicalMatch;
  }

  const canonical = parent.registerGenericInstance(obj);
  return canonical ?? obj;
};

const ensureCanonicalTraitInstance = (trait: TraitType): TraitType => {
  const parent = trait.genericParent;
  if (!parent) return trait;
  const canonical = parent.registerGenericInstance(trait);
  return canonical ?? trait;
};

const isPrimitiveId = (type: Type, id: Primitive) =>
  type.isPrimitiveType() && type.name.value === id;

const fixedArrayTypeCache = new Map<string, TypeRef>();
const buildFixedArrayType = (opts: CompileExprOpts, type: FixedArrayType) => {
  if (
    type.binaryenType !== undefined &&
    readModuleId(type) === currentCodegenRun
  ) {
    return type.binaryenType;
  }
  type.binaryenType = undefined;
  const cached = fixedArrayTypeCache.get(type.id);
  if (cached) {
    type.binaryenType = cached;
    recordModuleId(type, currentCodegenRun);
    return cached;
  }
  const mod = opts.mod;
  const elemType = mapBinaryenType(opts, type.elemType!);
  const arrType = gc.defineArrayType(mod, elemType, true, type.id);
  fixedArrayTypeCache.set(type.id, arrType);
  type.binaryenType = arrType;
  recordModuleId(type, currentCodegenRun);
  return arrType;
};

export const buildUnionType = (
  opts: MapBinTypeOpts,
  union: UnionType
): TypeRef => {
  if (
    union.hasAttribute("binaryenType") &&
    union.getAttribute("binaryenTypeModule") === currentCodegenRun
  ) {
    return union.getAttribute("binaryenType") as TypeRef;
  }

  const typeRef = mapBinaryenType(opts, voydBaseObject);
  union.setAttribute("binaryenType", typeRef);
  union.setAttribute("binaryenTypeModule", currentCodegenRun);
  return typeRef;
};

export const buildIntersectionType = (
  opts: MapBinTypeOpts,
  inter: IntersectionType
): TypeRef => {
  if (
    inter.hasAttribute("binaryenType") &&
    inter.getAttribute("binaryenTypeModule") === currentCodegenRun
  ) {
    return inter.getAttribute("binaryenType") as TypeRef;
  }

  const typeRef = mapBinaryenType(opts, inter.nominalType!);
  mapBinaryenType(opts, inter.structuralType!);
  inter.setAttribute("binaryenType", typeRef);
  inter.setAttribute("binaryenTypeModule", currentCodegenRun);
  return typeRef;
};

export const buildObjectType = (
  opts: MapBinTypeOpts,
  obj: ObjectType
): TypeRef => {
  if (obj.binaryenType) return obj.binaryenType;
  if (obj.typeParameters) return opts.mod.nop();
  const mod = opts.mod;

  const builder = new TypeBuilder(1);
  try {
    const tempRef = builder.getTempRefType(0, true);
    const key = getPlaceholderKey(obj);
    buildingTypePlaceholders.set(key, tempRef);

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
    recordModuleId(obj, currentCodegenRun);
  } finally {
    const key = getPlaceholderKey(obj);
    buildingTypePlaceholders.delete(key);
    builder.dispose();
  }

  const ancestorsGlobal = `__ancestors_table_${obj.id}`;
  if (!opts.addedGlobals.has(ancestorsGlobal)) {
    mod.addGlobal(
      ancestorsGlobal,
      opts.extensionHelpers.i32Array,
      false,
      opts.extensionHelpers.initExtensionArray(obj.getAncestorIds())
    );
    opts.addedGlobals.add(ancestorsGlobal);
  }

  const fieldIndexGlobal = `__field_index_table_${obj.id}`;
  if (!opts.addedGlobals.has(fieldIndexGlobal)) {
    mod.addGlobal(
      fieldIndexGlobal,
      opts.fieldLookupHelpers.lookupTableType,
      false,
      opts.fieldLookupHelpers.initFieldIndexTable({ ...opts, expr: obj })
    );
    opts.addedGlobals.add(fieldIndexGlobal);
  }

  if (obj.implementations?.length) {
    obj.implementations.forEach((impl) =>
      impl.methods.forEach((fn) => compileFunction({ ...opts, expr: fn }))
    );
  }

  const methodTableGlobal = `__method_table_${obj.id}`;
  if (!opts.addedGlobals.has(methodTableGlobal)) {
    mod.addGlobal(
      methodTableGlobal,
      opts.methodLookupHelpers.lookupTableType,
      false,
      opts.methodLookupHelpers.initMethodTable({ ...opts, expr: obj })
    );
    opts.addedGlobals.add(methodTableGlobal);
  }

  const finalType = obj.binaryenType;
  if (obj.isStructural) {
    obj.setAttribute("originalType", finalType);
    obj.binaryenType = mapBinaryenType(opts, voydBaseObject);
  }

  return obj.binaryenType;
};

let i32ArrayType: TypeRef | undefined = undefined;
export const getI32ArrayType = (mod: binaryen.Module) => {
  if (i32ArrayType) return i32ArrayType;
  i32ArrayType = gc.defineArrayType(mod, binaryen.i32, true);
  return i32ArrayType;
};
