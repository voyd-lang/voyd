import binaryen from "binaryen";
import { arrayNewFixed } from "@voyd-lang/lib/binaryen-gc/index.js";
import type {
  CodegenContext,
  FunctionContext,
  StructuralFieldInfo,
  StructuralTypeInfo,
  TypeId,
} from "../context.js";
import {
  coerceValueToType,
  initStructuralValue,
  lowerFixedArrayElementValue,
  lowerValueForHeapField,
} from "../structural.js";
import { getFixedArrayWasmTypes, getStructuralTypeInfo } from "../types.js";
import { coerceExprToWasmType } from "../wasm-type-coercions.js";
import { emitStringLiteral } from "../expressions/primitives.js";
import {
  compileOptionalNoneValue,
  compileOptionalSomeValue,
} from "../optionals.js";
import {
  deriveBoundarySchema,
  formatBoundaryType,
  type BoundaryFieldSchema,
  type BoundarySchema,
  type BoundaryVariantSchema,
} from "./schema.js";

type RuntimeShapeModel = {
  shapeTypeId: TypeId;
  nodeTypeId: TypeId;
  definitionTypeId: TypeId;
  definitionArrayTypeId: TypeId;
};

type ShapeBuildState = {
  model: RuntimeShapeModel;
  referenced: Map<TypeId, ShapeReference>;
  usedReferenceKeys: Set<string>;
};

type ShapeReference = {
  key: string;
  name: string;
};

export const emitBoundaryShape = ({
  typeId,
  resultTypeId,
  ctx,
  fnCtx,
}: {
  typeId: TypeId;
  resultTypeId: TypeId;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): binaryen.ExpressionRef => {
  const schema = deriveBoundarySchema({
    typeId,
    ctx,
    label: `shape_of<${formatBoundaryType({ typeId, ctx })}>`,
    options: {
      includeDocumentation: true,
      portableNames: true,
      tagStandaloneVariants: true,
    },
  });
  const model = runtimeShapeModel(resultTypeId, ctx);
  const state: ShapeBuildState = {
    model,
    referenced: new Map(),
    usedReferenceKeys: new Set(),
  };
  const root = emitShapeNode({ schema, state, ctx, fnCtx });

  const emittedDefinitions = new Set<TypeId>();
  const definitions: {
    reference: ShapeReference;
    typeId: TypeId;
    value: binaryen.ExpressionRef;
  }[] = [];
  while (emittedDefinitions.size < state.referenced.size) {
    const pendingDefinitions = [...state.referenced.entries()]
      .filter(([referencedTypeId]) => !emittedDefinitions.has(referencedTypeId))
      .sort((left, right) => comparePortableText(left[1].key, right[1].key));

    pendingDefinitions.forEach(([referencedTypeId, reference]) => {
      emittedDefinitions.add(referencedTypeId);
      const definitionSchema = deriveBoundarySchema({
        typeId: referencedTypeId,
        ctx,
        label: `shape definition ${reference.name}`,
        options: {
          includeDocumentation: true,
          portableNames: true,
          tagStandaloneVariants: true,
        },
      });
      definitions.push({
        reference,
        typeId: referencedTypeId,
        value: emitObject({
          typeId: model.definitionTypeId,
          fields: new Map([
            ["key", emitStringLiteral(reference.key, ctx)],
            ["name", emitStringLiteral(reference.name, ctx)],
            [
              "shape",
              emitShapeNode({ schema: definitionSchema, state, ctx, fnCtx }),
            ],
            [
              "documentation",
              emitOptionalString({
                value: schemaDocumentation(definitionSchema),
                optionalTypeId: requiredStructuralField(
                  model.definitionTypeId,
                  "documentation",
                  ctx,
                ).typeId,
                ctx,
                fnCtx,
              }),
            ],
          ]),
          ctx,
          fnCtx,
        }),
      });
    });
  }

  definitions.sort((left, right) => {
    const byKey = comparePortableText(
      left.reference.key,
      right.reference.key,
    );
    return byKey === 0 ? left.typeId - right.typeId : byKey;
  });

  const definitionArray = emitArray({
    arrayTypeId: model.definitionArrayTypeId,
    elements: definitions.map(({ value }) => value),
    ctx,
    fnCtx,
  });
  return emitObject({
    typeId: model.shapeTypeId,
    fields: new Map([
      ["root", root],
      ["definitions", definitionArray],
    ]),
    ctx,
    fnCtx,
  });
};

const comparePortableText = (left: string, right: string): number =>
  left === right ? 0 : left < right ? -1 : 1;

const emitShapeNode = ({
  schema,
  state,
  ctx,
  fnCtx,
}: {
  schema: BoundarySchema;
  state: ShapeBuildState;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): binaryen.ExpressionRef => {
  switch (schema.kind) {
    case "bool":
      return emitShapeVariant({ name: "BoolShape", state, ctx, fnCtx });
    case "i32":
      return emitShapeVariant({ name: "I32Shape", state, ctx, fnCtx });
    case "i64":
      return emitShapeVariant({ name: "I64Shape", state, ctx, fnCtx });
    case "f32":
      return emitShapeVariant({ name: "F32Shape", state, ctx, fnCtx });
    case "f64":
      return emitShapeVariant({ name: "F64Shape", state, ctx, fnCtx });
    case "string":
      return emitShapeVariant({ name: "StringShape", state, ctx, fnCtx });
    case "void":
      return emitShapeVariant({ name: "UnitShape", state, ctx, fnCtx });
    case "ref": {
      const name = schema.name ?? formatTypeName(schema.typeId, ctx);
      const reference = shapeReferenceFor({
        typeId: schema.typeId,
        name,
        state,
      });
      return emitShapeVariant({
        name: "RefShape",
        fields: new Map([["key", emitStringLiteral(reference.key, ctx)]]),
        state,
        ctx,
        fnCtx,
      });
    }
    case "array":
      return emitShapeVariant({
        name: "ArrayShape",
        fields: new Map([
          [
            "element",
            emitShapeNode({ schema: schema.element, state, ctx, fnCtx }),
          ],
        ]),
        state,
        ctx,
        fnCtx,
      });
    case "record": {
      const memberTypeId = shapeVariantTypeId(
        state.model.nodeTypeId,
        "RecordShape",
        ctx,
      );
      const fieldsTypeId = requiredStructuralField(
        memberTypeId,
        "fields",
        ctx,
      ).typeId;
      return emitShapeVariant({
        name: "RecordShape",
        fields: new Map([
          ["name", emitStringLiteral(schema.name, ctx)],
          [
            "documentation",
            emitOptionalString({
              value: schema.documentation,
              optionalTypeId: requiredStructuralField(
                memberTypeId,
                "documentation",
                ctx,
              ).typeId,
              ctx,
              fnCtx,
            }),
          ],
          [
            "fields",
            emitShapeFields({
              fields: schema.fields,
              arrayTypeId: fieldsTypeId,
              state,
              ctx,
              fnCtx,
            }),
          ],
        ]),
        state,
        ctx,
        fnCtx,
      });
    }
    case "union": {
      const memberTypeId = shapeVariantTypeId(
        state.model.nodeTypeId,
        "UnionShape",
        ctx,
      );
      const variantsArrayTypeId = requiredStructuralField(
        memberTypeId,
        "variants",
        ctx,
      ).typeId;
      return emitShapeVariant({
        name: "UnionShape",
        fields: new Map([
          ["name", emitStringLiteral(schema.name, ctx)],
          [
            "documentation",
            emitOptionalString({
              value: schema.documentation,
              optionalTypeId: requiredStructuralField(
                memberTypeId,
                "documentation",
                ctx,
              ).typeId,
              ctx,
              fnCtx,
            }),
          ],
          [
            "variants",
            emitShapeVariants({
              variants: schema.variants,
              arrayTypeId: variantsArrayTypeId,
              state,
              ctx,
              fnCtx,
            }),
          ],
        ]),
        state,
        ctx,
        fnCtx,
      });
    }
  }
};

const shapeReferenceFor = ({
  typeId,
  name,
  state,
}: {
  typeId: TypeId;
  name: string;
  state: ShapeBuildState;
}): ShapeReference => {
  const existing = state.referenced.get(typeId);
  if (existing) {
    return existing;
  }

  let key = name;
  let suffix = 2;
  while (state.usedReferenceKeys.has(key)) {
    key = `${name}#${suffix}`;
    suffix += 1;
  }
  const reference = { key, name };
  state.referenced.set(typeId, reference);
  state.usedReferenceKeys.add(key);
  return reference;
};

const emitShapeFields = ({
  fields,
  arrayTypeId,
  state,
  ctx,
  fnCtx,
}: {
  fields: readonly BoundaryFieldSchema[];
  arrayTypeId: TypeId;
  state: ShapeBuildState;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): binaryen.ExpressionRef => {
  const fieldTypeId = arrayElementType(arrayTypeId, ctx);
  const values = fields.map((field) =>
    emitObject({
      typeId: fieldTypeId,
      fields: new Map([
        ["name", emitStringLiteral(field.name, ctx)],
        [
          "shape",
          emitShapeNode({ schema: field.schema, state, ctx, fnCtx }),
        ],
        ["optional", ctx.mod.i32.const(field.optional === true ? 1 : 0)],
        [
          "documentation",
          emitOptionalString({
            value: field.documentation,
            optionalTypeId: requiredStructuralField(
              fieldTypeId,
              "documentation",
              ctx,
            ).typeId,
            ctx,
            fnCtx,
          }),
        ],
      ]),
      ctx,
      fnCtx,
    }),
  );
  return emitArray({ arrayTypeId, elements: values, ctx, fnCtx });
};

const emitShapeVariants = ({
  variants,
  arrayTypeId,
  state,
  ctx,
  fnCtx,
}: {
  variants: readonly BoundaryVariantSchema[];
  arrayTypeId: TypeId;
  state: ShapeBuildState;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): binaryen.ExpressionRef => {
  const variantTypeId = arrayElementType(arrayTypeId, ctx);
  const fieldsArrayTypeId = requiredStructuralField(
    variantTypeId,
    "fields",
    ctx,
  ).typeId;
  const values = variants.map((variant) =>
    emitObject({
      typeId: variantTypeId,
      fields: new Map([
        ["name", emitStringLiteral(variant.name, ctx)],
        [
          "documentation",
          emitOptionalString({
            value: variant.documentation,
            optionalTypeId: requiredStructuralField(
              variantTypeId,
              "documentation",
              ctx,
            ).typeId,
            ctx,
            fnCtx,
          }),
        ],
        [
          "fields",
          emitShapeFields({
            fields: variant.fields,
            arrayTypeId: fieldsArrayTypeId,
            state,
            ctx,
            fnCtx,
          }),
        ],
      ]),
      ctx,
      fnCtx,
    }),
  );
  return emitArray({ arrayTypeId, elements: values, ctx, fnCtx });
};

const emitShapeVariant = ({
  name,
  fields = new Map(),
  state,
  ctx,
  fnCtx,
}: {
  name: string;
  fields?: ReadonlyMap<string, binaryen.ExpressionRef>;
  state: ShapeBuildState;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): binaryen.ExpressionRef => {
  const memberTypeId = shapeVariantTypeId(
    state.model.nodeTypeId,
    name,
    ctx,
  );
  try {
    return coerceValueToType({
      value: emitObject({ typeId: memberTypeId, fields, ctx, fnCtx }),
      actualType: memberTypeId,
      targetType: state.model.nodeTypeId,
      ctx,
      fnCtx,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `failed to construct ${name} (${memberTypeId}) as ShapeNode (${state.model.nodeTypeId}): ${detail}`,
      { cause: error },
    );
  }
};

const emitObject = ({
  typeId,
  fields,
  ctx,
  fnCtx,
}: {
  typeId: TypeId;
  fields: ReadonlyMap<string, binaryen.ExpressionRef>;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): binaryen.ExpressionRef => {
  const info = requiredStructuralInfo(typeId, ctx);
  const fieldValues = info.fields.map((field) => {
    const value = fields.get(field.name);
    if (value === undefined) {
      throw new Error(`shape runtime value is missing field ${field.name}`);
    }
    try {
      return lowerFieldValue({ info, field, value, ctx, fnCtx });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `failed to initialize shape runtime field ${field.name} on type ${typeId}: ${detail}`,
        { cause: error },
      );
    }
  });
  return initStructuralValue({ structInfo: info, fieldValues, ctx });
};

const emitOptionalString = ({
  value,
  optionalTypeId,
  ctx,
  fnCtx,
}: {
  value: string | undefined;
  optionalTypeId: TypeId;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): binaryen.ExpressionRef => {
  const optional = ctx.program.optionals.getOptionalInfo(
    ctx.moduleId,
    optionalTypeId,
  );
  if (!optional) {
    throw new Error("shape documentation field must be Optional<String>");
  }
  return value
    ? compileOptionalSomeValue({
        targetTypeId: optionalTypeId,
        value: emitStringLiteral(value, ctx),
        valueTypeId: optional.innerType,
        ctx,
        fnCtx,
      })
    : compileOptionalNoneValue({ targetTypeId: optionalTypeId, ctx, fnCtx });
};

const emitArray = ({
  arrayTypeId,
  elements,
  ctx,
  fnCtx,
}: {
  arrayTypeId: TypeId;
  elements: readonly binaryen.ExpressionRef[];
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): binaryen.ExpressionRef => {
  const info = requiredStructuralInfo(arrayTypeId, ctx);
  const storage = requiredField(info, "storage", arrayTypeId);
  requiredField(info, "count", arrayTypeId);
  const elementTypeId = arrayElementType(arrayTypeId, ctx);
  const storageTypes = getFixedArrayWasmTypes(storage.typeId, ctx);
  const storageValue = arrayNewFixed(
    ctx.mod,
    storageTypes.heapType,
    elements.map((element) =>
      lowerFixedArrayElementValue({
        value: element,
        typeId: elementTypeId,
        ctx,
        fnCtx,
      }),
    ) as number[],
  );
  const fieldValues = info.fields.map((field) => {
    const value =
      field.name === "storage"
        ? storageValue
        : field.name === "count"
          ? ctx.mod.i32.const(elements.length)
          : undefined;
    if (value === undefined) {
      throw new Error(`unexpected Array shape runtime field ${field.name}`);
    }
    try {
      return lowerFieldValue({ info, field, value, ctx, fnCtx });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `failed to initialize shape array field ${field.name} on type ${arrayTypeId}: ${detail}`,
        { cause: error },
      );
    }
  });
  return initStructuralValue({ structInfo: info, fieldValues, ctx });
};

const lowerFieldValue = ({
  info,
  field,
  value,
  ctx,
  fnCtx,
}: {
  info: StructuralTypeInfo;
  field: StructuralFieldInfo;
  value: binaryen.ExpressionRef;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): binaryen.ExpressionRef =>
  info.layoutKind === "value-object"
    ? coerceExprToWasmType({ expr: value, targetType: field.wasmType, ctx })
    : lowerValueForHeapField({
        value,
        typeId: field.typeId,
        targetType: field.heapWasmType,
        ctx,
        fnCtx,
      });

const runtimeShapeModel = (
  shapeTypeId: TypeId,
  ctx: CodegenContext,
): RuntimeShapeModel => {
  const shape = requiredStructuralInfo(shapeTypeId, ctx);
  const nodeTypeId = requiredField(shape, "root", shapeTypeId).typeId;
  const definitionArrayTypeId = requiredField(
    shape,
    "definitions",
    shapeTypeId,
  ).typeId;
  return {
    shapeTypeId,
    nodeTypeId,
    definitionArrayTypeId,
    definitionTypeId: arrayElementType(definitionArrayTypeId, ctx),
  };
};

const shapeVariantTypeId = (
  nodeTypeId: TypeId,
  name: string,
  ctx: CodegenContext,
): TypeId => {
  const initial = ctx.program.types.getTypeDesc(nodeTypeId);
  const desc =
    initial.kind === "recursive"
      ? ctx.program.types.getTypeDesc(
          ctx.program.types.substitute(
            initial.body,
            new Map([[initial.binder, nodeTypeId]]),
          ),
        )
      : initial;
  if (desc.kind !== "union") {
    throw new Error("std::meta::ShapeNode must be a union");
  }
  const match = desc.members.find(
    (member) => nominalTypeName(member, ctx) === name,
  );
  if (match === undefined) {
    throw new Error(`std::meta::ShapeNode is missing ${name}`);
  }
  return match;
};

const nominalTypeName = (typeId: TypeId, ctx: CodegenContext): string => {
  const desc = ctx.program.types.getTypeDesc(typeId);
  if (
    (desc.kind === "nominal-object" || desc.kind === "value-object") &&
    desc.name
  ) {
    return desc.name;
  }
  if (desc.kind === "intersection" && typeof desc.nominal === "number") {
    return nominalTypeName(desc.nominal, ctx);
  }
  return "";
};

const arrayElementType = (
  arrayTypeId: TypeId,
  ctx: CodegenContext,
): TypeId => {
  const storage = getStructuralTypeInfo(arrayTypeId, ctx)?.fieldMap.get(
    "storage",
  );
  if (storage) {
    const storageDesc = ctx.program.types.getTypeDesc(storage.typeId);
    if (
      storageDesc.kind === "fixed-array" &&
      ctx.program.types.getTypeDesc(storageDesc.element).kind !==
        "type-param-ref"
    ) {
      return storageDesc.element;
    }
  }
  const desc = ctx.program.types.getTypeDesc(arrayTypeId);
  const nominal =
    desc.kind === "intersection" && typeof desc.nominal === "number"
      ? ctx.program.types.getTypeDesc(desc.nominal)
      : desc;
  if (
    (nominal.kind !== "nominal-object" && nominal.kind !== "value-object") ||
    nominal.typeArgs.length !== 1
  ) {
    throw new Error("shape runtime field must use Array<T>");
  }
  return nominal.typeArgs[0]!;
};

const requiredStructuralInfo = (
  typeId: TypeId,
  ctx: CodegenContext,
): StructuralTypeInfo => {
  const info = getStructuralTypeInfo(typeId, ctx);
  if (!info) {
    throw new Error(`shape runtime type ${typeId} has no structural layout`);
  }
  return info;
};

const requiredStructuralField = (
  typeId: TypeId,
  name: string,
  ctx: CodegenContext,
): StructuralFieldInfo =>
  requiredField(requiredStructuralInfo(typeId, ctx), name, typeId);

const requiredField = (
  info: StructuralTypeInfo,
  name: string,
  typeId: TypeId,
): StructuralFieldInfo => {
  const field = info.fieldMap.get(name);
  if (!field) {
    throw new Error(`shape runtime type ${typeId} is missing field ${name}`);
  }
  return field;
};

const schemaDocumentation = (schema: BoundarySchema): string | undefined =>
  schema.kind === "record" || schema.kind === "union"
    ? schema.documentation
    : undefined;

const formatTypeName = (typeId: TypeId, ctx: CodegenContext): string => {
  const desc = ctx.program.types.getTypeDesc(typeId);
  if (desc.kind === "primitive") return desc.name;
  if (
    (desc.kind === "nominal-object" || desc.kind === "value-object") &&
    desc.name
  ) {
    return desc.name;
  }
  return `type#${typeId}`;
};
