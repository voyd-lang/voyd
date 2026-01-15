import binaryen from "binaryen";
import type { CodegenContext } from "../../context.js";
import { wasmTypeFor } from "../../types.js";
import { VALUE_TAG } from "./constants.js";
import type { EffectOpSignature } from "./types.js";
import { stateFor } from "./state.js";
import type { ContinuationSite } from "../effect-lowering/types.js";
import { performSiteArgTypes } from "../perform-site.js";

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

const isPerformSite = (
  site: ContinuationSite
): site is Extract<ContinuationSite, { kind: "perform" }> => site.kind === "perform";

const sameTypeList = (
  left: readonly binaryen.Type[],
  right: readonly binaryen.Type[]
): boolean =>
  left.length === right.length && left.every((type, index) => type === right[index]);

type EffectOperationIndexEntry = {
  ctx: CodegenContext;
  label: string;
  opSymbol: number;
};

const signatureKey = (effectId: number, opId: number): string => `${effectId}:${opId}`;

const buildEffectOperationIndex = (
  contexts: readonly CodegenContext[]
): ReadonlyMap<string, EffectOperationIndexEntry> => {
  const index = new Map<string, EffectOperationIndexEntry>();

  contexts.forEach((ctx) => {
    ctx.module.meta.effects.forEach((effect, localEffectIndex) => {
      const effectId = ctx.program.effects.getGlobalId(ctx.moduleId, localEffectIndex);
      if (typeof effectId !== "number") {
        throw new Error(
          `missing global effect id for ${ctx.moduleId}:${localEffectIndex}`
        );
      }
      effect.operations.forEach((op, opId) => {
        const key = signatureKey(effectId, opId);
        const existing = index.get(key);
        const entry: EffectOperationIndexEntry = {
          ctx,
          label: `${effect.name}.${op.name}`,
          opSymbol: op.symbol,
        };
        if (!existing) {
          index.set(key, entry);
          return;
        }
        if (existing.opSymbol !== op.symbol) {
          throw new Error(
            `duplicate effect operation id ${key} for ${existing.label} and ${entry.label}`
          );
        }
      });
    });
  });

  return index;
};

export const collectEffectOperationSignatures = (
  ctx: CodegenContext,
  contexts: readonly CodegenContext[] = [ctx]
): EffectOpSignature[] =>
  stateFor(ctx, OP_SIGNATURES_KEY, () => {
    const signaturesByKey = new Map<string, EffectOpSignature>();
    const opIndex = buildEffectOperationIndex(contexts);

    contexts.forEach((siteCtx) => {
      siteCtx.effectLowering.sites.filter(isPerformSite).forEach((site) => {
        const operation = opIndex.get(signatureKey(site.effectId, site.opId));
        if (!operation) {
          throw new Error(
            `missing effect operation declaration for effect=${site.effectId} op=${site.opId}`
          );
        }

        const signature = operation.ctx.program.functions.getSignature(
          operation.ctx.moduleId,
          operation.opSymbol
        );
        if (!signature) {
          throw new Error("missing effect operation signature");
        }

        const paramTypes = performSiteArgTypes({ exprId: site.exprId, ctx: siteCtx });
        const params = paramTypes.map((paramType) => wasmTypeFor(paramType, siteCtx));
        const returnType = wasmTypeFor(site.resumeValueTypeId, siteCtx);
        const label = operation.label;

        const key = `${site.effectId}:${site.opId}`;
        const existing = signaturesByKey.get(key);
        if (!existing) {
          signaturesByKey.set(key, {
            effectId: site.effectId,
            opId: site.opId,
            params,
            returnType,
            argsType: site.argsType,
            label,
          });
          return;
        }

        if (
          existing.returnType !== returnType ||
          !sameTypeList(existing.params, params)
        ) {
          throw new Error(
            `host boundary signature conflict for ${label} (${key}); ensure it resolves to a single concrete wasm signature`
          );
        }

        if (!existing.argsType && site.argsType) {
          existing.argsType = site.argsType;
        }
      });
    });

    return Array.from(signaturesByKey.values()).sort((a, b) =>
      a.effectId !== b.effectId ? a.effectId - b.effectId : a.opId - b.opId
    );
  });
