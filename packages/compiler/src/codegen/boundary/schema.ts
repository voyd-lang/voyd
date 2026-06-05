import type { CodegenContext, StructuralFieldInfo, TypeId } from "../context.js";
import { getFixedArrayWasmTypes, getStructuralTypeInfo } from "../types.js";

export type BoundaryPrimitiveSchema =
  | { kind: "bool"; typeId: TypeId }
  | { kind: "i32"; typeId: TypeId }
  | { kind: "i64"; typeId: TypeId }
  | { kind: "f32"; typeId: TypeId }
  | { kind: "f64"; typeId: TypeId }
  | { kind: "void"; typeId: TypeId }
  | { kind: "string"; typeId: TypeId };

export type BoundaryArraySchema = {
  kind: "array";
  typeId: TypeId;
  elementTypeId: TypeId;
  element: BoundarySchema;
};

export type BoundaryFieldSchema = {
  name: string;
  typeId: TypeId;
  schema: BoundarySchema;
};

export type BoundaryRecordSchema = {
  kind: "record";
  typeId: TypeId;
  name: string;
  tag?: string;
  fields: readonly BoundaryFieldSchema[];
};

export type BoundaryVariantSchema = {
  name: string;
  typeId: TypeId;
  fields: readonly BoundaryFieldSchema[];
};

export type BoundaryUnionSchema = {
  kind: "union";
  typeId: TypeId;
  name: string;
  variants: readonly BoundaryVariantSchema[];
};

export type BoundarySchema =
  | BoundaryPrimitiveSchema
  | BoundaryArraySchema
  | BoundaryRecordSchema
  | BoundaryUnionSchema;

export class BoundarySchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BoundarySchemaError";
  }
}

export type BoundarySchemaOptions = {
  tagStandaloneVariants?: boolean;
};

export const deriveBoundarySchema = ({
  typeId,
  ctx,
  label = "value",
  options = {},
}: {
  typeId: TypeId;
  ctx: CodegenContext;
  label?: string;
  options?: BoundarySchemaOptions;
}): BoundarySchema =>
  deriveBoundarySchemaInternal({
    typeId,
    ctx,
    path: label,
    active: new Set<TypeId>(),
    options,
  });

export const isBoundaryCompatibleType = ({
  typeId,
  ctx,
}: {
  typeId: TypeId;
  ctx: CodegenContext;
}): boolean => {
  try {
    deriveBoundarySchema({ typeId, ctx });
    return true;
  } catch (error) {
    if (error instanceof BoundarySchemaError) {
      return false;
    }
    throw error;
  }
};

export const formatBoundaryType = ({
  typeId,
  ctx,
  active = new Set<TypeId>(),
}: {
  typeId: TypeId;
  ctx: CodegenContext;
  active?: Set<TypeId>;
}): string => {
  if (active.has(typeId)) {
    return "<recursive>";
  }
  active.add(typeId);
  try {
    const desc = ctx.program.types.getTypeDesc(typeId);
    switch (desc.kind) {
      case "primitive":
        return desc.name;
      case "recursive":
        return `recursive<${formatBoundaryType({ typeId: desc.body, ctx, active })}>`;
      case "type-param-ref":
        return `typeparam#${desc.param}`;
      case "nominal-object":
      case "value-object":
      case "trait":
        return formatNamedType({
          name:
            desc.name ??
            ctx.program.symbols.getName(desc.owner) ??
            `symbol#${desc.owner}`,
          typeArgs: desc.typeArgs,
          ctx,
          active,
        });
      case "structural-object":
        return `{ ${desc.fields
          .map(
            (field) =>
              `${field.name}${field.optional ? "?" : ""}: ${formatBoundaryType({
                typeId: field.type,
                ctx,
                active,
              })}`,
          )
          .join(", ")} }`;
      case "function":
        return `fn(${desc.parameters
          .map((param) => formatBoundaryType({ typeId: param.type, ctx, active }))
          .join(", ")}) -> ${formatBoundaryType({
          typeId: desc.returnType,
          ctx,
          active,
        })}`;
      case "union":
        return desc.members
          .map((member) => formatBoundaryType({ typeId: member, ctx, active }))
          .join(" | ");
      case "intersection": {
        const parts = [
          desc.nominal,
          desc.structural,
          ...(desc.traits ?? []),
        ]
          .filter((part): part is TypeId => typeof part === "number")
          .map((part) => formatBoundaryType({ typeId: part, ctx, active }));
        return parts.length > 0 ? parts.join(" & ") : "intersection";
      }
      case "fixed-array":
        return `FixedArray<${formatBoundaryType({
          typeId: desc.element,
          ctx,
          active,
        })}>`;
    }
    return `type#${typeId}`;
  } finally {
    active.delete(typeId);
  }
};

const DTO_SUMMARY =
  "boundary-compatible DTO values are bool, i32, i64, f32, f64, String, Array<T>, records/objects with boundary-compatible non-private fields, and named enum/union variants with boundary-compatible fields";

const deriveBoundarySchemaInternal = ({
  typeId,
  ctx,
  path,
  active,
  options,
}: {
  typeId: TypeId;
  ctx: CodegenContext;
  path: string;
  active: Set<TypeId>;
  options: BoundarySchemaOptions;
}): BoundarySchema => {
  if (active.has(typeId)) {
    unsupported({ typeId, ctx, path, reason: "recursive object graphs are not supported" });
  }

  const primitive = primitiveSchema({ typeId, ctx });
  if (primitive) {
    return primitive;
  }
  if (isStringType({ typeId, ctx })) {
    return { kind: "string", typeId };
  }

  active.add(typeId);
  try {
    const array = arrayInfo({ typeId, ctx });
    if (array) {
      assertSupportedArrayStorage({
        typeId: array.arrayTypeId,
        ctx,
        path,
      });
      return {
        kind: "array",
        typeId: array.arrayTypeId,
        elementTypeId: array.elementTypeId,
        element: deriveBoundarySchemaInternal({
          typeId: array.elementTypeId,
          ctx,
          path: `${path}[]`,
          active,
          options,
        }),
      };
    }

    const desc = ctx.program.types.getTypeDesc(typeId);
    if (desc.kind === "recursive") {
      const unfolded = ctx.program.types.substitute(
        desc.body,
        new Map([[desc.binder, typeId]]),
      );
      return deriveBoundarySchemaInternal({
        typeId: unfolded,
        ctx,
        path,
        active,
        options,
      });
    }
    if (desc.kind === "union") {
      return deriveUnionSchema({ typeId, ctx, path, active });
    }
    if (desc.kind === "intersection") {
      if (typeof desc.nominal === "number") {
        return deriveBoundarySchemaInternal({
          typeId: desc.nominal,
          ctx,
          path,
          active,
          options,
        });
      }
      if (typeof desc.structural === "number") {
        return deriveRecordSchema({ typeId, ctx, path, active, options });
      }
    }
    if (
      desc.kind === "nominal-object" ||
      desc.kind === "value-object" ||
      desc.kind === "structural-object"
    ) {
      return deriveRecordSchema({ typeId, ctx, path, active, options });
    }

    unsupported({
      typeId,
      ctx,
      path,
      reason: `${formatBoundaryType({ typeId, ctx })} is not a supported DTO shape`,
    });
  } finally {
    active.delete(typeId);
  }
  return unsupported({
    typeId,
    ctx,
    path,
    reason: `${formatBoundaryType({ typeId, ctx })} is not a supported DTO shape`,
  });
};

const assertSupportedArrayStorage = ({
  typeId,
  ctx,
  path,
}: {
  typeId: TypeId;
  ctx: CodegenContext;
  path: string;
}): void => {
  const info = getStructuralTypeInfo(typeId, ctx);
  const storage = info?.fieldMap.get("storage");
  if (!storage) {
    unsupported({
      typeId,
      ctx,
      path,
      reason: "array storage layout is not available at the boundary",
    });
    return;
  }
  const storageTypes = getFixedArrayWasmTypes(storage.typeId, ctx);
  if (storageTypes.kind === "plain-array") return;
  if (storageTypes.kind === "inline-aggregate") return;
};

const deriveRecordSchema = ({
  typeId,
  ctx,
  path,
  active,
  options,
}: {
  typeId: TypeId;
  ctx: CodegenContext;
  path: string;
  active: Set<TypeId>;
  options: BoundarySchemaOptions;
}): BoundaryRecordSchema => {
  const info = getStructuralTypeInfo(typeId, ctx);
  if (!info) {
    return unsupported({
      typeId,
      ctx,
      path,
      reason: "record/object layout is not available at the boundary",
    });
  }
  const fields = deriveBoundaryFields({
    ownerTypeId: typeId,
    fields: info.fields,
    ctx,
    path,
    active,
    options,
  });
  return {
    kind: "record",
    typeId,
    name: formatBoundaryType({ typeId, ctx }),
    tag: options.tagStandaloneVariants
      ? ctx.program.types.getStandaloneVariantTag(typeId)
      : undefined,
    fields,
  };
};

const deriveBoundaryFields = ({
  ownerTypeId,
  fields,
  ctx,
  path,
  active,
  options,
}: {
  ownerTypeId: TypeId;
  fields: readonly StructuralFieldInfo[];
  ctx: CodegenContext;
  path: string;
  active: Set<TypeId>;
  options: BoundarySchemaOptions;
}): BoundaryFieldSchema[] =>
  fields.map((field) => {
    if (field.optional) {
      unsupported({
        typeId: field.typeId,
        ctx,
        path: `${path}.${field.name}`,
        reason: "optional object fields are not supported at the boundary yet",
      });
    }
    const sourceField = recordFieldFor({
      ownerTypeId,
      fieldName: field.name,
      ctx,
    });
    if (sourceField?.visibility?.level === "object") {
      unsupported({
        typeId: field.typeId,
        ctx,
        path: `${path}.${field.name}`,
        reason: "private fields are not included in boundary DTOs",
      });
    }
    return {
      name: field.name,
      typeId: field.typeId,
      schema: deriveBoundarySchemaInternal({
        typeId: field.typeId,
        ctx,
        path: `${path}.${field.name}`,
        active,
        options,
      }),
    };
  });

const deriveUnionSchema = ({
  typeId,
  ctx,
  path,
  active,
}: {
  typeId: TypeId;
  ctx: CodegenContext;
  path: string;
  active: Set<TypeId>;
}): BoundaryUnionSchema => {
  const desc = ctx.program.types.getTypeDesc(typeId);
  if (desc.kind !== "union") {
    throw new Error("expected union schema target");
  }
  const variants = desc.members.map((member) => {
    const memberDesc = ctx.program.types.getTypeDesc(member);
    if (
      memberDesc.kind !== "nominal-object" &&
      memberDesc.kind !== "value-object" &&
      memberDesc.kind !== "intersection"
    ) {
      unsupported({
        typeId: member,
        ctx,
        path,
        reason: "boundary unions must use named object/value variants",
      });
    }
    const info = getStructuralTypeInfo(member, ctx);
    if (!info) {
      return unsupported({
        typeId: member,
        ctx,
        path,
        reason: "union variant layout is not available at the boundary",
      });
    }
    return {
      name: variantName({ typeId: member, ctx }),
      typeId: member,
      fields: deriveBoundaryFields({
        ownerTypeId: member,
        fields: info.fields,
        ctx,
        path: `${path}.${variantName({ typeId: member, ctx })}`,
        active,
        options: { tagStandaloneVariants: false },
      }),
    };
  });
  return {
    kind: "union",
    typeId,
    name: formatBoundaryType({ typeId, ctx }),
    variants,
  };
};

const primitiveSchema = ({
  typeId,
  ctx,
}: {
  typeId: TypeId;
  ctx: CodegenContext;
}): BoundaryPrimitiveSchema | undefined => {
  if (typeId === ctx.program.primitives.bool) return { kind: "bool", typeId };
  if (typeId === ctx.program.primitives.i32) return { kind: "i32", typeId };
  if (typeId === ctx.program.primitives.i64) return { kind: "i64", typeId };
  if (typeId === ctx.program.primitives.f32) return { kind: "f32", typeId };
  if (typeId === ctx.program.primitives.f64) return { kind: "f64", typeId };
  if (typeId === ctx.program.primitives.void) return { kind: "void", typeId };
  return undefined;
};

const arrayInfo = ({
  typeId,
  ctx,
}: {
  typeId: TypeId;
  ctx: CodegenContext;
}): { arrayTypeId: TypeId; elementTypeId: TypeId } | undefined => {
  const desc = ctx.program.types.getTypeDesc(typeId);
  if (
    (desc.kind === "nominal-object" || desc.kind === "value-object") &&
    desc.name === "Array" &&
    desc.typeArgs.length === 1
  ) {
    return { arrayTypeId: typeId, elementTypeId: desc.typeArgs[0]! };
  }
  if (desc.kind === "intersection" && typeof desc.nominal === "number") {
    return arrayInfo({ typeId: desc.nominal, ctx });
  }
  return undefined;
};

const isStringType = ({
  typeId,
  ctx,
}: {
  typeId: TypeId;
  ctx: CodegenContext;
}): boolean => {
  const desc = ctx.program.types.getTypeDesc(typeId);
  if (
    (desc.kind === "nominal-object" || desc.kind === "value-object") &&
    desc.name === "String"
  ) {
    return true;
  }
  return (
    desc.kind === "intersection" &&
    typeof desc.nominal === "number" &&
    isStringType({ typeId: desc.nominal, ctx })
  );
};

const recordFieldFor = ({
  ownerTypeId,
  fieldName,
  ctx,
}: {
  ownerTypeId: TypeId;
  fieldName: string;
  ctx: CodegenContext;
}) => {
  const desc = ctx.program.types.getTypeDesc(ownerTypeId);
  if (desc.kind === "structural-object") {
    return desc.fields.find((field) => field.name === fieldName);
  }
  const nominal =
    desc.kind === "nominal-object" || desc.kind === "value-object"
      ? ownerTypeId
      : desc.kind === "intersection"
        ? desc.nominal
        : undefined;
  const owner =
    typeof nominal === "number"
      ? ctx.program.objects.getNominalOwnerRef(nominal)
      : undefined;
  const template =
    typeof owner === "number"
      ? ctx.program.objects.getTemplate(owner)
      : undefined;
  return template?.fields.find((field) => field.name === fieldName);
};

const variantName = ({
  typeId,
  ctx,
}: {
  typeId: TypeId;
  ctx: CodegenContext;
}): string => {
  const desc = ctx.program.types.getTypeDesc(typeId);
  if (
    (desc.kind === "nominal-object" || desc.kind === "value-object") &&
    desc.name
  ) {
    return desc.name;
  }
  if (desc.kind === "intersection" && typeof desc.nominal === "number") {
    return variantName({ typeId: desc.nominal, ctx });
  }
  return formatBoundaryType({ typeId, ctx });
};

const formatNamedType = ({
  name,
  typeArgs,
  ctx,
  active,
}: {
  name: string;
  typeArgs: readonly TypeId[];
  ctx: CodegenContext;
  active: Set<TypeId>;
}): string =>
  typeArgs.length === 0
    ? name
    : `${name}<${typeArgs
        .map((arg) => formatBoundaryType({ typeId: arg, ctx, active }))
        .join(", ")}>`;

const unsupported = ({
  typeId,
  ctx,
  path,
  reason,
}: {
  typeId: TypeId;
  ctx: CodegenContext;
  path: string;
  reason: string;
}): never => {
  throw new BoundarySchemaError(
    `boundary DTO incompatibility at ${path}: ${reason}. Unsupported type: ${formatBoundaryType({
      typeId,
      ctx,
    })}. ${DTO_SUMMARY}.`,
  );
};
