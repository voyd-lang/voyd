import type binaryen from "binaryen";
import { defineStructType } from "@voyd/lib/binaryen-gc/index.js";
import type { CodegenContext } from "../context.js";
import type { TypeId } from "../../semantics/ids.js";
import { wasmTypeFor } from "../types.js";

export const ensureEffectArgsType = ({
  ctx,
  opIndex,
  paramTypes,
}: {
  ctx: CodegenContext;
  opIndex: number;
  paramTypes: readonly TypeId[];
}): binaryen.Type | undefined => {
  if (paramTypes.length === 0) return undefined;
  const cached = ctx.effectsState.effectArgsTypes.get(opIndex);
  if (cached) return cached;

  const fields = paramTypes.map((typeId, index) => ({
    name: `arg${index}`,
    type: wasmTypeFor(typeId, ctx),
    mutable: false,
  }));
  const type = defineStructType(ctx.mod, {
    name: `voydEffectArgs_${opIndex}`,
    fields,
    final: true,
  });
  ctx.effectsState.effectArgsTypes.set(opIndex, type);
  return type;
};
