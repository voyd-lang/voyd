import binaryen from "binaryen";
import type { CodegenContext } from "../../context.js";
import { wasmTypeFor } from "../../types.js";
import { VALUE_TAG } from "./constants.js";
import type { EffectOpSignature } from "./types.js";
import { stateFor } from "./state.js";
import type { ContinuationSite } from "../effect-lowering/types.js";
import { walkHirExpression } from "../../hir-walk.js";
import type {
  HirExprId,
  ProgramFunctionInstanceId,
  SymbolId,
} from "../../semantics/ids.js";
import {
  getEffectOpInstanceInfo,
  resolvePerformSignature,
} from "../effect-registry.js";
import { ensureEffectArgsType } from "../args-type.js";

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

const buildOwnerMap = (ctx: CodegenContext): Map<HirExprId, SymbolId> => {
  const ownerByExpr = new Map<HirExprId, SymbolId>();
  ctx.module.hir.items.forEach((item) => {
    if (item.kind !== "function") return;
    walkHirExpression({
      exprId: item.body,
      ctx,
      visitLambdaBodies: true,
      visitHandlerBodies: true,
      visitor: {
        onExpr: (exprId) => {
          ownerByExpr.set(exprId, item.symbol);
        },
      },
    });
  });
  return ownerByExpr;
};

const instancesBySymbol = (
  ctx: CodegenContext
): Map<SymbolId, ProgramFunctionInstanceId[]> => {
  const bySymbol = new Map<SymbolId, ProgramFunctionInstanceId[]>();
  ctx.functionInstances.forEach((meta, instanceId) => {
    if (meta.moduleId !== ctx.moduleId) return;
    const bucket = bySymbol.get(meta.symbol) ?? [];
    bucket.push(instanceId);
    bySymbol.set(meta.symbol, bucket);
  });
  return bySymbol;
};

export const collectEffectOperationSignatures = (
  ctx: CodegenContext,
  contexts: readonly CodegenContext[] = [ctx]
): EffectOpSignature[] =>
  stateFor(ctx, OP_SIGNATURES_KEY, () => {
    const registry = ctx.effectsState.effectRegistry;
    if (!registry) {
      throw new Error("missing effect registry for host boundary signatures");
    }

    const signaturesByIndex = new Map<number, EffectOpSignature>();

    contexts.forEach((siteCtx) => {
      const ownerByExpr = buildOwnerMap(siteCtx);
      const instances = instancesBySymbol(siteCtx);

      siteCtx.effectLowering.sites.filter(isPerformSite).forEach((site) => {
        const ownerSymbol = ownerByExpr.get(site.exprId);
        const owners = ownerSymbol ? instances.get(ownerSymbol) ?? [] : [];
        const instanceList =
          owners.length > 0 ? owners : [undefined as ProgramFunctionInstanceId | undefined];

        instanceList.forEach((typeInstanceId) => {
          const opInfo = getEffectOpInstanceInfo({
            ctx: siteCtx,
            site,
            typeInstanceId,
            registry,
          });
          const signature = resolvePerformSignature({
            site,
            ctx: siteCtx,
            typeInstanceId,
          });
          const params = signature.params.map((paramType) =>
            wasmTypeFor(paramType, siteCtx)
          );
          const returnType = wasmTypeFor(signature.returnType, siteCtx);
          const argsType = ensureEffectArgsType({
            ctx: siteCtx,
            opIndex: opInfo.opIndex,
            paramTypes: signature.params,
          });

          const existing = signaturesByIndex.get(opInfo.opIndex);
          if (!existing) {
            signaturesByIndex.set(opInfo.opIndex, {
              opIndex: opInfo.opIndex,
              effectId: opInfo.effectId.hash.value,
              opId: opInfo.opId,
              resumeKind: opInfo.resumeKind,
              signatureHash: opInfo.signatureHash,
              params,
              returnType,
              argsType,
              label: opInfo.label,
            });
            return;
          }

          if (
            existing.returnType !== returnType ||
            !sameTypeList(existing.params, params)
          ) {
            throw new Error(
              `host boundary signature conflict for ${opInfo.label} (opIndex=${opInfo.opIndex}); ensure it resolves to a single concrete wasm signature`
            );
          }

          if (!existing.argsType && argsType) {
            existing.argsType = argsType;
          }
        });
      });
    });

    return Array.from(signaturesByIndex.values()).sort((a, b) => a.opIndex - b.opIndex);
  });
