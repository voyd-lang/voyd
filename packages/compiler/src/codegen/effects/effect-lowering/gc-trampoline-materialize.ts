import binaryen from "binaryen";
import {
  defineStructType,
  modBinaryenTypeToHeapType,
} from "@voyd-lang/lib/binaryen-gc/index.js";
import type { CodegenContext } from "../../context.js";
import type { HirExprId } from "../../../semantics/ids.js";
import {
  getMutableRefStorageType,
  wasmHeapFieldTypeFor,
  wasmTypeFor,
} from "../../types.js";
import {
  handlerClauseContinuationTempId,
  handlerClauseTailGuardTempId,
} from "./handler-clause-temp-ids.js";
import { sanitizeIdentifier } from "./layout.js";
import type {
  ContinuationEnvField,
  ContinuationSite,
  EffectLoweringEirResult,
  EffectLoweringResult,
} from "./types.js";
import { getInlineHeapBoxType } from "../../types.js";

const baseEnvFields = (ctx: CodegenContext): ContinuationEnvField[] => [
  {
    name: "site",
    typeId: ctx.program.primitives.i32,
    wasmType: binaryen.i32,
    storageType: binaryen.i32,
    sourceKind: "site",
  },
  {
    name: "handler",
    wasmType: ctx.effectsRuntime.handlerFrameType,
    storageType: ctx.effectsRuntime.handlerFrameType,
    typeId: ctx.program.primitives.unknown,
    sourceKind: "handler",
  } as const,
];

const handlerClauseTemps = ({
  owner,
  ctx,
}: {
  owner: ContinuationSite["owner"];
  ctx: CodegenContext;
}): ContinuationEnvField[] => {
  if (owner.kind !== "handler-clause") return [];
  return [
    {
      name: "clause_cont",
      wasmType: ctx.effectsRuntime.continuationType,
      storageType: ctx.effectsRuntime.continuationType,
      typeId: ctx.program.primitives.unknown,
      sourceKind: "local",
      tempId: handlerClauseContinuationTempId({
        handlerExprId: owner.handlerExprId,
        clauseIndex: owner.clauseIndex,
      }),
    },
    {
      name: "clause_tail_guard",
      wasmType: ctx.effectsRuntime.tailGuardType,
      storageType: ctx.effectsRuntime.tailGuardType,
      typeId: ctx.program.primitives.unknown,
      sourceKind: "local",
      tempId: handlerClauseTailGuardTempId({
        handlerExprId: owner.handlerExprId,
        clauseIndex: owner.clauseIndex,
      }),
    },
  ];
};

const captureFields = ({
  eirSite,
  ctx,
}: {
  eirSite: EffectLoweringEirResult["sites"][number];
  ctx: CodegenContext;
}): ContinuationEnvField[] =>
  eirSite.captureFields.map((field) => {
    if (field.sourceKind === "temp") {
      const tempId = field.tempId;
      if (typeof tempId !== "number") {
        throw new Error("missing temp id for continuation capture");
      }
      const storageRefType = field.storageRef
        ? field.bindingKind === "mutable-ref"
          ? getMutableRefStorageType({ typeId: field.typeId, ctx })
          : getInlineHeapBoxType({ typeId: field.typeId, ctx })
        : undefined;
      if (field.storageRef && typeof storageRefType !== "number") {
        throw new Error("default reference temp requires storage-ref ABI");
      }
      return {
        name: `tmp_${tempId}`,
        wasmType: storageRefType ?? wasmTypeFor(field.typeId, ctx),
        storageType:
          storageRefType ??
          wasmHeapFieldTypeFor(field.typeId, ctx, new Set(), "runtime"),
        typeId: field.typeId,
        sourceKind: "local",
        tempId,
        storageRef: field.storageRef,
        bindingKind: field.bindingKind,
      };
    }

    const symbol = field.symbol;
    if (typeof symbol !== "number") {
      throw new Error("missing symbol for continuation capture");
    }
    const symbolId = ctx.program.symbols.idOf({
      moduleId: ctx.moduleId,
      symbol,
    });
    const storageRefType =
      field.bindingKind === "mutable-ref"
        ? getMutableRefStorageType({ typeId: field.typeId, ctx })
        : undefined;
    return {
      name: ctx.program.symbols.getName(symbolId) ?? `${symbol}`,
      symbol,
      typeId: field.typeId,
      wasmType: storageRefType ?? wasmTypeFor(field.typeId, ctx),
      storageType:
        storageRefType ??
        wasmHeapFieldTypeFor(field.typeId, ctx, new Set(), "runtime"),
      sourceKind: field.sourceKind,
      storageRef: typeof storageRefType === "number",
      bindingKind: field.bindingKind,
    };
  });

export const materializeGcTrampolineEffectLowering = ({
  eir,
  ctx,
}: {
  eir: EffectLoweringEirResult;
  ctx: CodegenContext;
}): EffectLoweringResult => {
  const sites: ContinuationSite[] = [];
  const sitesByExpr = new Map<HirExprId, ContinuationSite>();
  const baseEnvType = ctx.effectsRuntime.contEnvBaseType;
  const baseHeapType = modBinaryenTypeToHeapType(ctx.mod, baseEnvType);

  eir.sites.forEach((eirSite) => {
    const envFields: ContinuationEnvField[] = [
      ...baseEnvFields(ctx),
      ...handlerClauseTemps({ owner: eirSite.owner, ctx }),
      ...captureFields({ eirSite, ctx }),
    ];
    const envType = defineStructType(ctx.mod, {
      name: `voydContEnv_${sanitizeIdentifier(ctx.moduleLabel)}_${sanitizeIdentifier(
        eirSite.contBaseName,
      )}_${eirSite.siteId}`,
      fields: envFields.map((field) => ({
        name: field.name,
        type: field.storageType,
        mutable: false,
      })),
      supertype: baseHeapType,
      final: true,
    });

    const site: ContinuationSite =
      eirSite.kind === "perform"
        ? {
            kind: "perform",
            exprId: eirSite.exprId,
            siteId: eirSite.siteId,
            siteOrder: eirSite.siteOrder,
            owner: eirSite.owner,
            effectSymbol: eirSite.effectSymbol,
            contBaseName: eirSite.contBaseName,
            baseEnvType,
            envType,
            envFields,
            handlerAtSite: eirSite.handlerAtSite,
            resumeValueTypeId: eirSite.resumeValueTypeId,
          }
        : {
            kind: "call",
            exprId: eirSite.exprId,
            siteId: eirSite.siteId,
            siteOrder: eirSite.siteOrder,
            owner: eirSite.owner,
            contBaseName: eirSite.contBaseName,
            baseEnvType,
            envType,
            envFields,
            handlerAtSite: eirSite.handlerAtSite,
            resumeValueTypeId: eirSite.resumeValueTypeId,
          };

    sites.push(site);
    sitesByExpr.set(site.exprId, site);
  });

  return {
    sitesByExpr,
    sites,
    callArgTemps: eir.callArgTemps,
    tempTypeIds: eir.tempTypeIds,
    defaultParamTemps: eir.defaultParamTemps,
  };
};
