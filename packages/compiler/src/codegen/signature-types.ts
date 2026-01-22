import binaryen from "binaryen";
import type { CodegenContext, TypeId } from "./context.js";
import { ensureClosureTypeInfo } from "./closure-types.js";
import { ensureFixedArrayWasmTypes } from "./fixed-array-types.js";
import { mapPrimitiveToWasm } from "./primitive-types.js";

export const wasmSignatureTypeFor = (
  typeId: TypeId,
  ctx: CodegenContext,
  seen: Set<TypeId> = new Set()
): binaryen.Type => {
  if (seen.has(typeId)) {
    return ctx.rtt.baseType;
  }
  seen.add(typeId);

  try {
    const desc = ctx.program.types.getTypeDesc(typeId);
    switch (desc.kind) {
      case "recursive": {
        const unfolded = ctx.program.types.substitute(
          desc.body,
          new Map([[desc.binder, typeId]])
        );
        return wasmSignatureTypeFor(unfolded, ctx, seen);
      }
      case "primitive":
        return mapPrimitiveToWasm(desc.name);
      case "fixed-array":
        return ensureFixedArrayWasmTypes({
          typeId,
          ctx,
          seen,
          mode: "signature",
          lowerType: (id, ctx, seen, mode) =>
            mode === "signature"
              ? wasmSignatureTypeFor(id, ctx, seen)
              : wasmSignatureTypeFor(id, ctx, seen),
        }).type;
      case "function": {
        const info = ensureClosureTypeInfo({
          typeId,
          desc,
          ctx,
          seen,
          mode: "signature",
          lowerType: (id, ctx, seen, mode) =>
            mode === "signature"
              ? wasmSignatureTypeFor(id, ctx, seen)
              : wasmSignatureTypeFor(id, ctx, seen),
        });
        return info.interfaceType;
      }
      case "union": {
        if (desc.members.length === 0) {
          throw new Error("cannot map empty union to wasm signature");
        }
        const memberTypes = desc.members.map((member) =>
          wasmSignatureTypeFor(member, ctx, seen)
        );
        const first = memberTypes[0]!;
        if (!memberTypes.every((candidate) => candidate === first)) {
          throw new Error("union members map to different wasm signature types");
        }
        return first;
      }
      case "type-param-ref":
        throw new Error(
          `codegen cannot map unresolved type parameter to wasm signature (module ${ctx.moduleId}, type ${typeId}, param ${desc.param})`
        );
      case "trait":
      case "nominal-object":
      case "structural-object":
      case "intersection":
        return ctx.rtt.baseType;
      default:
        return ctx.rtt.baseType;
    }
  } finally {
    seen.delete(typeId);
  }
};
