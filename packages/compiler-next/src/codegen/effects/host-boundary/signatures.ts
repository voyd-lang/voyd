import binaryen from "binaryen";
import type { CodegenContext } from "../../context.js";
import { wasmTypeFor } from "../../types.js";
import { VALUE_TAG } from "./constants.js";
import type { EffectOpSignature } from "./types.js";
import { stateFor } from "./state.js";

const OP_SIGNATURES_KEY = Symbol("voyd.effects.hostBoundary.opSignatures");

export const supportedValueTag = ({
  wasmType,
  label,
}: {
  wasmType: binaryen.Type;
  label: string;
}): number => {
  if (wasmType === binaryen.none) return VALUE_TAG.none;
  if (wasmType === binaryen.i32) return VALUE_TAG.i32;
  if (wasmType === binaryen.i64) return VALUE_TAG.i64;
  if (wasmType === binaryen.f32) return VALUE_TAG.f32;
  if (wasmType === binaryen.f64) return VALUE_TAG.f64;
  throw new Error(
    `unsupported value type ${wasmType} for host boundary (${label})`
  );
};

export const collectEffectOperationSignatures = (
  ctx: CodegenContext
): EffectOpSignature[] =>
  stateFor(ctx, OP_SIGNATURES_KEY, () => {
    const signatures: EffectOpSignature[] = [];
    ctx.binding.effects.forEach((effect, localEffectId) => {
      const effectId = ctx.effectIdOffset + localEffectId;
      effect.operations.forEach((op, opId) => {
        const signature = ctx.typing.functions.getSignature(op.symbol);
        if (!signature) {
          throw new Error("missing effect operation signature");
        }
        const params = signature.parameters.map((param) => wasmTypeFor(param.type, ctx));
        const returnType = wasmTypeFor(signature.returnType, ctx);
        const label = `${effect.name}.${op.name}`;
        signatures.push({
          effectId,
          opId,
          params,
          returnType,
          argsType: ctx.effectLowering.argsTypes.get(op.symbol),
          label,
        });
      });
    });
    return signatures;
  });
