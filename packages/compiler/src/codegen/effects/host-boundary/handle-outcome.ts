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
import {
  hostStreamWriterResultTypeId,
  writeDtoValueToHostStream,
  writeHostStreamEvent,
} from "../../boundary/dto-stream-writer.js";
import { EFFECT_RESULT_STATUS } from "./constants.js";
import { writeEffectRequestFrame } from "./effect-request.js";
import { ensureSelectedHostTransportProvider } from "../../host-transport/selected-provider.js";
import { stateFor } from "./state.js";
import type { EffectOpSignature } from "./types.js";
import {
  SELECTED_HOST_FRAME_TAG,
  SELECTED_HOST_FRAME_VERSION,
} from "../../host-transport/frame-codec.js";
import { emitStringLiteral } from "../../expressions/primitives.js";

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
    const writerType = wasmTypeFor(provider.writerTypeId, ctx);

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
      writerType, // writerLocal
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
    const writerLocal = 9;
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

    const writerRef = () => ctx.mod.local.get(writerLocal, writerType);
    const beginWriter = () =>
      ctx.mod.local.set(
        writerLocal,
        ctx.mod.call(
          provider.createWriter.wasmName,
          [
            ctx.mod.local.get(bufPtrLocal, binaryen.i32),
            ctx.mod.local.get(bufLenLocal, binaryen.i32),
          ],
          provider.createWriter.resultType,
        ),
      );
    const finishWriter = () =>
      ctx.mod.local.set(
        payloadLenLocal,
        ctx.mod.call(
          provider.finishWriter.wasmName,
          [writerRef()],
          provider.finishWriter.resultType,
        ),
      );
    const write = (
      name: string,
      args: readonly binaryen.ExpressionRef[] = [],
    ) =>
      writeHostStreamEvent({
        writer: writerRef(),
        writerTypeId: provider.writerTypeId,
        name,
        args,
        ctx,
        fnCtx,
      });
    const dtoWriteResultTypeId = hostStreamWriterResultTypeId({
      writerTypeId: provider.writerTypeId,
      ctx,
    });

    const encodeCompletionToBuffer = ({
      value,
      schema,
    }: {
      value: binaryen.ExpressionRef;
      schema: ReturnType<typeof deriveBoundarySchema>;
    }): binaryen.ExpressionRef => {
      const fingerprint = withDtoFingerprint(schema).fingerprint!;
      return ctx.mod.block(null, [
        beginWriter(),
        write("begin_array", [ctx.mod.i32.const(4)]),
        write("write_i32", [ctx.mod.i32.const(SELECTED_HOST_FRAME_VERSION)]),
        write("write_i32", [
          ctx.mod.if(
            ctx.mod.i32.eq(
              ctx.mod.local.get(completionKindLocal, binaryen.i32),
              ctx.mod.i32.const(HOST_COMPLETION_KIND.export),
            ),
            ctx.mod.i32.const(SELECTED_HOST_FRAME_TAG.exportCompletion),
            ctx.mod.i32.const(SELECTED_HOST_FRAME_TAG.callbackCompletion),
          ),
        ]),
        write("write_i32", [
          ctx.mod.local.get(completionIdLocal, binaryen.i32),
        ]),
        write("begin_array", [ctx.mod.i32.const(2)]),
        write("write_i32", [ctx.mod.i32.const(0)]),
        write("begin_array", [ctx.mod.i32.const(2)]),
        write("write_string", [emitStringLiteral(fingerprint, ctx)]),
        ctx.mod.drop(
          writeDtoValueToHostStream({
            writer: writerRef,
            writerTypeId: provider.writerTypeId,
            value,
            schema,
            resultTypeId: dtoWriteResultTypeId,
            ctx,
            fnCtx,
          }),
        ),
        write("end_array"),
        write("end_array"),
        write("end_array"),
        finishWriter(),
      ]);
    };

    const schemaFor = (typeId: number, label: string) =>
      deriveBoundarySchema({
        typeId,
        ctx,
        label,
        options: { tagStandaloneVariants: true, portableNames: true },
      });

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
            value: ctx.mod.nop(),
            schema: schemaFor(ctx.program.primitives.void, "void completion"),
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
            value: unboxOutcomeValue({
              payload: ctx.mod.local.get(payloadLocal, binaryen.eqref),
              valueType: binaryen.i32,
              typeId: ctx.program.primitives.bool,
              ctx,
            }),
            schema: schemaFor(ctx.program.primitives.bool, "bool completion"),
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
            value: unboxOutcomeValue({
              payload: ctx.mod.local.get(payloadLocal, binaryen.eqref),
              valueType: binaryen.i32,
              ctx,
            }),
            schema: schemaFor(ctx.program.primitives.i32, "i32 completion"),
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
            value: unboxOutcomeValue({
              payload: ctx.mod.local.get(payloadLocal, binaryen.eqref),
              valueType: binaryen.i64,
              ctx,
            }),
            schema: schemaFor(ctx.program.primitives.i64, "i64 completion"),
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
            value: unboxOutcomeValue({
              payload: ctx.mod.local.get(payloadLocal, binaryen.eqref),
              valueType: binaryen.f32,
              ctx,
            }),
            schema: schemaFor(ctx.program.primitives.f32, "f32 completion"),
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
            value: unboxOutcomeValue({
              payload: ctx.mod.local.get(payloadLocal, binaryen.eqref),
              valueType: binaryen.f64,
              ctx,
            }),
            schema: schemaFor(ctx.program.primitives.f64, "f64 completion"),
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
                    value: unboxOutcomeValue({
                      payload: ctx.mod.local.get(payloadLocal, binaryen.eqref),
                      valueType: box.valueType,
                      typeId: box.typeId,
                      ctx,
                    }),
                    schema,
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
      const effectOps = ctx.mod.block(null, [
        beginWriter(),
        writeEffectRequestFrame({
          sig,
          request: () =>
            ctx.mod.local.get(requestLocal, runtime.effectRequestType),
          provider,
          writer: writerRef,
          ctx,
          runtime,
          fnCtx,
        }),
        finishWriter(),
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
