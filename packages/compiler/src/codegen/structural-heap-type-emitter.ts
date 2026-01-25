import binaryen from "binaryen";
import { annotateStructNames, TypeBuilder } from "@voyd/lib/binaryen-gc/index.js";
import type { AugmentedBinaryen } from "@voyd/lib/binaryen-gc/types.js";
import type { CodegenContext, TypeId } from "./context.js";

const bin = binaryen as unknown as AugmentedBinaryen;

export const emitRecursiveStructuralHeapTypeGroup = ({
  component,
  ctx,
  getDirectDeps,
  structNameFor,
  resolveStructuralTypeId,
  ensureStructuralRuntimeType,
  lowerNonStructural,
  baseHeapType,
}: {
  component: readonly TypeId[];
  ctx: CodegenContext;
  getDirectDeps: (id: TypeId) => readonly TypeId[];
  structNameFor: (id: TypeId) => string;
  resolveStructuralTypeId: (typeId: TypeId) => TypeId | undefined;
  ensureStructuralRuntimeType: (structuralId: TypeId) => binaryen.Type;
  lowerNonStructural: (typeId: TypeId) => binaryen.Type;
  baseHeapType: number;
}): void => {
  const inGroup = new Set(component);
  component.forEach((id) => {
    getDirectDeps(id).forEach((dep) => {
      if (!inGroup.has(dep)) {
        ensureStructuralRuntimeType(dep);
      }
    });
  });

  const indexByType = new Map<TypeId, number>(
    component.map((id, index) => [id, index] as const),
  );

  const builder = new TypeBuilder(component.length);
  try {
    const defs = component.map((id, index) => {
      const desc = ctx.program.types.getTypeDesc(id);
      if (desc.kind !== "structural-object") {
        throw new Error(`expected structural-object type ${id}`);
      }

      const structName = structNameFor(id);
      const fields = [
        {
          name: "__ancestors_table",
          type: ctx.rtt.extensionHelpers.i32Array,
          mutable: false,
        },
        {
          name: "__field_index_table",
          type: ctx.rtt.fieldLookupHelpers.lookupTableType,
          mutable: false,
        },
        {
          name: "__method_lookup_table",
          type: ctx.rtt.methodLookupHelpers.lookupTableType,
          mutable: false,
        },
        ...desc.fields.map((field) => {
          const fieldStructural = resolveStructuralTypeId(field.type);
          if (typeof fieldStructural === "number") {
            const groupIndex = indexByType.get(fieldStructural);
            const type =
              typeof groupIndex === "number"
                ? builder.getTempRefType(groupIndex, true)
                : ensureStructuralRuntimeType(fieldStructural);
            return { name: field.name, type, mutable: true };
          }
          return {
            name: field.name,
            type: lowerNonStructural(field.type),
            mutable: true,
          };
        }),
      ];

      builder.setStruct(index, { name: structName, fields });
      builder.setSubType(index, baseHeapType);
      return { id, name: structName, fields };
    });

    const heapTypes = builder.buildAll();
    heapTypes.forEach((heapType, index) => {
      const def = defs[index]!;
      annotateStructNames(ctx.mod, heapType, { name: def.name, fields: def.fields });
      const typeRef = bin._BinaryenTypeFromHeapType(heapType, true);
      ctx.structHeapTypes.set(def.id, typeRef);
    });
  } finally {
    builder.dispose();
  }
};

