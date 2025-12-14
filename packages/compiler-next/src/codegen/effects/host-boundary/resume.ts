import binaryen from "binaryen";
import { callRef, refCast } from "@voyd/lib/binaryen-gc/index.js";
import { boxOutcomeValue } from "../outcome-values.js";
import type { CodegenContext } from "../../context.js";
import type { EffectRuntime } from "../runtime-abi.js";
import { ensureDispatcher } from "../dispatcher.js";
import { getFunctionRefType } from "../../types.js";
import type { EffectOpSignature, MsgPackImports } from "./types.js";
import { stateFor } from "./state.js";

const RESUME_CONTINUATION_KEY = Symbol("voyd.effects.hostBoundary.resumeContinuation");
const RESUME_EFFECTFUL_KEY = Symbol("voyd.effects.hostBoundary.resumeEffectful");

const functionRefType = ({
  params,
  result,
  ctx,
}: {
  params: readonly binaryen.Type[];
  result: binaryen.Type;
  ctx: CodegenContext;
}): binaryen.Type => getFunctionRefType({ params, result, ctx, label: "host" });

export const createResumeContinuation = ({
  ctx,
  runtime,
  signatures,
  exportName = "resume_continuation",
}: {
  ctx: CodegenContext;
  runtime: EffectRuntime;
  signatures: readonly EffectOpSignature[];
  exportName?: string;
}): string =>
  stateFor(ctx, RESUME_CONTINUATION_KEY, () => {
    const name = `${ctx.moduleLabel}__resume_continuation`;
    const params = binaryen.createType([runtime.effectRequestType, binaryen.i32]);
    const locals: binaryen.Type[] = [runtime.tailGuardType, runtime.continuationType];
    const requestLocal = 0;
    const valueLocal = 1;
    const guardLocal = 2;
    const contLocal = 3;
    const effectIdExpr = runtime.requestEffectId(
      ctx.mod.local.get(requestLocal, runtime.effectRequestType)
    );
    const opIdExpr = runtime.requestOpId(
      ctx.mod.local.get(requestLocal, runtime.effectRequestType)
    );

    const guard = ctx.mod.local.get(guardLocal, runtime.tailGuardType);
    const guardInit = ctx.mod.if(
      ctx.mod.ref.is_null(guard),
      ctx.mod.local.set(guardLocal, runtime.makeTailGuard()),
      ctx.mod.nop()
    );
    const guardOps = [
      ctx.mod.if(
        ctx.mod.i32.and(
          ctx.mod.i32.gt_u(runtime.tailGuardExpected(guard), ctx.mod.i32.const(0)),
          ctx.mod.i32.ge_u(runtime.tailGuardObserved(guard), runtime.tailGuardExpected(guard))
        ),
        ctx.mod.unreachable(),
        ctx.mod.nop()
      ),
      runtime.bumpTailGuardObserved(guard),
    ];

    const contRef = ctx.mod.local.get(contLocal, runtime.continuationType);
    const fnRefType = functionRefType({
      params: [binaryen.anyref, binaryen.eqref],
      result: runtime.outcomeType,
      ctx,
    });
    const branches = signatures.map((sig) => {
      const matches = ctx.mod.i32.and(
        ctx.mod.i32.eq(effectIdExpr, ctx.mod.i32.const(sig.effectId)),
        ctx.mod.i32.eq(opIdExpr, ctx.mod.i32.const(sig.opId))
      );
      const resumeBox =
        sig.returnType === binaryen.none
          ? ctx.mod.ref.null(binaryen.eqref)
          : boxOutcomeValue({
              value: ctx.mod.local.get(valueLocal, sig.returnType),
              valueType: sig.returnType,
              ctx,
            });
      const operands = [runtime.continuationEnv(contRef), resumeBox];
      const call = callRef(
        ctx.mod,
        refCast(ctx.mod, runtime.continuationFn(contRef), fnRefType),
        operands as number[],
        runtime.outcomeType
      );
      return ctx.mod.if(matches, ctx.mod.return(call));
    });

    ctx.mod.addFunction(
      name,
      params,
      runtime.outcomeType,
      locals,
      ctx.mod.block(null, [
        ctx.mod.local.set(
          guardLocal,
          runtime.requestTailGuard(ctx.mod.local.get(requestLocal, runtime.effectRequestType))
        ),
        ctx.mod.local.set(
          contLocal,
          runtime.requestContinuation(ctx.mod.local.get(requestLocal, runtime.effectRequestType))
        ),
        guardInit,
        ...guardOps,
        ...branches,
        ctx.mod.return(
          runtime.makeOutcomeEffect(ctx.mod.local.get(requestLocal, runtime.effectRequestType))
        ),
      ])
    );
    ctx.mod.addFunctionExport(name, exportName);
    return name;
  });

export const createResumeEffectful = ({
  ctx,
  runtime,
  imports,
  handleOutcome,
  resumeContinuation,
  exportName = "resume_effectful",
}: {
  ctx: CodegenContext;
  runtime: EffectRuntime;
  imports: MsgPackImports;
  handleOutcome: string;
  resumeContinuation: string;
  exportName?: string;
}): string =>
  stateFor(ctx, RESUME_EFFECTFUL_KEY, () => {
    const name = `${ctx.moduleLabel}__resume_effectful`;
    const params = binaryen.createType([runtime.effectRequestType, binaryen.i32, binaryen.i32]);
    const contParam = 0;
    const bufPtrParam = 1;
    const bufLenParam = 2;

    const resumedOutcome = ctx.mod.call(
      resumeContinuation,
      [
        ctx.mod.local.get(contParam, runtime.effectRequestType),
        ctx.mod.call(
          imports.readValue,
          [
            ctx.mod.local.get(bufPtrParam, binaryen.i32),
            ctx.mod.local.get(bufLenParam, binaryen.i32),
          ],
          binaryen.i32
        ),
      ],
      runtime.outcomeType
    );

    ctx.mod.addFunction(
      name,
      params,
      runtime.effectResultType,
      [],
      ctx.mod.call(
        handleOutcome,
        [
          ctx.mod.call(
            ensureDispatcher(ctx),
            [resumedOutcome],
            runtime.outcomeType
          ),
          ctx.mod.local.get(bufPtrParam, binaryen.i32),
          ctx.mod.local.get(bufLenParam, binaryen.i32),
        ],
        runtime.effectResultType
      )
    );
    ctx.mod.addFunctionExport(name, exportName);
    return name;
  });

