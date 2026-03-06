import type { CodegenContext } from "../../context.js";
import type { EffectOpSignature } from "./types.js";

export type HostBoundaryOperationFilter =
  | { includeAll: true }
  | { includeAll: false; operationNames: ReadonlySet<string> };

const operationNameFromSignatureLabel = (label: string): string => {
  const sep = label.lastIndexOf("::");
  return sep >= 0 ? label.slice(sep + 2) : label;
};

export const normalizeEffectOperationName = (operationName: string): string => {
  const signatureStart = operationName.indexOf("(");
  return signatureStart >= 0
    ? operationName.slice(0, signatureStart)
    : operationName;
};

export const collectHostBoundaryOperationFilter = ({
  entryCtx,
  effectfulExports,
}: {
  entryCtx: CodegenContext;
  effectfulExports: readonly { meta: { effectRow?: number } }[];
}): HostBoundaryOperationFilter => {
  const operationNames = new Set<string>();
  let includeAll = false;
  let sawConcreteRow = false;
  effectfulExports.forEach(({ meta }) => {
    if (typeof meta.effectRow !== "number") {
      includeAll = true;
      return;
    }
    sawConcreteRow = true;
    const effectRow = entryCtx.program.effects.getRow(meta.effectRow);
    if (effectRow.tailVar) {
      includeAll = true;
      return;
    }
    effectRow.operations.forEach((op) => {
      operationNames.add(normalizeEffectOperationName(op.name));
    });
  });
  if (!sawConcreteRow) {
    return { includeAll: true };
  }
  return includeAll ? { includeAll: true } : { includeAll: false, operationNames };
};

export const filterSignaturesForHostBoundary = ({
  entryCtx,
  contexts,
  signatures,
  filter,
}: {
  entryCtx: CodegenContext;
  contexts: readonly CodegenContext[];
  signatures: readonly EffectOpSignature[];
  filter: HostBoundaryOperationFilter;
}): EffectOpSignature[] => {
  if (filter.includeAll) {
    return [...signatures];
  }
  if (filter.operationNames.size === 0) {
    return [];
  }
  const registry = entryCtx.effectsState.effectRegistry;
  if (registry) {
    const allowedEffectOps = new Set<string>();
    contexts.forEach((ctx) => {
      ctx.module.effectsInfo.operations.forEach((opInfo) => {
        if (!filter.operationNames.has(normalizeEffectOperationName(opInfo.name))) {
          return;
        }
        const sourceModuleId = opInfo.sourceModuleId ?? ctx.moduleId;
        const effectId = registry.getEffectId(sourceModuleId, opInfo.localEffectIndex);
        if (!effectId) {
          return;
        }
        allowedEffectOps.add(`${effectId.hash.value}:${opInfo.opIndex}`);
      });
    });
    if (allowedEffectOps.size > 0) {
      return signatures.filter((signature) =>
        allowedEffectOps.has(`${signature.effectId}:${signature.opId}`),
      );
    }
  }
  const operationNames = Array.from(filter.operationNames);
  return signatures.filter((signature) =>
    operationNames.some(
      (operationName) =>
        operationNameFromSignatureLabel(signature.label) === operationName ||
        signature.label.endsWith(operationName),
    ),
  );
};
