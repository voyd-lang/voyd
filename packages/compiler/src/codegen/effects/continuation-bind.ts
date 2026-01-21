import binaryen from "binaryen";
import {
  callRef,
  defineStructType,
  initStruct,
  modBinaryenTypeToHeapType,
  refCast,
  refFunc,
  structGetFieldValue,
} from "@voyd/lib/binaryen-gc/index.js";
import type { AugmentedBinaryen } from "@voyd/lib/binaryen-gc/types.js";
import type { CodegenContext } from "../context.js";

const bin = binaryen as unknown as AugmentedBinaryen;

const BIND_STATE_KEY = Symbol("voyd.effects.continuationBind");

type BindState = {
  bindFnName?: string;
  bindFnRefType?: binaryen.Type;
  bindEnvType?: binaryen.Type;
  contCallRefType?: binaryen.Type;
};

const bindState = (ctx: CodegenContext): BindState =>
  ctx.programHelpers.getHelperState(BIND_STATE_KEY, () => ({}));

const ensureContCallRefType = (ctx: CodegenContext): binaryen.Type => {
  const state = bindState(ctx);
  if (state.contCallRefType) return state.contCallRefType;
  const tempName = "__voyd_cont_sig";
  const temp = ctx.mod.addFunction(
    tempName,
    binaryen.createType([binaryen.anyref, binaryen.eqref]),
    ctx.effectsRuntime.outcomeType,
    [],
    ctx.mod.nop()
  );
  const fnType = bin._BinaryenTypeFromHeapType(
    bin._BinaryenFunctionGetType(temp),
    false
  );
  ctx.mod.removeFunction(tempName);
  state.contCallRefType = fnType;
  return fnType;
};

export const ensureContinuationBindFunction = (
  ctx: CodegenContext
): { fnName: string; fnRefType: binaryen.Type; envType: binaryen.Type } => {
  const state = bindState(ctx);
  if (state.bindFnName && state.bindFnRefType && state.bindEnvType) {
    return {
      fnName: state.bindFnName,
      fnRefType: state.bindFnRefType,
      envType: state.bindEnvType,
    };
  }

  const fnName = "__voyd_cont_bind";
  const baseHeapType = modBinaryenTypeToHeapType(
    ctx.mod,
    ctx.effectsRuntime.contEnvBaseType
  );
  const envType = defineStructType(ctx.mod, {
    name: "__voydContBindEnv",
    fields: [
      { name: "site", type: binaryen.i32, mutable: false },
      { name: "handler", type: ctx.effectsRuntime.handlerFrameType, mutable: false },
      { name: "next", type: ctx.effectsRuntime.continuationType, mutable: false },
      { name: "frame", type: ctx.effectsRuntime.continuationType, mutable: false },
    ],
    supertype: baseHeapType,
    final: true,
  });
  const contCallRefType = ensureContCallRefType(ctx);
  const fnRefType = contCallRefType;

  const params = binaryen.createType([binaryen.anyref, binaryen.eqref]);
  const locals: binaryen.Type[] = [ctx.effectsRuntime.outcomeType];
  const outcomeLocal = 0;

  const envRef = () =>
    refCast(
      ctx.mod,
      ctx.mod.local.get(0, binaryen.anyref),
      envType
    );
  const nextCont = () =>
    structGetFieldValue({
      mod: ctx.mod,
      fieldIndex: 2,
      fieldType: ctx.effectsRuntime.continuationType,
      exprRef: envRef(),
    });
  const frameCont = () =>
    structGetFieldValue({
      mod: ctx.mod,
      fieldIndex: 3,
      fieldType: ctx.effectsRuntime.continuationType,
      exprRef: envRef(),
    });

  const callCont = ({
    cont,
    resumeBox,
  }: {
    cont: binaryen.ExpressionRef;
    resumeBox: binaryen.ExpressionRef;
  }): binaryen.ExpressionRef =>
    callRef(
      ctx.mod,
      refCast(
        ctx.mod,
        ctx.effectsRuntime.continuationFn(cont),
        contCallRefType
      ),
      [ctx.effectsRuntime.continuationEnv(cont), resumeBox] as number[],
      ctx.effectsRuntime.outcomeType
    );

  const resumeBox = () => ctx.mod.local.get(1, binaryen.eqref);
  const outcome = () =>
    ctx.mod.local.get(outcomeLocal + 2, ctx.effectsRuntime.outcomeType);

  const initOutcome = ctx.mod.local.set(
    outcomeLocal + 2,
    callCont({ cont: nextCont(), resumeBox: resumeBox() })
  );

  const tag = ctx.effectsRuntime.outcomeTag(outcome());
  const payload = ctx.effectsRuntime.outcomePayload(outcome());

  const callFrame = ctx.mod.return(
    callCont({
      cont: frameCont(),
      resumeBox: payload,
    })
  );

  const wrapEffect = (() => {
    const request = refCast(ctx.mod, payload, ctx.effectsRuntime.effectRequestType);
    const wrappedEnv = initStruct(ctx.mod, envType, [
      ctx.mod.i32.const(-1),
      ctx.effectsRuntime.requestHandler(request),
      ctx.effectsRuntime.requestContinuation(request),
      frameCont(),
    ] as number[]);
    const bindCont = ctx.effectsRuntime.makeContinuation({
      fnRef: refFunc(ctx.mod, fnName, fnRefType),
      env: wrappedEnv,
      site: ctx.mod.i32.const(-1),
    });
    const wrappedReq = ctx.effectsRuntime.makeEffectRequest({
      effectId: ctx.effectsRuntime.requestEffectId(request),
      opId: ctx.effectsRuntime.requestOpId(request),
      opIndex: ctx.effectsRuntime.requestOpIndex(request),
      resumeKind: ctx.effectsRuntime.requestResumeKind(request),
      handle: ctx.effectsRuntime.requestHandle(request),
      args: ctx.effectsRuntime.requestArgs(request),
      continuation: bindCont,
      tailGuard: ctx.effectsRuntime.requestTailGuard(request),
    });
    return ctx.mod.return(ctx.effectsRuntime.makeOutcomeEffect(wrappedReq));
  })();

  const body = ctx.mod.block(null, [
    initOutcome,
    ctx.mod.if(
      ctx.mod.i32.eq(tag, ctx.mod.i32.const(0)),
      callFrame,
      wrapEffect
    ),
  ]);

  ctx.mod.addFunction(
    fnName,
    params,
    ctx.effectsRuntime.outcomeType,
    locals,
    body
  );

  state.bindFnName = fnName;
  state.bindFnRefType = fnRefType;
  state.bindEnvType = envType;
  return { fnName, fnRefType, envType };
};

export const wrapRequestContinuationWithFrame = ({
  ctx,
  request,
  frame,
}: {
  ctx: CodegenContext;
  request: binaryen.ExpressionRef;
  frame: binaryen.ExpressionRef;
}): binaryen.ExpressionRef => {
  const { fnName, fnRefType, envType } = ensureContinuationBindFunction(ctx);
  const env = initStruct(ctx.mod, envType, [
    ctx.mod.i32.const(-1),
    ctx.effectsRuntime.requestHandler(request),
    ctx.effectsRuntime.requestContinuation(request),
    frame,
  ] as number[]);
  const bindCont = ctx.effectsRuntime.makeContinuation({
    fnRef: refFunc(ctx.mod, fnName, fnRefType),
    env,
    site: ctx.mod.i32.const(-1),
  });
  return ctx.effectsRuntime.makeEffectRequest({
    effectId: ctx.effectsRuntime.requestEffectId(request),
    opId: ctx.effectsRuntime.requestOpId(request),
    opIndex: ctx.effectsRuntime.requestOpIndex(request),
    resumeKind: ctx.effectsRuntime.requestResumeKind(request),
    handle: ctx.effectsRuntime.requestHandle(request),
    args: ctx.effectsRuntime.requestArgs(request),
    continuation: bindCont,
    tailGuard: ctx.effectsRuntime.requestTailGuard(request),
  });
};
