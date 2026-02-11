import binaryen from "binaryen";
import type { CodegenContext } from "../context.js";
import { diagnosticFromCode } from "../../diagnostics/index.js";
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
import type {
  EffectfulExportTarget,
  EffectsAbiStrategy,
} from "./codegen-backend.js";

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
  const handleOutcome = createHandleOutcomeDynamic({
    ctx: entryCtx,
    runtime: entryCtx.effectsRuntime,
    signatures,
  });
  const resumeContinuation = createResumeContinuation({
    ctx: entryCtx,
    runtime: entryCtx.effectsRuntime,
    signatures,
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
