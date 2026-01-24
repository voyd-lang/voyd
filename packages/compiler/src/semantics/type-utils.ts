import type { TypeId, TypeParamId } from "./ids.js";

type TypeDescriptorLike =
  | { kind: "primitive"; name: string }
  | { kind: "recursive"; binder: TypeParamId; body: TypeId }
  | { kind: "type-param-ref"; param: TypeParamId }
  | { kind: "trait"; typeArgs: readonly TypeId[] }
  | { kind: "nominal-object"; typeArgs: readonly TypeId[] }
  | { kind: "structural-object"; fields: readonly { type: TypeId }[] }
  | {
      kind: "function";
      parameters: readonly { type: TypeId }[];
      returnType: TypeId;
    }
  | { kind: "union"; members: readonly TypeId[] }
  | { kind: "intersection"; nominal?: TypeId; structural?: TypeId }
  | { kind: "fixed-array"; element: TypeId };

export const typeContainsUnresolvedParam = ({
  typeId,
  getTypeDesc,
  boundParams = new Set<TypeParamId>(),
  seen = new Set<TypeId>(),
}: {
  typeId: TypeId;
  getTypeDesc: (typeId: TypeId) => TypeDescriptorLike;
  boundParams?: ReadonlySet<TypeParamId>;
  seen?: Set<TypeId>;
}): boolean => {
  if (seen.has(typeId)) {
    return false;
  }
  seen.add(typeId);
  const desc = getTypeDesc(typeId);
  switch (desc.kind) {
    case "type-param-ref":
      return !boundParams.has(desc.param);
    case "recursive": {
      const nextBound = new Set(boundParams);
      nextBound.add(desc.binder);
      return typeContainsUnresolvedParam({
        typeId: desc.body,
        getTypeDesc,
        boundParams: nextBound,
        seen,
      });
    }
    case "primitive":
      return desc.name === "unknown";
    case "trait":
    case "nominal-object":
      return desc.typeArgs.some((arg) =>
        typeContainsUnresolvedParam({ typeId: arg, getTypeDesc, boundParams, seen })
      );
    case "fixed-array":
      return typeContainsUnresolvedParam({
        typeId: desc.element,
        getTypeDesc,
        boundParams,
        seen,
      });
    case "structural-object":
      return desc.fields.some((field) =>
        typeContainsUnresolvedParam({
          typeId: field.type,
          getTypeDesc,
          boundParams,
          seen,
        })
      );
    case "function":
      return (
        desc.parameters.some((param) =>
          typeContainsUnresolvedParam({
            typeId: param.type,
            getTypeDesc,
            boundParams,
            seen,
          })
        ) ||
        typeContainsUnresolvedParam({
          typeId: desc.returnType,
          getTypeDesc,
          boundParams,
          seen,
        })
      );
    case "union":
      return desc.members.some((member) =>
        typeContainsUnresolvedParam({
          typeId: member,
          getTypeDesc,
          boundParams,
          seen,
        })
      );
    case "intersection":
      return (
        (typeof desc.nominal === "number" &&
          typeContainsUnresolvedParam({
            typeId: desc.nominal,
            getTypeDesc,
            boundParams,
            seen,
          })) ||
        (typeof desc.structural === "number" &&
          typeContainsUnresolvedParam({
            typeId: desc.structural,
            getTypeDesc,
            boundParams,
            seen,
          }))
      );
    default:
      return false;
  }
};
