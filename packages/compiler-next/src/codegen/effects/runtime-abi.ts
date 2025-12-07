import binaryen from "binaryen";
import {
  defineStructType,
  initStruct,
  structGetFieldValue,
  structSetFieldValue,
} from "@voyd/lib/binaryen-gc/index.js";

export const OUTCOME_TAGS = {
  value: 0,
  effect: 1,
} as const;

export const RESUME_KIND = {
  resume: 0,
  tail: 1,
} as const;

const OUTCOME_FIELDS = {
  tag: 0,
  payload: 1,
} as const;

const EFFECT_REQUEST_FIELDS = {
  effectId: 0,
  opId: 1,
  resumeKind: 2,
  args: 3,
  continuation: 4,
  tailGuard: 5,
} as const;

const CONTINUATION_FIELDS = {
  fnRef: 0,
  env: 1,
} as const;

const TAIL_GUARD_FIELDS = {
  expected: 0,
  observed: 1,
} as const;

export type OutcomeTag = (typeof OUTCOME_TAGS)[keyof typeof OUTCOME_TAGS];
export type ResumeKind = (typeof RESUME_KIND)[keyof typeof RESUME_KIND];

export interface EffectRuntime {
  handlerFrameType: binaryen.Type;
  outcomeType: binaryen.Type;
  effectRequestType: binaryen.Type;
  continuationType: binaryen.Type;
  tailGuardType: binaryen.Type;
  makeOutcomeValue: (payload: binaryen.ExpressionRef) => binaryen.ExpressionRef;
  makeOutcomeEffect: (
    request: binaryen.ExpressionRef
  ) => binaryen.ExpressionRef;
  makeHandlerFrame: (params: {
    prev: binaryen.ExpressionRef;
    effectId: binaryen.ExpressionRef;
    opId: binaryen.ExpressionRef;
    resumeKind: binaryen.ExpressionRef;
    clauseFn: binaryen.ExpressionRef;
    clauseEnv: binaryen.ExpressionRef;
    tailExpected: binaryen.ExpressionRef;
    label: binaryen.ExpressionRef;
  }) => binaryen.ExpressionRef;
  outcomeTag: (outcome: binaryen.ExpressionRef) => binaryen.ExpressionRef;
  outcomePayload: (outcome: binaryen.ExpressionRef) => binaryen.ExpressionRef;
  makeEffectRequest: (params: {
    effectId: binaryen.ExpressionRef;
    opId: binaryen.ExpressionRef;
    resumeKind: ResumeKind;
    args: binaryen.ExpressionRef;
    continuation?: binaryen.ExpressionRef;
    tailGuard?: binaryen.ExpressionRef;
  }) => binaryen.ExpressionRef;
  requestEffectId: (request: binaryen.ExpressionRef) => binaryen.ExpressionRef;
  requestOpId: (request: binaryen.ExpressionRef) => binaryen.ExpressionRef;
  requestResumeKind: (
    request: binaryen.ExpressionRef
  ) => binaryen.ExpressionRef;
  requestArgs: (request: binaryen.ExpressionRef) => binaryen.ExpressionRef;
  requestContinuation: (
    request: binaryen.ExpressionRef
  ) => binaryen.ExpressionRef;
  requestTailGuard: (
    request: binaryen.ExpressionRef
  ) => binaryen.ExpressionRef;
  makeContinuation: (params: {
    fnRef: binaryen.ExpressionRef;
    env?: binaryen.ExpressionRef;
  }) => binaryen.ExpressionRef;
  continuationFn: (
    continuation: binaryen.ExpressionRef
  ) => binaryen.ExpressionRef;
  continuationEnv: (
    continuation: binaryen.ExpressionRef
  ) => binaryen.ExpressionRef;
  makeTailGuard: (params?: {
    expected?: number;
    observed?: number;
  }) => binaryen.ExpressionRef;
  tailGuardObserved: (guard: binaryen.ExpressionRef) => binaryen.ExpressionRef;
  tailGuardExpected: (guard: binaryen.ExpressionRef) => binaryen.ExpressionRef;
  bumpTailGuardObserved: (
    guard: binaryen.ExpressionRef
  ) => binaryen.ExpressionRef;
  handlerPrev: (frame: binaryen.ExpressionRef) => binaryen.ExpressionRef;
  handlerEffectId: (frame: binaryen.ExpressionRef) => binaryen.ExpressionRef;
  handlerOpId: (frame: binaryen.ExpressionRef) => binaryen.ExpressionRef;
  handlerResumeKind: (frame: binaryen.ExpressionRef) => binaryen.ExpressionRef;
  handlerClauseFn: (frame: binaryen.ExpressionRef) => binaryen.ExpressionRef;
  handlerClauseEnv: (frame: binaryen.ExpressionRef) => binaryen.ExpressionRef;
  handlerTailExpected: (frame: binaryen.ExpressionRef) => binaryen.ExpressionRef;
  handlerLabel: (frame: binaryen.ExpressionRef) => binaryen.ExpressionRef;
}

export const createEffectRuntime = (mod: binaryen.Module): EffectRuntime => {
  const handlerFrameType = defineStructType(mod, {
    name: "voydHandlerFrame",
    fields: [
      { name: "prev", type: binaryen.eqref, mutable: false },
      { name: "effectId", type: binaryen.i32, mutable: false },
      { name: "opId", type: binaryen.i32, mutable: false },
      { name: "resumeKind", type: binaryen.i32, mutable: false },
      { name: "clauseFn", type: binaryen.funcref, mutable: false },
      { name: "clauseEnv", type: binaryen.anyref, mutable: false },
      { name: "tailExpected", type: binaryen.i32, mutable: false },
      { name: "label", type: binaryen.i32, mutable: false },
    ],
    final: true,
  });
  const continuationType = defineStructType(mod, {
    name: "voydContinuation",
    fields: [
      { name: "fn", type: binaryen.funcref, mutable: false },
      { name: "env", type: binaryen.anyref, mutable: false },
    ],
    final: true,
  });

  const tailGuardType = defineStructType(mod, {
    name: "voydTailGuard",
    fields: [
      { name: "expected", type: binaryen.i32, mutable: false },
      { name: "observed", type: binaryen.i32, mutable: true },
    ],
    final: true,
  });

  const effectRequestType = defineStructType(mod, {
    name: "voydEffectRequest",
    fields: [
      { name: "effectId", type: binaryen.i32, mutable: false },
      { name: "opId", type: binaryen.i32, mutable: false },
      { name: "resumeKind", type: binaryen.i32, mutable: false },
      { name: "args", type: binaryen.eqref, mutable: false },
      { name: "cont", type: continuationType, mutable: false },
      { name: "tailGuard", type: tailGuardType, mutable: false },
    ],
    final: true,
  });

  const outcomeType = defineStructType(mod, {
    name: "voydOutcome",
    fields: [
      { name: "tag", type: binaryen.i32, mutable: false },
      { name: "payload", type: binaryen.eqref, mutable: false },
    ],
    final: true,
  });

  const makeOutcome = (tag: OutcomeTag, payload: binaryen.ExpressionRef) =>
    initStruct(mod, outcomeType, [mod.i32.const(tag), payload]);

  const makeContinuation = ({
    fnRef,
    env = mod.ref.null(binaryen.anyref),
  }: {
    fnRef: binaryen.ExpressionRef;
    env?: binaryen.ExpressionRef;
  }) =>
    initStruct(mod, continuationType, [
      fnRef,
      env,
    ]);

  const makeTailGuard = ({
    expected = 1,
    observed = 0,
  }: {
    expected?: number;
    observed?: number;
  } = {}) =>
    initStruct(mod, tailGuardType, [
      mod.i32.const(expected),
      mod.i32.const(observed),
    ]);

  const makeEffectRequest = ({
    effectId,
    opId,
    resumeKind,
    args,
    continuation = mod.ref.null(continuationType),
    tailGuard = mod.ref.null(tailGuardType),
  }: {
    effectId: binaryen.ExpressionRef;
    opId: binaryen.ExpressionRef;
    resumeKind: ResumeKind;
    args: binaryen.ExpressionRef;
    continuation?: binaryen.ExpressionRef;
    tailGuard?: binaryen.ExpressionRef;
  }) =>
    initStruct(mod, effectRequestType, [
      effectId,
      opId,
      mod.i32.const(resumeKind),
      args,
      continuation,
      tailGuard,
    ]);

  const getOutcomeField = (index: number, type: binaryen.Type) => {
    return (outcome: binaryen.ExpressionRef): binaryen.ExpressionRef =>
      structGetFieldValue({
        mod,
        fieldIndex: index,
        fieldType: type,
        exprRef: outcome,
      });
  };

  const getRequestField = (index: number, type: binaryen.Type) => {
    return (request: binaryen.ExpressionRef): binaryen.ExpressionRef =>
      structGetFieldValue({
        mod,
        fieldIndex: index,
        fieldType: type,
        exprRef: request,
      });
  };

  const getHandlerField = (index: number, type: binaryen.Type) => {
    return (frame: binaryen.ExpressionRef): binaryen.ExpressionRef =>
      structGetFieldValue({
        mod,
        fieldIndex: index,
        fieldType: type,
        exprRef: frame,
      });
  };

  const getContinuationField = (index: number, type: binaryen.Type) => {
    return (continuation: binaryen.ExpressionRef): binaryen.ExpressionRef =>
      structGetFieldValue({
        mod,
        fieldIndex: index,
        fieldType: type,
        exprRef: continuation,
      });
  };

  const getTailGuardField = (index: number, type: binaryen.Type) => {
    return (guard: binaryen.ExpressionRef): binaryen.ExpressionRef =>
      structGetFieldValue({
        mod,
        fieldIndex: index,
        fieldType: type,
        exprRef: guard,
      });
  };

  return {
    handlerFrameType,
    outcomeType,
    effectRequestType,
    continuationType,
    tailGuardType,
    makeOutcomeValue: (payload) => makeOutcome(OUTCOME_TAGS.value, payload),
    makeOutcomeEffect: (request) => makeOutcome(OUTCOME_TAGS.effect, request),
    makeHandlerFrame: ({
      prev,
      effectId,
      opId,
      resumeKind,
      clauseFn,
      clauseEnv,
      tailExpected,
      label,
    }) =>
      initStruct(mod, handlerFrameType, [
        prev,
        effectId,
        opId,
        resumeKind,
        clauseFn,
        clauseEnv,
        tailExpected,
        label,
      ]),
    outcomeTag: getOutcomeField(OUTCOME_FIELDS.tag, binaryen.i32),
    outcomePayload: getOutcomeField(
      OUTCOME_FIELDS.payload,
      binaryen.eqref
    ),
    makeEffectRequest,
    requestEffectId: getRequestField(
      EFFECT_REQUEST_FIELDS.effectId,
      binaryen.i32
    ),
    requestOpId: getRequestField(EFFECT_REQUEST_FIELDS.opId, binaryen.i32),
    requestResumeKind: getRequestField(
      EFFECT_REQUEST_FIELDS.resumeKind,
      binaryen.i32
    ),
    requestArgs: getRequestField(EFFECT_REQUEST_FIELDS.args, binaryen.eqref),
    requestContinuation: getRequestField(
      EFFECT_REQUEST_FIELDS.continuation,
      continuationType
    ),
    requestTailGuard: getRequestField(
      EFFECT_REQUEST_FIELDS.tailGuard,
      tailGuardType
    ),
    makeContinuation,
    continuationFn: getContinuationField(
      CONTINUATION_FIELDS.fnRef,
      binaryen.funcref
    ),
    continuationEnv: getContinuationField(
      CONTINUATION_FIELDS.env,
      binaryen.anyref
    ),
    makeTailGuard,
    tailGuardObserved: getTailGuardField(
      TAIL_GUARD_FIELDS.observed,
      binaryen.i32
    ),
    tailGuardExpected: getTailGuardField(
      TAIL_GUARD_FIELDS.expected,
      binaryen.i32
    ),
    bumpTailGuardObserved: (guard) =>
      structSetFieldValue({
        mod,
        fieldIndex: TAIL_GUARD_FIELDS.observed,
        ref: guard,
        value: mod.i32.add(
          getTailGuardField(TAIL_GUARD_FIELDS.observed, binaryen.i32)(guard),
          mod.i32.const(1)
        ),
      }),
    handlerPrev: getHandlerField(0, binaryen.eqref),
    handlerEffectId: getHandlerField(1, binaryen.i32),
    handlerOpId: getHandlerField(2, binaryen.i32),
    handlerResumeKind: getHandlerField(3, binaryen.i32),
    handlerClauseFn: getHandlerField(4, binaryen.funcref),
    handlerClauseEnv: getHandlerField(5, binaryen.anyref),
    handlerTailExpected: getHandlerField(6, binaryen.i32),
    handlerLabel: getHandlerField(7, binaryen.i32),
  };
};
