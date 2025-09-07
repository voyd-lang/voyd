import binaryen from "binaryen";
import { AugmentedBinaryen, TypeRef } from "../../lib/binaryen-gc/types.js";
import { CompileExprOpts, mapBinaryenType } from "../../codegen.js";
import { FnType, Type, voydBaseObject } from "../../syntax-objects/types.js";
import { canonicalType } from "../../semantics/types/canonicalize.js";

const bin = binaryen as unknown as AugmentedBinaryen;

export type NormalizedClosureFn = {
  paramBinTypes: TypeRef[];
  returnBinType: TypeRef;
  cacheKey: string;
};

const isObjectish = (t?: Type): boolean => {
  if (!t) return false;
  const c = canonicalType(t);
  if (c.isObjectType?.()) return true;
  if (c.isUnionType?.()) return true;
  if (c.isIntersectionType?.()) return true;
  // Treat unresolved aliases conservatively as object-ish for typed identity
  // alignment. This avoids heap type drift when generics are in play.
  if (c.isTypeAlias?.()) return true;
  return false;
};

export const normalizeClosureFnType = (
  opts: CompileExprOpts,
  fnType: FnType
): NormalizedClosureFn => {
  // Canonicalize to ensure param/return children are materialized
  const canon = canonicalType(fnType) as FnType;
  const paramBinTypes: TypeRef[] = [
    mapBinaryenType(opts, voydBaseObject), // placeholder; real supertype is injected by caller
    ...canon.parameters.map((p) => mapBinaryenType(opts, p.type!)),
  ];
  const returnBinType = isObjectish(canon.returnType)
    ? mapBinaryenType(opts, voydBaseObject)
    : mapBinaryenType(opts, canon.returnType!);
  // Note: caller should replace the leading param with the actual Closure supertype
  const cacheKey = `${paramBinTypes.join(",")}->${returnBinType}`;
  return { paramBinTypes, returnBinType, cacheKey };
};
