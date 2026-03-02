import binaryen from "binaryen";
import type { CodegenContext } from "../context.js";
import { diagnosticFromCode } from "../../diagnostics/index.js";
import { isPackageVisible } from "../../semantics/hir/index.js";
import {
  collectEffectOperationSignatures,
  createEffectfulEntry,
  createHandleOutcomeDynamic,
  createResumeContinuation,
  createResumeEffectful,
  ensureEffectResultAccessors,
  ensureEffectsMemory,
} from "./host-boundary.js";
import { EFFECTS_HOST_BOUNDARY_STD_DEPS } from "./host-boundary/constants.js";
import {
  collectHostBoundaryPayloadViolations,
  formatHostBoundaryPayloadViolation,
} from "./host-boundary/payload-compatibility.js";
import {
  collectHostBoundaryOperationFilter,
  filterSignaturesForHostBoundary,
} from "./host-boundary/operation-filter.js";
import type { EffectOpSignature } from "./host-boundary/types.js";
import type { EffectsAbiStrategy } from "./codegen-backend.js";

const hiddenHandlerParamType = (ctx: CodegenContext): binaryen.Type =>
  ctx.effectsRuntime.handlerFrameType;

const hiddenHandlerValue = (ctx: CodegenContext): binaryen.ExpressionRef =>
  ctx.mod.ref.null(hiddenHandlerParamType(ctx));

const effectfulResultType = (ctx: CodegenContext): binaryen.Type =>
  ctx.effectsRuntime.outcomeType;

const widenSignature: EffectsAbiStrategy["widenSignature"] = ({
  ctx,
  effectful,
  userParamTypes,
  userResultType,
}) =>
  effectful
    ? {
        paramTypes: [hiddenHandlerParamType(ctx), ...userParamTypes],
        resultType: effectfulResultType(ctx),
        userParamOffset: 1,
      }
    : { paramTypes: userParamTypes, resultType: userResultType, userParamOffset: 0 };

const parseSignatureLabel = (
  label: string,
): { moduleId: string; effectName: string } | undefined => {
  const moduleSep = label.lastIndexOf("::");
  if (moduleSep <= 0 || moduleSep >= label.length - 2) {
    return undefined;
  }
  const moduleId = label.slice(0, moduleSep);
  const operationLabel = label.slice(moduleSep + 2);
  const opSep = operationLabel.lastIndexOf(".");
  if (opSep <= 0) {
    return undefined;
  }
  return {
    moduleId,
    effectName: operationLabel.slice(0, opSep),
  };
};

const emitMissingEffectIdWarningsForHostBoundary = ({
  contexts,
  signatures,
}: {
  contexts: readonly CodegenContext[];
  signatures: readonly EffectOpSignature[];
}): void => {
  const contextById = new Map(contexts.map((ctx) => [ctx.moduleId, ctx]));
  const warned = new Set<string>();

  signatures.forEach((signature) => {
    const parsed = parseSignatureLabel(signature.label);
    if (!parsed) {
      return;
    }
    const warnKey = `${parsed.moduleId}::${parsed.effectName}`;
    if (warned.has(warnKey)) {
      return;
    }
    const moduleCtx = contextById.get(parsed.moduleId);
    if (!moduleCtx) {
      return;
    }
    const effectMeta = moduleCtx.module.meta.effects.find(
      (effect) => effect.name === parsed.effectName,
    );
    if (!effectMeta || effectMeta.effectId || !isPackageVisible(effectMeta.visibility)) {
      return;
    }

    const fallbackId = `${moduleCtx.module.meta.packageId}::${moduleCtx.moduleId}::${effectMeta.name}`;
    const effectSpan =
      Array.from(moduleCtx.module.hir.items.values()).find(
        (item) => item.kind === "effect" && item.symbol === effectMeta.symbol,
      )?.span ?? moduleCtx.module.hir.module.span;

    moduleCtx.diagnostics.report(
      diagnosticFromCode({
        code: "CG0004",
        params: {
          kind: "missing-effect-id",
          effectName: effectMeta.name,
          fallbackId,
        },
        span: effectSpan,
      }),
    );
    warned.add(warnKey);
  });
};

const emitHostBoundary: EffectsAbiStrategy["emitHostBoundary"] = ({
  entryCtx,
  contexts,
  effectfulExports,
}) => {
  if (effectfulExports.length === 0) {
    return;
  }

  const hostBoundary = entryCtx.options.effectsHostBoundary ?? "msgpack";
  if (hostBoundary === "off") {
    return;
  }

  const missingStdModules = EFFECTS_HOST_BOUNDARY_STD_DEPS.filter(
    (moduleId) => !entryCtx.program.modules.has(moduleId)
  );
  if (missingStdModules.length > 0) {
    entryCtx.diagnostics.report(
      diagnosticFromCode({
        code: "CG0001",
        params: {
          kind: "codegen-error",
          message: `effectful exports require ${missingStdModules.join(
            " and "
          )} (provide a std root or disable the host boundary via effectsHostBoundary: "off")`,
        },
        span: entryCtx.module.hir.module.span,
      })
    );
    return;
  }

  ensureEffectsMemory(entryCtx);
  const signatures = collectEffectOperationSignatures(entryCtx, contexts);
  const operationFilter = collectHostBoundaryOperationFilter({
    entryCtx,
    effectfulExports,
  });
  const hostBoundarySignatures = filterSignaturesForHostBoundary({
    entryCtx,
    contexts,
    signatures,
    filter: operationFilter,
  });
  emitMissingEffectIdWarningsForHostBoundary({
    contexts,
    signatures: hostBoundarySignatures,
  });
  const payloadViolations = collectHostBoundaryPayloadViolations({
    signatures: hostBoundarySignatures,
    ctx: entryCtx,
  });
  if (payloadViolations.length > 0) {
    payloadViolations.forEach((violation) => {
      entryCtx.diagnostics.report(
        diagnosticFromCode({
          code: "CG0001",
          params: {
            kind: "codegen-error",
            message: formatHostBoundaryPayloadViolation(violation),
          },
          span: violation.span,
        })
      );
    });
    return;
  }
  const handleOutcome = createHandleOutcomeDynamic({
    ctx: entryCtx,
    runtime: entryCtx.effectsRuntime,
    signatures: hostBoundarySignatures,
  });
  const resumeContinuation = createResumeContinuation({
    ctx: entryCtx,
    runtime: entryCtx.effectsRuntime,
    signatures: hostBoundarySignatures,
  });
  createResumeEffectful({
    ctx: entryCtx,
    runtime: entryCtx.effectsRuntime,
    handleOutcome,
    resumeContinuation,
  });
  ensureEffectResultAccessors({ ctx: entryCtx, runtime: entryCtx.effectsRuntime });

  effectfulExports.forEach(({ meta, exportName }) => {
    createEffectfulEntry({
      ctx: entryCtx,
      runtime: entryCtx.effectsRuntime,
      meta,
      handleOutcome,
      exportName: `${exportName}_effectful`,
    });
  });
};

export const gcTrampolineAbiStrategy: EffectsAbiStrategy = {
  hiddenHandlerParamType,
  hiddenHandlerValue,
  effectfulResultType,
  widenSignature,
  emitHostBoundary,
};
