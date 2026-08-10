import binaryen from "binaryen";
import {
  refCast,
  refTest,
  structGetFieldValue,
} from "@voyd-lang/lib/binaryen-gc/index.js";
import { wasmTypeFor } from "../../types.js";
import {
  getOutcomeValueBoxes,
  getOutcomeValueBoxType,
  unboxOutcomeValue,
} from "../outcome-values.js";
import type { CodegenContext, FunctionContext } from "../../context.js";
import type { EffectRuntime } from "../runtime-abi.js";
import {
  BoundarySchemaError,
  deriveBoundarySchema,
  withDtoFingerprint,
} from "../../boundary/schema.js";
import { writeDtoValueToTree } from "../../boundary/dto-tree-codec.js";
import { EFFECT_RESULT_STATUS } from "./constants.js";
import { buildEffectRequestFrame } from "./effect-request.js";
import { ensureSelectedHostTransportProvider } from "../../host-transport/selected-provider.js";
import { stateFor } from "./state.js";
import type { EffectOpSignature } from "./types.js";
import {
  makeSelectedCompletion,
  SELECTED_HOST_FRAME_TAG,
} from "../../host-transport/frame-codec.js";

export const HOST_COMPLETION_KIND = {
  export: 0,
  callback: 1,
} as const;

const HANDLE_OUTCOME_DYNAMIC_KEY = Symbol(
  "voyd.effects.hostBoundary.handleOutcomeDynamic",
);

export const createHandleOutcomeDynamic = ({
  ctx,
  runtime,
  signatures,
  exportName = "handle_outcome",
}: {
  ctx: CodegenContext;
  runtime: EffectRuntime;
  signatures: readonly EffectOpSignature[];
  exportName?: string;
}): string =>
  stateFor(ctx, HANDLE_OUTCOME_DYNAMIC_KEY, () => {
    const provider = ensureSelectedHostTransportProvider(ctx);
    const providerValueType = wasmTypeFor(provider.valueTypeId, ctx);

    const name = `${ctx.moduleLabel}__handle_outcome_dynamic`;
    const params = binaryen.createType([
      runtime.outcomeType,
      binaryen.i32,
      binaryen.i32,
      binaryen.i32,
      binaryen.i32,
    ]);
    const locals: binaryen.Type[] = [
      runtime.effectRequestType, // requestLocal
      binaryen.i32, // opIndexLocal
      binaryen.i32, // payloadLenLocal
      binaryen.eqref, // payloadLocal
      provider.arrayWithCapacity.resultType, // arrayLocal
    ];
    const outcomeLocal = 0;
    const bufPtrLocal = 1;
    const bufLenLocal = 2;
    const completionKindLocal = 3;
    const completionIdLocal = 4;
    const requestLocal = 5;
    const opIndexLocal = 6;
    const payloadLenLocal = 7;
    const payloadLocal = 8;
    const arrayLocal = 9;
    const fnCtx: FunctionContext = {
      bindings: new Map(),
      tempLocals: new Map(),
      locals,
      nextLocalIndex: 10,
      returnTypeId: ctx.program.primitives.void,
      effectful: false,
    };

    const boxTypeI32 = getOutcomeValueBoxType({ valueType: binaryen.i32, ctx });
    const boxTypeBool = getOutcomeValueBoxType({
      valueType: binaryen.i32,
      typeId: ctx.program.primitives.bool,
      ctx,
    });
    const boxTypeI64 = getOutcomeValueBoxType({ valueType: binaryen.i64, ctx });
    const boxTypeF32 = getOutcomeValueBoxType({ valueType: binaryen.f32, ctx });
    const boxTypeF64 = getOutcomeValueBoxType({ valueType: binaryen.f64, ctx });
    const isFixedBox = ({
      valueType,
      typeId,
    }: {
      valueType: binaryen.Type;
      typeId?: number;
    }): boolean =>
      (typeId === undefined &&
        (valueType === binaryen.i32 ||
          valueType === binaryen.i64 ||
          valueType === binaryen.f32 ||
          valueType === binaryen.f64 ||
          valueType === providerValueType)) ||
      (typeId === ctx.program.primitives.bool && valueType === binaryen.i32);

    const matchesMarkedBox = ({
      boxType,
      markerFieldIndex,
      markerValue,
    }: {
      boxType: binaryen.Type;
      markerFieldIndex: number;
      markerValue: number;
    }): binaryen.ExpressionRef =>
      ctx.mod.if(
        refTest(
          ctx.mod,
          ctx.mod.local.get(payloadLocal, binaryen.eqref),
          boxType,
        ),
        ctx.mod.i32.eq(
          structGetFieldValue({
            mod: ctx.mod,
            fieldIndex: markerFieldIndex,
            fieldType: binaryen.i32,
            exprRef: refCast(
              ctx.mod,
              ctx.mod.local.get(payloadLocal, binaryen.eqref),
              boxType,
            ),
          }),
          ctx.mod.i32.const(markerValue),
        ),
        ctx.mod.i32.const(0),
      );

    const encodeTransportValueToBuffer = (
      value: binaryen.ExpressionRef,
    ): binaryen.ExpressionRef =>
      ctx.mod.block(null, [
        ctx.mod.local.set(
          payloadLenLocal,
          ctx.mod.call(
            provider.encodeValue.wasmName,
            [
              value,
              ctx.mod.local.get(bufPtrLocal, binaryen.i32),
              ctx.mod.local.get(bufLenLocal, binaryen.i32),
            ],
            binaryen.i32,
          ),
        ),
      ]);

    const encodeCompletionToBuffer = ({
      value,
      fingerprint,
    }: {
      value: binaryen.ExpressionRef;
      fingerprint: string;
    }): binaryen.ExpressionRef =>
      encodeTransportValueToBuffer(
        makeSelectedCompletion({
          frameTag: ctx.mod.call(
            provider.makeI32.wasmName,
            [
              ctx.mod.if(
                ctx.mod.i32.eq(
                  ctx.mod.local.get(completionKindLocal, binaryen.i32),
                  ctx.mod.i32.const(HOST_COMPLETION_KIND.export),
                ),
                ctx.mod.i32.const(SELECTED_HOST_FRAME_TAG.exportCompletion),
                ctx.mod.i32.const(SELECTED_HOST_FRAME_TAG.callbackCompletion),
              ),
            ],
            providerValueType,
          ),
          identity: ctx.mod.call(
            provider.makeI32.wasmName,
            [ctx.mod.local.get(completionIdLocal, binaryen.i32)],
            providerValueType,
          ),
          fingerprint,
          value,
          ctx,
          fnCtx,
          provider: provider,
        }),
      );

    const fingerprintFor = (typeId: number, label: string): string =>
      withDtoFingerprint(deriveBoundarySchema({ typeId, ctx, label }))
        .fingerprint!;

    const finishValue = (): binaryen.ExpressionRef =>
      ctx.mod.return(
        runtime.makeEffectResult({
          status: ctx.mod.i32.const(EFFECT_RESULT_STATUS.value),
          cont: ctx.mod.ref.null(binaryen.anyref),
          payloadLen: ctx.mod.local.get(payloadLenLocal, binaryen.i32),
        }),
      );

    const valueOps: binaryen.ExpressionRef[] = [
      ctx.mod.local.set(
        payloadLocal,
        runtime.outcomePayload(
          ctx.mod.local.get(outcomeLocal, runtime.outcomeType),
        ),
      ),
      ctx.mod.if(
        ctx.mod.ref.is_null(ctx.mod.local.get(payloadLocal, binaryen.eqref)),
        ctx.mod.block(null, [
          encodeCompletionToBuffer({
            value: ctx.mod.call(provider.makeNull.wasmName, [], providerValueType),
            fingerprint: fingerprintFor(
              ctx.program.primitives.void,
              "void completion",
            ),
          }),
          finishValue(),
        ]),
      ),
      ctx.mod.if(
        matchesMarkedBox({
          boxType: boxTypeBool,
          markerFieldIndex: 1,
          markerValue: ctx.program.primitives.bool,
        }),
        ctx.mod.block(null, [
          encodeCompletionToBuffer({
            value: ctx.mod.call(
              provider.makeBool.wasmName,
              [
                unboxOutcomeValue({
                  payload: ctx.mod.local.get(payloadLocal, binaryen.eqref),
                  valueType: binaryen.i32,
                  typeId: ctx.program.primitives.bool,
                  ctx,
                }),
              ],
              providerValueType,
            ),
            fingerprint: fingerprintFor(
              ctx.program.primitives.bool,
              "bool completion",
            ),
          }),
          finishValue(),
        ]),
      ),
      ctx.mod.if(
        refTest(
          ctx.mod,
          ctx.mod.local.get(payloadLocal, binaryen.eqref),
          boxTypeI32,
        ),
        ctx.mod.block(null, [
          encodeCompletionToBuffer({
            value: ctx.mod.call(
              provider.makeI32.wasmName,
              [
                unboxOutcomeValue({
                  payload: ctx.mod.local.get(payloadLocal, binaryen.eqref),
                  valueType: binaryen.i32,
                  ctx,
                }),
              ],
              providerValueType,
            ),
            fingerprint: fingerprintFor(
              ctx.program.primitives.i32,
              "i32 completion",
            ),
          }),
          finishValue(),
        ]),
      ),
      ctx.mod.if(
        refTest(
          ctx.mod,
          ctx.mod.local.get(payloadLocal, binaryen.eqref),
          boxTypeI64,
        ),
        ctx.mod.block(null, [
          encodeCompletionToBuffer({
            value: ctx.mod.call(
              provider.makeI64.wasmName,
              [
                unboxOutcomeValue({
                  payload: ctx.mod.local.get(payloadLocal, binaryen.eqref),
                  valueType: binaryen.i64,
                  ctx,
                }),
              ],
              providerValueType,
            ),
            fingerprint: fingerprintFor(
              ctx.program.primitives.i64,
              "i64 completion",
            ),
          }),
          finishValue(),
        ]),
      ),
      ctx.mod.if(
        refTest(
          ctx.mod,
          ctx.mod.local.get(payloadLocal, binaryen.eqref),
          boxTypeF32,
        ),
        ctx.mod.block(null, [
          encodeCompletionToBuffer({
            value: ctx.mod.call(
              provider.makeF32.wasmName,
              [
                unboxOutcomeValue({
                  payload: ctx.mod.local.get(payloadLocal, binaryen.eqref),
                  valueType: binaryen.f32,
                  ctx,
                }),
              ],
              providerValueType,
            ),
            fingerprint: fingerprintFor(
              ctx.program.primitives.f32,
              "f32 completion",
            ),
          }),
          finishValue(),
        ]),
      ),
      ctx.mod.if(
        refTest(
          ctx.mod,
          ctx.mod.local.get(payloadLocal, binaryen.eqref),
          boxTypeF64,
        ),
        ctx.mod.block(null, [
          encodeCompletionToBuffer({
            value: ctx.mod.call(
              provider.makeF64.wasmName,
              [
                unboxOutcomeValue({
                  payload: ctx.mod.local.get(payloadLocal, binaryen.eqref),
                  valueType: binaryen.f64,
                  ctx,
                }),
              ],
              providerValueType,
            ),
            fingerprint: fingerprintFor(
              ctx.program.primitives.f64,
              "f64 completion",
            ),
          }),
          finishValue(),
        ]),
      ),
      ...getOutcomeValueBoxes(ctx)
        .filter(
          (box) =>
            typeof box.typeId === "number" &&
            box.valueType !== binaryen.none &&
            !isFixedBox(box),
        )
        .flatMap((box) => {
          const markerValue = box.markerValue;
          if (typeof markerValue !== "number") {
            return [];
          }
          const matchesBox = matchesMarkedBox({
            boxType: box.boxType,
            markerFieldIndex: box.abiTypes.length,
            markerValue,
          });
          try {
            const schema = deriveBoundarySchema({
              typeId: box.typeId!,
              ctx,
              label: "task outcome",
            });
            return [
              ctx.mod.if(
                matchesBox,
                ctx.mod.block(null, [
                  encodeCompletionToBuffer({
                    value: writeDtoValueToTree({
                      value: unboxOutcomeValue({
                        payload: ctx.mod.local.get(
                          payloadLocal,
                          binaryen.eqref,
                        ),
                        valueType: box.valueType,
                        typeId: box.typeId,
                        ctx,
                      }),
                      schema,
                      ctx,
                      fnCtx,
                      provider: provider,
                    }),
                    fingerprint: withDtoFingerprint(schema).fingerprint!,
                  }),
                  finishValue(),
                ]),
              ),
            ];
          } catch (error) {
            if (error instanceof BoundarySchemaError) {
              return [];
            }
            throw error;
          }
        }),
      ctx.mod.unreachable(),
    ];

    const branches = signatures.map((sig) => {
      const matches = ctx.mod.i32.eq(
        ctx.mod.local.get(opIndexLocal, binaryen.i32),
        ctx.mod.i32.const(sig.opIndex),
      );
      const requestFrame = buildEffectRequestFrame({
        sig,
        request: () =>
          ctx.mod.local.get(requestLocal, runtime.effectRequestType),
        provider: provider,
        arrayLocal,
        ctx,
        runtime,
        fnCtx,
      });

      const effectOps = ctx.mod.block(null, [
        encodeTransportValueToBuffer(requestFrame),
        ctx.mod.return(
          runtime.makeEffectResult({
            status: ctx.mod.i32.const(EFFECT_RESULT_STATUS.effect),
            cont: ctx.mod.local.get(requestLocal, runtime.effectRequestType),
            payloadLen: ctx.mod.local.get(payloadLenLocal, binaryen.i32),
          }),
        ),
      ]);

      return ctx.mod.if(matches, effectOps);
    });

    const effectOps: binaryen.ExpressionRef[] = [
      ctx.mod.local.set(
        requestLocal,
        refCast(
          ctx.mod,
          runtime.outcomePayload(
            ctx.mod.local.get(outcomeLocal, runtime.outcomeType),
          ),
          runtime.effectRequestType,
        ),
      ),
      ctx.mod.local.set(
        opIndexLocal,
        runtime.requestOpIndex(
          ctx.mod.local.get(requestLocal, runtime.effectRequestType),
        ),
      ),
      ...branches,
      ctx.mod.unreachable(),
    ];

    ctx.mod.addFunction(
      name,
      params,
      runtime.effectResultType,
      locals,
      ctx.mod.block(null, [
        ctx.mod.if(
          ctx.mod.i32.eq(
            runtime.outcomeTag(
              ctx.mod.local.get(outcomeLocal, runtime.outcomeType),
            ),
            ctx.mod.i32.const(EFFECT_RESULT_STATUS.value),
          ),
          ctx.mod.block(null, valueOps),
          ctx.mod.block(null, effectOps),
        ),
      ]),
    );

    ctx.mod.addFunctionExport(name, exportName);
    return name;
  });
