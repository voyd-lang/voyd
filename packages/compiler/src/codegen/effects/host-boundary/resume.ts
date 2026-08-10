import binaryen from "binaryen";
import {
  arrayGet,
  callRef,
  refCast,
} from "@voyd-lang/lib/binaryen-gc/index.js";
import {
  getFunctionRefType,
  getRequiredExprType,
  wasmTypeFor,
} from "../../types.js";
import { boxOutcomeValue } from "../outcome-values.js";
import type { CodegenContext, FunctionContext } from "../../context.js";
import type { EffectRuntime } from "../runtime-abi.js";
import { ensureDispatcher } from "../dispatcher.js";
import { ensureSelectedHostTransportProvider } from "../../host-transport/selected-provider.js";
import { readProviderValueForType } from "./provider-values.js";
import { readDtoValueFromTree } from "../../boundary/dto-tree-codec.js";
import { hostBoundaryPayloadSupportForType } from "./payload-compatibility.js";
import { stateFor } from "./state.js";
import type { EffectOpSignature } from "./types.js";
import type { ContinuationSite } from "../effect-lowering/types.js";
import {
  SELECTED_HOST_FRAME_TAG,
  SELECTED_HOST_FRAME_VERSION,
} from "../../host-transport/frame-codec.js";

const RESUME_CONTINUATION_KEY = Symbol(
  "voyd.effects.hostBoundary.resumeContinuation",
);
const RESUME_EFFECTFUL_KEY = Symbol(
  "voyd.effects.hostBoundary.resumeEffectful",
);
const RESUME_EFFECTFUL_RAW_KEY = Symbol(
  "voyd.effects.hostBoundary.resumeEffectfulRaw",
);
const END_REQUEST_RAW_KEY = Symbol("voyd.effects.hostBoundary.endRequestRaw");

const ownerReturnTypeId = ({
  site,
  ctx,
}: {
  site: ContinuationSite;
  ctx: CodegenContext;
}) => {
  if (typeof site.ownerReturnTypeId === "number") {
    return site.ownerReturnTypeId;
  }

  if (site.owner.kind === "function") {
    const metas = ctx.functions.get(ctx.moduleId)?.get(site.owner.symbol);
    const meta = metas?.[0];
    if (meta) {
      return meta.resultTypeId;
    }
    throw new Error("missing function metadata for continuation site owner");
  }

  if (site.owner.kind === "lambda") {
    const expr = ctx.module.hir.expressions.get(site.owner.exprId);
    if (!expr || expr.exprKind !== "lambda") {
      throw new Error("missing lambda owner for continuation site");
    }
    const lambdaType = ctx.program.types.getTypeDesc(
      getRequiredExprType(site.owner.exprId, ctx),
    );
    if (lambdaType.kind !== "function") {
      throw new Error("lambda continuation owner must have a function type");
    }
    return lambdaType.returnType;
  }

  const handlerExpr = ctx.module.hir.expressions.get(site.owner.handlerExprId);
  if (!handlerExpr || handlerExpr.exprKind !== "effect-handler") {
    throw new Error("missing handler owner for continuation site");
  }
  const clause = handlerExpr.handlers[site.owner.clauseIndex];
  if (!clause) {
    throw new Error("missing handler clause owner for continuation site");
  }
  return getRequiredExprType(clause.body, ctx);
};

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
    const provider = ensureSelectedHostTransportProvider(ctx);
    const providerValueType = wasmTypeFor(provider.valueTypeId, ctx);
    const arrayType = provider.unpackArray.resultType;
    const storageType = provider.arrayRawStorage.resultType;

    const name = `${ctx.moduleLabel}__resume_continuation`;
    const params = binaryen.createType([
      runtime.effectRequestType,
      binaryen.i32,
      binaryen.i32,
    ]);
    const locals: binaryen.Type[] = [
      runtime.tailGuardType,
      runtime.continuationType,
      providerValueType,
      arrayType,
      storageType,
      arrayType,
      storageType,
      arrayType,
      storageType,
    ];
    const scratch: FunctionContext = {
      bindings: new Map(),
      tempLocals: new Map(),
      locals,
      nextLocalIndex: binaryen.expandType(params).length + locals.length,
      returnTypeId: ctx.program.primitives.void,
      effectful: false,
    };
    const requestLocal = 0;
    const bufPtrLocal = 1;
    const resumeLenLocal = 2;
    const guardLocal = 3;
    const contLocal = 4;
    const decodedLocal = 5;
    const frameArrayLocal = 6;
    const frameStorageLocal = 7;
    const outcomeArrayLocal = 8;
    const outcomeStorageLocal = 9;
    const typedPayloadArrayLocal = 10;
    const typedPayloadStorageLocal = 11;
    const opIndexExpr = (): binaryen.ExpressionRef =>
      runtime.requestOpIndex(
        ctx.mod.local.get(requestLocal, runtime.effectRequestType),
      );

    const guard = (): binaryen.ExpressionRef =>
      ctx.mod.local.get(guardLocal, runtime.tailGuardType);
    const frameField = (index: number): binaryen.ExpressionRef =>
      arrayGet(
        ctx.mod,
        ctx.mod.local.get(frameStorageLocal, storageType),
        ctx.mod.i32.const(index),
        providerValueType,
        false,
      );
    const outcomeField = (index: number): binaryen.ExpressionRef =>
      arrayGet(
        ctx.mod,
        ctx.mod.local.get(outcomeStorageLocal, storageType),
        ctx.mod.i32.const(index),
        providerValueType,
        false,
      );
    const typedPayloadField = (index: number): binaryen.ExpressionRef =>
      arrayGet(
        ctx.mod,
        ctx.mod.local.get(typedPayloadStorageLocal, storageType),
        ctx.mod.i32.const(index),
        providerValueType,
        false,
      );
    const guardInit = ctx.mod.if(
      ctx.mod.ref.is_null(guard()),
      ctx.mod.local.set(guardLocal, runtime.makeTailGuard()),
      ctx.mod.nop(),
    );
    const guardOps = [
      ctx.mod.if(
        ctx.mod.i32.and(
          ctx.mod.i32.gt_u(
            runtime.tailGuardExpected(guard()),
            ctx.mod.i32.const(0),
          ),
          ctx.mod.i32.ge_u(
            runtime.tailGuardObserved(guard()),
            runtime.tailGuardExpected(guard()),
          ),
        ),
        ctx.mod.unreachable(),
        ctx.mod.nop(),
      ),
      runtime.bumpTailGuardObserved(guard()),
    ];

    const contRef = (): binaryen.ExpressionRef =>
      ctx.mod.local.get(contLocal, runtime.continuationType);
    const fnRefType = functionRefType({
      params: [binaryen.anyref, binaryen.eqref],
      result: runtime.outcomeType,
      ctx,
    });
    const branches = signatures.map((sig) => {
      const matches = ctx.mod.i32.eq(
        opIndexExpr(),
        ctx.mod.i32.const(sig.opIndex),
      );
      const resumeValue =
        sig.returnType === binaryen.none
          ? ctx.mod.nop()
          : sig.externalBoundary
            ? readDtoValueFromTree({
                value: ctx.mod.local.get(decodedLocal, providerValueType),
                schema: sig.externalBoundary.result,
                ctx,
                fnCtx: scratch,
                provider: provider,
              })
            : readProviderValueForType({
                value: ctx.mod.local.get(decodedLocal, providerValueType),
                typeId: sig.returnTypeId,
                provider: provider,
                ctx,
                fnCtx: scratch,
                label: sig.label,
              });
      const resumeBox =
        sig.returnType === binaryen.none
          ? ctx.mod.ref.null(binaryen.eqref)
          : boxOutcomeValue({
              value: resumeValue,
              valueType: sig.returnType,
              typeId: sig.returnTypeId,
              ctx,
              fnCtx: scratch,
            });
      const operands = [runtime.continuationEnv(contRef()), resumeBox];
      const call = callRef(
        ctx.mod,
        refCast(ctx.mod, runtime.continuationFn(contRef()), fnRefType),
        operands as number[],
        runtime.outcomeType,
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
          runtime.requestTailGuard(
            ctx.mod.local.get(requestLocal, runtime.effectRequestType),
          ),
        ),
        ctx.mod.local.set(
          contLocal,
          runtime.requestContinuation(
            ctx.mod.local.get(requestLocal, runtime.effectRequestType),
          ),
        ),
        guardInit,
        ...guardOps,
        ctx.mod.local.set(
          decodedLocal,
          ctx.mod.call(
            provider.decodeValue.wasmName,
            [
              ctx.mod.local.get(bufPtrLocal, binaryen.i32),
              ctx.mod.local.get(resumeLenLocal, binaryen.i32),
            ],
            providerValueType,
          ),
        ),
        ctx.mod.local.set(
          frameArrayLocal,
          ctx.mod.call(
            provider.unpackArray.wasmName,
            [ctx.mod.local.get(decodedLocal, providerValueType)],
            arrayType,
          ),
        ),
        ctx.mod.local.set(
          frameStorageLocal,
          ctx.mod.call(
            provider.arrayRawStorage.wasmName,
            [ctx.mod.local.get(frameArrayLocal, arrayType)],
            storageType,
          ),
        ),
        ctx.mod.if(
          ctx.mod.i32.or(
            ctx.mod.i32.or(
              ctx.mod.i32.ne(
                ctx.mod.call(
                  provider.unpackI32.wasmName,
                  [frameField(0)],
                  binaryen.i32,
                ),
                ctx.mod.i32.const(SELECTED_HOST_FRAME_VERSION),
              ),
              ctx.mod.i32.ne(
                ctx.mod.call(
                  provider.unpackI32.wasmName,
                  [frameField(1)],
                  binaryen.i32,
                ),
                ctx.mod.i32.const(SELECTED_HOST_FRAME_TAG.effectOutcome),
              ),
            ),
            ctx.mod.i32.ne(
              ctx.mod.call(
                provider.unpackI32.wasmName,
                [frameField(2)],
                binaryen.i32,
              ),
              opIndexExpr(),
            ),
          ),
          ctx.mod.unreachable(),
          ctx.mod.nop(),
        ),
        ctx.mod.local.set(
          outcomeArrayLocal,
          ctx.mod.call(
            provider.unpackArray.wasmName,
            [frameField(3)],
            arrayType,
          ),
        ),
        ctx.mod.local.set(
          outcomeStorageLocal,
          ctx.mod.call(
            provider.arrayRawStorage.wasmName,
            [ctx.mod.local.get(outcomeArrayLocal, arrayType)],
            storageType,
          ),
        ),
        ctx.mod.if(
          ctx.mod.i32.ne(
            ctx.mod.call(
              provider.unpackI32.wasmName,
              [outcomeField(0)],
              binaryen.i32,
            ),
            ctx.mod.i32.const(0),
          ),
          ctx.mod.unreachable(),
          ctx.mod.nop(),
        ),
        ctx.mod.local.set(
          typedPayloadArrayLocal,
          ctx.mod.call(
            provider.unpackArray.wasmName,
            [outcomeField(1)],
            arrayType,
          ),
        ),
        ctx.mod.local.set(
          typedPayloadStorageLocal,
          ctx.mod.call(
            provider.arrayRawStorage.wasmName,
            [ctx.mod.local.get(typedPayloadArrayLocal, arrayType)],
            storageType,
          ),
        ),
        ctx.mod.local.set(decodedLocal, typedPayloadField(1)),
        ...branches,
        ctx.mod.return(
          runtime.makeOutcomeEffect(
            ctx.mod.local.get(requestLocal, runtime.effectRequestType),
          ),
        ),
      ]),
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
      binaryen.i32,
      binaryen.i32,
    ]);
    const contParam = 0;
    const bufPtrParam = 1;
    const resumeLenParam = 2;
    const bufCapParam = 3;
    const completionKindParam = 4;
    const completionIdParam = 5;

    const resumedOutcome = ctx.mod.call(
      resumeContinuation,
      [
        ctx.mod.local.get(contParam, runtime.effectRequestType),
        ctx.mod.local.get(bufPtrParam, binaryen.i32),
        ctx.mod.local.get(resumeLenParam, binaryen.i32),
      ],
      runtime.outcomeType,
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
            runtime.outcomeType,
          ),
          ctx.mod.local.get(bufPtrParam, binaryen.i32),
          ctx.mod.local.get(bufCapParam, binaryen.i32),
          ctx.mod.local.get(completionKindParam, binaryen.i32),
          ctx.mod.local.get(completionIdParam, binaryen.i32),
        ],
        runtime.effectResultType,
      ),
    );
    ctx.mod.addFunctionExport(name, exportName);
    return name;
  });

export const createResumeEffectfulRaw = ({
  ctx,
  runtime,
  resumeContinuation,
  exportName = "resume_effectful_raw",
}: {
  ctx: CodegenContext;
  runtime: EffectRuntime;
  resumeContinuation: string;
  exportName?: string;
}): string =>
  stateFor(ctx, RESUME_EFFECTFUL_RAW_KEY, () => {
    const name = `${ctx.moduleLabel}__resume_effectful_raw`;
    const params = binaryen.createType([
      runtime.effectRequestType,
      binaryen.i32,
      binaryen.i32,
    ]);
    const resumedOutcome = ctx.mod.call(
      resumeContinuation,
      [
        ctx.mod.local.get(0, runtime.effectRequestType),
        ctx.mod.local.get(1, binaryen.i32),
        ctx.mod.local.get(2, binaryen.i32),
      ],
      runtime.outcomeType,
    );

    ctx.mod.addFunction(
      name,
      params,
      runtime.outcomeType,
      [],
      ctx.mod.call(
        ensureDispatcher(ctx),
        [resumedOutcome],
        runtime.outcomeType,
      ),
    );
    ctx.mod.addFunctionExport(name, exportName);
    return name;
  });

export const createEndRequestRaw = ({
  ctx,
  runtime,
  signatures,
  exportName = "end_request_raw",
}: {
  ctx: CodegenContext;
  runtime: EffectRuntime;
  signatures: readonly EffectOpSignature[];
  exportName?: string;
}): string =>
  stateFor(ctx, END_REQUEST_RAW_KEY, () => {
    const provider = ensureSelectedHostTransportProvider(ctx);
    const providerValueType = wasmTypeFor(provider.valueTypeId, ctx);
    const arrayType = provider.unpackArray.resultType;
    const storageType = provider.arrayRawStorage.resultType;
    const specializedSites = [...ctx.effectsState.contSiteByKey.values()];
    const specializedSiteIds = new Set(
      specializedSites.map((site) => site.siteId),
    );
    // A specialized site replaces its generic template in emitted code. The
    // template can still contain unresolved owner types, so it cannot safely
    // participate in host-boundary payload decoding.
    const endSites = [
      ...specializedSites,
      ...ctx.effectLowering.sites.filter(
        (site) => !specializedSiteIds.has(site.siteId),
      ),
    ].reduce(
      (sites, variant) => {
        if (sites.some((site) => site.siteOrder === variant.siteOrder)) {
          return sites;
        }
        const typeId = ownerReturnTypeId({ site: variant, ctx });
        return [
          ...sites,
          {
            siteOrder: variant.siteOrder,
            typeId,
            support: hostBoundaryPayloadSupportForType({
              typeId,
              ctx,
            }),
          },
        ];
      },
      [] as Array<{
        siteOrder: number;
        typeId: number;
        support: ReturnType<typeof hostBoundaryPayloadSupportForType>;
      }>,
    );

    const name = `${ctx.moduleLabel}__end_request_raw`;
    const params = binaryen.createType([
      runtime.effectRequestType,
      binaryen.i32,
      binaryen.i32,
    ]);
    const locals: binaryen.Type[] = [
      providerValueType,
      arrayType,
      storageType,
      arrayType,
      storageType,
      arrayType,
      storageType,
    ];
    const scratch: FunctionContext = {
      bindings: new Map(),
      tempLocals: new Map(),
      locals,
      nextLocalIndex: binaryen.expandType(params).length + locals.length,
      returnTypeId: ctx.program.primitives.void,
      effectful: false,
    };
    const requestLocal = 0;
    const bufPtrLocal = 1;
    const resumeLenLocal = 2;
    const decodedLocal = 3;
    const frameArrayLocal = 4;
    const frameStorageLocal = 5;
    const outcomeArrayLocal = 6;
    const outcomeStorageLocal = 7;
    const typedPayloadArrayLocal = 8;
    const typedPayloadStorageLocal = 9;
    const opIndexExpr = (): binaryen.ExpressionRef =>
      runtime.requestOpIndex(
        ctx.mod.local.get(requestLocal, runtime.effectRequestType),
      );
    const continuationSiteExpr = (): binaryen.ExpressionRef =>
      runtime.continuationSite(
        runtime.requestContinuation(
          ctx.mod.local.get(requestLocal, runtime.effectRequestType),
        ),
      );

    const decodedValue = (): binaryen.ExpressionRef =>
      ctx.mod.local.get(decodedLocal, providerValueType);
    const frameField = (index: number): binaryen.ExpressionRef =>
      arrayGet(
        ctx.mod,
        ctx.mod.local.get(frameStorageLocal, storageType),
        ctx.mod.i32.const(index),
        providerValueType,
        false,
      );
    const outcomeField = (index: number): binaryen.ExpressionRef =>
      arrayGet(
        ctx.mod,
        ctx.mod.local.get(outcomeStorageLocal, storageType),
        ctx.mod.i32.const(index),
        providerValueType,
        false,
      );
    const typedPayloadField = (index: number): binaryen.ExpressionRef =>
      arrayGet(
        ctx.mod,
        ctx.mod.local.get(typedPayloadStorageLocal, storageType),
        ctx.mod.i32.const(index),
        providerValueType,
        false,
      );

    const siteBranches = endSites.map((siteInfo) => {
      const matches = ctx.mod.i32.eq(
        continuationSiteExpr(),
        ctx.mod.i32.const(siteInfo.siteOrder),
      );
      if (!siteInfo.support.supported) {
        return ctx.mod.if(matches, ctx.mod.unreachable());
      }

      const returnType = wasmTypeFor(siteInfo.typeId, ctx);
      const payload =
        returnType === binaryen.none
          ? ctx.mod.ref.null(binaryen.eqref)
          : boxOutcomeValue({
              value: readProviderValueForType({
                value: decodedValue(),
                typeId: siteInfo.typeId,
                provider: provider,
                ctx,
                fnCtx: scratch,
                label: `end_request_raw(site ${siteInfo.siteOrder})`,
              }),
              valueType: returnType,
              typeId: siteInfo.typeId,
              ctx,
              fnCtx: scratch,
            });
      return ctx.mod.if(
        matches,
        ctx.mod.return(runtime.makeOutcomeValue(payload)),
      );
    });

    const signatureBranches = signatures.map((sig) => {
      const matches = ctx.mod.i32.eq(
        opIndexExpr(),
        ctx.mod.i32.const(sig.opIndex),
      );
      const payload =
        sig.returnType === binaryen.none
          ? ctx.mod.ref.null(binaryen.eqref)
          : boxOutcomeValue({
              value: sig.externalBoundary
                ? readDtoValueFromTree({
                    value: decodedValue(),
                    schema: sig.externalBoundary.result,
                    ctx,
                    fnCtx: scratch,
                    provider: provider,
                  })
                : readProviderValueForType({
                    value: decodedValue(),
                    typeId: sig.returnTypeId,
                    provider: provider,
                    ctx,
                    fnCtx: scratch,
                    label: sig.label,
                  }),
              valueType: sig.returnType,
              typeId: sig.returnTypeId,
              ctx,
              fnCtx: scratch,
            });
      return ctx.mod.if(
        matches,
        ctx.mod.return(runtime.makeOutcomeValue(payload)),
      );
    });

    ctx.mod.addFunction(
      name,
      params,
      runtime.outcomeType,
      locals,
      ctx.mod.block(null, [
        ctx.mod.local.set(
          decodedLocal,
          ctx.mod.call(
            provider.decodeValue.wasmName,
            [
              ctx.mod.local.get(bufPtrLocal, binaryen.i32),
              ctx.mod.local.get(resumeLenLocal, binaryen.i32),
            ],
            providerValueType,
          ),
        ),
        ctx.mod.local.set(
          frameArrayLocal,
          ctx.mod.call(
            provider.unpackArray.wasmName,
            [ctx.mod.local.get(decodedLocal, providerValueType)],
            arrayType,
          ),
        ),
        ctx.mod.local.set(
          frameStorageLocal,
          ctx.mod.call(
            provider.arrayRawStorage.wasmName,
            [ctx.mod.local.get(frameArrayLocal, arrayType)],
            storageType,
          ),
        ),
        ctx.mod.if(
          ctx.mod.i32.or(
            ctx.mod.i32.or(
              ctx.mod.i32.ne(
                ctx.mod.call(
                  provider.unpackI32.wasmName,
                  [frameField(0)],
                  binaryen.i32,
                ),
                ctx.mod.i32.const(SELECTED_HOST_FRAME_VERSION),
              ),
              ctx.mod.i32.ne(
                ctx.mod.call(
                  provider.unpackI32.wasmName,
                  [frameField(1)],
                  binaryen.i32,
                ),
                ctx.mod.i32.const(SELECTED_HOST_FRAME_TAG.effectOutcome),
              ),
            ),
            ctx.mod.i32.ne(
              ctx.mod.call(
                provider.unpackI32.wasmName,
                [frameField(2)],
                binaryen.i32,
              ),
              opIndexExpr(),
            ),
          ),
          ctx.mod.unreachable(),
          ctx.mod.nop(),
        ),
        ctx.mod.local.set(
          outcomeArrayLocal,
          ctx.mod.call(
            provider.unpackArray.wasmName,
            [frameField(3)],
            arrayType,
          ),
        ),
        ctx.mod.local.set(
          outcomeStorageLocal,
          ctx.mod.call(
            provider.arrayRawStorage.wasmName,
            [ctx.mod.local.get(outcomeArrayLocal, arrayType)],
            storageType,
          ),
        ),
        ctx.mod.if(
          ctx.mod.i32.ne(
            ctx.mod.call(
              provider.unpackI32.wasmName,
              [outcomeField(0)],
              binaryen.i32,
            ),
            ctx.mod.i32.const(0),
          ),
          ctx.mod.unreachable(),
          ctx.mod.nop(),
        ),
        ctx.mod.local.set(
          typedPayloadArrayLocal,
          ctx.mod.call(
            provider.unpackArray.wasmName,
            [outcomeField(1)],
            arrayType,
          ),
        ),
        ctx.mod.local.set(
          typedPayloadStorageLocal,
          ctx.mod.call(
            provider.arrayRawStorage.wasmName,
            [ctx.mod.local.get(typedPayloadArrayLocal, arrayType)],
            storageType,
          ),
        ),
        ctx.mod.local.set(decodedLocal, typedPayloadField(1)),
        ...siteBranches,
        ...signatureBranches,
        ctx.mod.unreachable(),
      ]),
    );
    ctx.mod.addFunctionExport(name, exportName);
    return name;
  });
