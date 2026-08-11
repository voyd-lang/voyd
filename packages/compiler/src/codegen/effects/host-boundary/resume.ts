import binaryen from "binaryen";
import { callRef, refCast } from "@voyd-lang/lib/binaryen-gc/index.js";
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
import { hostBoundaryPayloadSupportForType } from "./payload-compatibility.js";
import { stateFor } from "./state.js";
import type { EffectOpSignature } from "./types.js";
import type { ContinuationSite } from "../effect-lowering/types.js";
import {
  SELECTED_HOST_FRAME_TAG,
  SELECTED_HOST_FRAME_VERSION,
} from "../../host-transport/frame-codec.js";
import {
  readDtoValueFromHostStream,
  readHostStreamValue,
} from "../../boundary/dto-stream-reader.js";
import {
  allocateTempLocal,
  loadLocalValue,
  storeLocalValue,
} from "../../locals.js";
import {
  deriveBoundarySchema,
  type BoundarySchema,
} from "../../boundary/schema.js";
import type { SelectedHostTransportProvider } from "../../host-transport/selected-provider.js";

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

const buildEffectOutcomeStream = ({
  ctx,
  provider,
  fnCtx,
  readerLocal,
  ptr,
  len,
  requestId,
}: {
  ctx: CodegenContext;
  provider: SelectedHostTransportProvider;
  fnCtx: FunctionContext;
  readerLocal: number;
  ptr: binaryen.ExpressionRef;
  len: binaryen.ExpressionRef;
  requestId: binaryen.ExpressionRef;
}): {
  readerRef: () => binaryen.ExpressionRef;
  setup: binaryen.ExpressionRef[];
  finish: binaryen.ExpressionRef[];
} => {
  const readerType = wasmTypeFor(provider.readerTypeId, ctx);
  const readerRef = () => ctx.mod.local.get(readerLocal, readerType);
  const read = (name: string) =>
    readHostStreamValue({
      reader: readerRef(),
      readerTypeId: provider.readerTypeId,
      name,
      ctx,
      fnCtx,
    });
  const setup = [
    ctx.mod.local.set(
      readerLocal,
      ctx.mod.call(
        provider.createReader.wasmName,
        [ptr, len],
        provider.createReader.resultType,
      ),
    ),
    ctx.mod.if(
      ctx.mod.i32.or(
        ctx.mod.i32.or(
          ctx.mod.i32.ne(read("begin_array"), ctx.mod.i32.const(4)),
          ctx.mod.i32.ne(
            read("read_i32"),
            ctx.mod.i32.const(SELECTED_HOST_FRAME_VERSION),
          ),
        ),
        ctx.mod.i32.or(
          ctx.mod.i32.ne(
            read("read_i32"),
            ctx.mod.i32.const(SELECTED_HOST_FRAME_TAG.effectOutcome),
          ),
          ctx.mod.i32.ne(read("read_i32"), requestId),
        ),
      ),
      ctx.mod.unreachable(),
    ),
    ctx.mod.if(
      ctx.mod.i32.ne(read("begin_array"), ctx.mod.i32.const(2)),
      ctx.mod.unreachable(),
    ),
    ctx.mod.if(
      ctx.mod.i32.ne(read("read_i32"), ctx.mod.i32.const(0)),
      ctx.mod.unreachable(),
    ),
    ctx.mod.if(
      ctx.mod.i32.ne(read("begin_array"), ctx.mod.i32.const(2)),
      ctx.mod.unreachable(),
    ),
    ctx.mod.drop(read("read_string")),
  ];
  const finish = [
    ctx.mod.drop(read("end_array")),
    ctx.mod.drop(read("end_array")),
    ctx.mod.drop(read("end_array")),
    ctx.mod.if(
      ctx.mod.i32.eqz(
        ctx.mod.call(
          provider.readerComplete.wasmName,
          [readerRef()],
          provider.readerComplete.resultType,
        ),
      ),
      ctx.mod.unreachable(),
    ),
  ];
  return { readerRef, setup, finish };
};

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
    const readerType = wasmTypeFor(provider.readerTypeId, ctx);

    const name = `${ctx.moduleLabel}__resume_continuation`;
    const params = binaryen.createType([
      runtime.effectRequestType,
      binaryen.i32,
      binaryen.i32,
    ]);
    const locals: binaryen.Type[] = [
      runtime.tailGuardType,
      runtime.continuationType,
      readerType,
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
    const readerLocal = 5;
    const opIndexExpr = (): binaryen.ExpressionRef =>
      runtime.requestOpIndex(
        ctx.mod.local.get(requestLocal, runtime.effectRequestType),
      );

    const guard = (): binaryen.ExpressionRef =>
      ctx.mod.local.get(guardLocal, runtime.tailGuardType);
    const stream = buildEffectOutcomeStream({
      ctx,
      provider,
      fnCtx: scratch,
      readerLocal,
      ptr: ctx.mod.local.get(bufPtrLocal, binaryen.i32),
      len: ctx.mod.local.get(resumeLenLocal, binaryen.i32),
      requestId: opIndexExpr(),
    });
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
      const schema =
        sig.externalBoundary?.result ??
        deriveBoundarySchema({
          typeId: sig.returnTypeId,
          ctx,
          label: sig.label,
          options: { tagStandaloneVariants: true, portableNames: true },
        });
      const resumeLocal =
        sig.returnType === binaryen.none
          ? undefined
          : allocateTempLocal(sig.returnType, scratch, sig.returnTypeId, ctx);
      const readResumeValue = readDtoValueFromHostStream({
        reader: stream.readerRef(),
        readerTypeId: provider.readerTypeId,
        schema,
        ctx,
        fnCtx: scratch,
      });
      const resumeValue = resumeLocal
        ? loadLocalValue(resumeLocal, ctx)
        : ctx.mod.nop();
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
      return ctx.mod.if(
        matches,
        ctx.mod.block(null, [
          resumeLocal
            ? storeLocalValue({
                binding: resumeLocal,
                value: readResumeValue,
                ctx,
                fnCtx: scratch,
              })
            : readResumeValue,
          ...stream.finish,
          ctx.mod.return(call),
        ]),
      );
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
        ...stream.setup,
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
    const readerType = wasmTypeFor(provider.readerTypeId, ctx);
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
    const locals: binaryen.Type[] = [readerType];
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
    const readerLocal = 3;
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

    const stream = buildEffectOutcomeStream({
      ctx,
      provider,
      fnCtx: scratch,
      readerLocal,
      ptr: ctx.mod.local.get(bufPtrLocal, binaryen.i32),
      len: ctx.mod.local.get(resumeLenLocal, binaryen.i32),
      requestId: opIndexExpr(),
    });
    const decodeBranch = ({
      matches,
      typeId,
      schema,
    }: {
      matches: binaryen.ExpressionRef;
      typeId: number;
      schema: BoundarySchema;
    }): binaryen.ExpressionRef => {
      const returnType = wasmTypeFor(typeId, ctx);
      const valueLocal =
        returnType === binaryen.none
          ? undefined
          : allocateTempLocal(returnType, scratch, typeId, ctx);
      const readValue = readDtoValueFromHostStream({
        reader: stream.readerRef(),
        readerTypeId: provider.readerTypeId,
        schema,
        ctx,
        fnCtx: scratch,
      });
      const payload = valueLocal
        ? boxOutcomeValue({
            value: loadLocalValue(valueLocal, ctx),
            valueType: returnType,
            typeId,
            ctx,
            fnCtx: scratch,
          })
        : ctx.mod.ref.null(binaryen.eqref);
      return ctx.mod.if(
        matches,
        ctx.mod.block(null, [
          valueLocal
            ? storeLocalValue({
                binding: valueLocal,
                value: readValue,
                ctx,
                fnCtx: scratch,
              })
            : readValue,
          ...stream.finish,
          ctx.mod.return(runtime.makeOutcomeValue(payload)),
        ]),
      );
    };

    const siteBranches = endSites.map((siteInfo) => {
      const matches = ctx.mod.i32.eq(
        continuationSiteExpr(),
        ctx.mod.i32.const(siteInfo.siteOrder),
      );
      if (!siteInfo.support.supported) {
        return ctx.mod.if(matches, ctx.mod.unreachable());
      }

      return decodeBranch({
        matches,
        typeId: siteInfo.typeId,
        schema: deriveBoundarySchema({
          typeId: siteInfo.typeId,
          ctx,
          label: `end_request_raw(site ${siteInfo.siteOrder})`,
          options: { tagStandaloneVariants: true, portableNames: true },
        }),
      });
    });

    const signatureBranches = signatures.map((sig) => {
      const matches = ctx.mod.i32.eq(
        opIndexExpr(),
        ctx.mod.i32.const(sig.opIndex),
      );
      return decodeBranch({
        matches,
        typeId: sig.returnTypeId,
        schema:
          sig.externalBoundary?.result ??
          deriveBoundarySchema({
            typeId: sig.returnTypeId,
            ctx,
            label: sig.label,
            options: { tagStandaloneVariants: true, portableNames: true },
          }),
      });
    });

    ctx.mod.addFunction(
      name,
      params,
      runtime.outcomeType,
      locals,
      ctx.mod.block(null, [
        ...stream.setup,
        ...siteBranches,
        ...signatureBranches,
        ctx.mod.unreachable(),
      ]),
    );
    ctx.mod.addFunctionExport(name, exportName);
    return name;
  });
