import binaryen from "binaryen";
import { callRef, refCast } from "@voyd/lib/binaryen-gc/index.js";
import { getFunctionRefType, wasmTypeFor } from "../../types.js";
import { boxOutcomeValue } from "../outcome-values.js";
import type { CodegenContext } from "../../context.js";
import type { EffectRuntime } from "../runtime-abi.js";
import { ensureDispatcher } from "../dispatcher.js";
import { ensureMsgPackFunctions } from "./msgpack.js";
import { unpackMsgPackValueForType } from "./msgpack-values.js";
import { stateFor } from "./state.js";
import type { EffectOpSignature } from "./types.js";

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
    const msgpack = ensureMsgPackFunctions(ctx);
    const msgPackType = wasmTypeFor(msgpack.msgPackTypeId, ctx);

    const name = `${ctx.moduleLabel}__resume_continuation`;
    const params = binaryen.createType([
      runtime.effectRequestType,
      binaryen.i32,
      binaryen.i32,
    ]);
    const locals: binaryen.Type[] = [
      runtime.tailGuardType,
      runtime.continuationType,
      msgPackType,
    ];
    const requestLocal = 0;
    const bufPtrLocal = 1;
    const resumeLenLocal = 2;
    const guardLocal = 3;
    const contLocal = 4;
    const decodedLocal = 5;
    const opIndexExpr = runtime.requestOpIndex(
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
      const matches = ctx.mod.i32.eq(
        opIndexExpr,
        ctx.mod.i32.const(sig.opIndex)
      );
      const resumeValue =
        sig.returnType === binaryen.none
          ? ctx.mod.nop()
          : unpackMsgPackValueForType({
              value: ctx.mod.local.get(decodedLocal, msgPackType),
              typeId: sig.returnTypeId,
              msgpack,
              ctx,
              label: sig.label,
            });
      const resumeBox =
        sig.returnType === binaryen.none
          ? ctx.mod.ref.null(binaryen.eqref)
          : boxOutcomeValue({
              value: resumeValue,
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
        ctx.mod.local.set(
          decodedLocal,
          ctx.mod.call(
            msgpack.decodeValue.wasmName,
            [
              ctx.mod.local.get(bufPtrLocal, binaryen.i32),
              ctx.mod.local.get(resumeLenLocal, binaryen.i32),
            ],
            msgPackType
          )
        ),
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
  handleOutcome,
  resumeContinuation,
  exportName = "resume_effectful",
}: {
  ctx: CodegenContext;
  runtime: EffectRuntime;
  handleOutcome: string;
  resumeContinuation: string;
  exportName?: string;
}): string =>
  stateFor(ctx, RESUME_EFFECTFUL_KEY, () => {
    const name = `${ctx.moduleLabel}__resume_effectful`;
    const params = binaryen.createType([
      runtime.effectRequestType,
      binaryen.i32,
      binaryen.i32,
      binaryen.i32,
    ]);
    const contParam = 0;
    const bufPtrParam = 1;
    const resumeLenParam = 2;
    const bufCapParam = 3;

    const resumedOutcome = ctx.mod.call(
      resumeContinuation,
      [
        ctx.mod.local.get(contParam, runtime.effectRequestType),
        ctx.mod.local.get(bufPtrParam, binaryen.i32),
        ctx.mod.local.get(resumeLenParam, binaryen.i32),
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
          ctx.mod.local.get(bufCapParam, binaryen.i32),
        ],
        runtime.effectResultType
      )
    );
    ctx.mod.addFunctionExport(name, exportName);
    return name;
  });
