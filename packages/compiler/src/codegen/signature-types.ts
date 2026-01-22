import type binaryen from "binaryen";
import type { CodegenContext, TypeId } from "./context.js";
import { wasmTypeFor } from "./types.js";

export const wasmSignatureTypeFor = (
  typeId: TypeId,
  ctx: CodegenContext,
  seen: Set<TypeId> = new Set()
): binaryen.Type => wasmTypeFor(typeId, ctx, seen, "signature");

