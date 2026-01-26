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

  const fixedArrayElementStructuralsInGroup = new Set<TypeId>();
  const collectFixedArrayElementsInGroup = (root: TypeId): void => {
    const visited = new Set<TypeId>();
    const pending: TypeId[] = [root];
    while (pending.length > 0) {
      const current = pending.pop()!;
      if (visited.has(current)) {
        continue;
      }
      visited.add(current);

      const structural = resolveStructuralTypeId(current);
      if (typeof structural === "number" && inGroup.has(structural)) {
        continue;
      }

      const desc = ctx.program.types.getTypeDesc(current);
      switch (desc.kind) {
        case "recursive":
          pending.push(desc.body);
          break;
        case "fixed-array": {
          const elementStructural = resolveStructuralTypeId(desc.element);
          if (
            typeof elementStructural === "number" &&
            inGroup.has(elementStructural)
          ) {
            fixedArrayElementStructuralsInGroup.add(elementStructural);
          }
          pending.push(desc.element);
          break;
        }
        case "nominal-object":
        case "trait":
          desc.typeArgs.forEach((arg) => pending.push(arg));
          break;
        case "function":
          desc.parameters.forEach((param) => pending.push(param.type));
          pending.push(desc.returnType);
          break;
        case "union":
          desc.members.forEach((member) => pending.push(member));
          break;
        case "intersection":
          if (typeof desc.nominal === "number") {
            pending.push(desc.nominal);
          }
          if (typeof desc.structural === "number") {
            pending.push(desc.structural);
          }
          break;
        default:
          break;
      }
    }
  };

  component.forEach((id) => {
    const desc = ctx.program.types.getTypeDesc(id);
    if (desc.kind !== "structural-object") {
      return;
    }
    desc.fields.forEach((field) => collectFixedArrayElementsInGroup(field.type));
  });

  const arrayElementStructurals = Array.from(
    fixedArrayElementStructuralsInGroup,
  ).sort((a, b) => a - b);

  const structCount = component.length;
  const arrayIndexByElementStructuralId = new Map<TypeId, number>(
    arrayElementStructurals.map(
      (elementStructuralId, index) =>
        [elementStructuralId, structCount + index] as const,
    ),
  );

  const builder = new TypeBuilder(structCount + arrayElementStructurals.length);
  try {
    const previousActiveGroup = ctx.activeRecursiveHeapTypeGroup;
    if (arrayElementStructurals.length > 0) {
      const fixedArrayTempRefsByElementStructuralId = new Map<
        TypeId,
        binaryen.Type
      >(
        arrayElementStructurals.map((elementStructuralId) => {
          const arrayIndex = arrayIndexByElementStructuralId.get(
            elementStructuralId,
          );
          if (typeof arrayIndex !== "number") {
            throw new Error(
              `missing recursive array index for structural ${elementStructuralId}`,
            );
          }
          return [
            elementStructuralId,
            builder.getTempRefType(arrayIndex, true),
          ] as const;
        }),
      );

      ctx.activeRecursiveHeapTypeGroup = {
        structuralIds: inGroup,
        fixedArrayTempRefsByElementStructuralId,
      };
    }

    try {
      arrayElementStructurals.forEach((elementStructuralId) => {
        const arrayIndex = arrayIndexByElementStructuralId.get(
          elementStructuralId,
        );
        if (typeof arrayIndex !== "number") {
          throw new Error(
            `missing recursive array index for structural ${elementStructuralId}`,
          );
        }
        const structIndex = indexByType.get(elementStructuralId);
        if (typeof structIndex !== "number") {
          throw new Error(
            `missing recursive structural index for ${elementStructuralId}`,
          );
        }
        const elementType = builder.getTempRefType(structIndex, true);
        builder.setArrayType(
          arrayIndex,
          elementType,
          bin._BinaryenPackedTypeNotPacked(),
          true,
        );
      });

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

      defs.forEach((def, index) => {
        const heapType = heapTypes[index]!;
        annotateStructNames(ctx.mod, heapType, {
          name: def.name,
          fields: def.fields,
        });
        const typeRef = bin._BinaryenTypeFromHeapType(heapType, true);
        ctx.structHeapTypes.set(def.id, typeRef);
      });

      arrayElementStructurals.forEach((elementStructuralId) => {
        const arrayIndex = arrayIndexByElementStructuralId.get(
          elementStructuralId,
        );
        if (typeof arrayIndex !== "number") {
          throw new Error(
            `missing recursive array index for structural ${elementStructuralId}`,
          );
        }
        const heapType = heapTypes[arrayIndex]!;
        const typeRef = bin._BinaryenTypeFromHeapType(heapType, true);
        const elementType = ctx.structHeapTypes.get(elementStructuralId);
        if (typeof elementType !== "number") {
          throw new Error(
            `missing cached heap type for array element structural ${elementStructuralId}`,
          );
        }
        if (!ctx.fixedArrayTypes.has(elementType)) {
          ctx.fixedArrayTypes.set(elementType, { type: typeRef, heapType });
          try {
            bin._BinaryenModuleSetTypeName(
              (ctx.mod as any).ptr,
              heapType,
              bin.stringToUTF8OnStack(`voyd_fixed_array_of_${elementStructuralId}`),
            );
          } catch {
          }
        }
      });
    } finally {
      ctx.activeRecursiveHeapTypeGroup = previousActiveGroup;
    }
  } finally {
    builder.dispose();
  }
};
