import binaryen from "binaryen";
import {
  defineStructType,
  modBinaryenTypeToHeapType,
} from "@voyd/lib/binaryen-gc/index.js";
import type {
  CodegenContext,
  HirExprId,
  HirLambdaExpr,
  SymbolId,
  TypeId,
} from "../../context.js";
import type { ProgramFunctionInstanceId } from "../../../semantics/ids.js";
import type { ContinuationEnvField, ContinuationSite } from "../effect-lowering.js";
import { sanitizeIdentifier } from "../effect-lowering/layout.js";
import { getRequiredExprType, wasmTypeFor } from "../../types.js";
import { buildInstanceSubstitution } from "../../type-substitution.js";
import { walkHirExpression } from "../../hir-walk.js";
import { resolveTempCaptureTypeId } from "../temp-capture-types.js";

const specializationKey = ({
  site,
  typeInstanceId,
}: {
  site: ContinuationSite;
  typeInstanceId?: ProgramFunctionInstanceId;
}): string => `${site.siteId}:${typeof typeInstanceId === "number" ? typeInstanceId : "base"}`;

const OWNER_SYMBOL_TYPES_KEY = Symbol("effects.ownerSymbolTypes");

const memoized = <T>({
  key,
  ctx,
  build,
}: {
  key: symbol;
  ctx: CodegenContext;
  build: () => T;
}): T => {
  const existing = ctx.effectsState.memo.get(key);
  if (existing) {
    return existing as T;
  }
  const built = build();
  ctx.effectsState.memo.set(key, built);
  return built;
};

const ownerKey = (site: ContinuationSite): string => {
  if (site.owner.kind === "function") {
    return `function:${site.owner.symbol}`;
  }
  if (site.owner.kind === "lambda") {
    return `lambda:${site.owner.exprId}`;
  }
  return `handler:${site.owner.handlerExprId}:${site.owner.clauseIndex}`;
};

const ownerBodyExprId = ({
  site,
  ctx,
}: {
  site: ContinuationSite;
  ctx: CodegenContext;
}): HirExprId => {
  if (site.owner.kind === "function") {
    for (const item of ctx.module.hir.items.values()) {
      if (item.kind === "function" && item.symbol === site.owner.symbol) {
        return item.body;
      }
    }
    throw new Error("missing function owner for continuation site");
  }
  if (site.owner.kind === "lambda") {
    const expr = ctx.module.hir.expressions.get(site.owner.exprId);
    if (!expr || expr.exprKind !== "lambda") {
      throw new Error("missing lambda owner for continuation site");
    }
    return (expr as HirLambdaExpr).body;
  }
  const handlerExpr = ctx.module.hir.expressions.get(site.owner.handlerExprId);
  if (!handlerExpr || handlerExpr.exprKind !== "effect-handler") {
    throw new Error("missing handler owner for continuation site");
  }
  const clause = handlerExpr.handlers[site.owner.clauseIndex];
  if (!clause) {
    throw new Error("missing handler clause owner for continuation site");
  }
  return clause.body;
};

const ownerSymbolTypesFor = ({
  site,
  ctx,
  typeInstanceId,
}: {
  site: ContinuationSite;
  ctx: CodegenContext;
  typeInstanceId: ProgramFunctionInstanceId;
}): ReadonlyMap<SymbolId, TypeId> => {
  const byKey = memoized({
    key: OWNER_SYMBOL_TYPES_KEY,
    ctx,
    build: () => new Map<string, Map<SymbolId, TypeId>>(),
  });
  const cacheKey = `${ownerKey(site)}:${typeInstanceId}`;
  const cached = byKey.get(cacheKey);
  if (cached) {
    return cached;
  }

  const collected = new Map<SymbolId, TypeId>();
  const bodyExprId = ownerBodyExprId({ site, ctx });
  walkHirExpression({
    exprId: bodyExprId,
    ctx,
    visitLambdaBodies: false,
    visitor: {
      onExpr: (id, expr) => {
        if (expr.exprKind !== "identifier") return;
        const typeId = getRequiredExprType(id, ctx, typeInstanceId);
        const existing = collected.get(expr.symbol);
        if (
          typeof existing === "number" &&
          existing !== ctx.program.primitives.unknown
        ) {
          return;
        }
        collected.set(expr.symbol, typeId);
      },
    },
  });
  byKey.set(cacheKey, collected);
  return collected;
};

const specializeEnvField = ({
  field,
  ctx,
  typeInstanceId,
  substitution,
  ownerSymbolTypes,
}: {
  field: ContinuationEnvField;
  ctx: CodegenContext;
  typeInstanceId: ProgramFunctionInstanceId;
  substitution?: Map<number, number>;
  ownerSymbolTypes: ReadonlyMap<SymbolId, TypeId>;
}): ContinuationEnvField => {
  if (field.sourceKind === "site") {
    return {
      ...field,
      typeId: ctx.program.primitives.i32,
      wasmType: binaryen.i32,
    };
  }
  if (field.sourceKind === "handler") {
    return {
      ...field,
      typeId: ctx.program.primitives.unknown,
      wasmType: ctx.effectsRuntime.handlerFrameType,
    };
  }
  if (typeof field.tempId === "number" && field.tempId < 0) {
    return field;
  }

  const baseTypeId = (() => {
    if (typeof field.tempId === "number") {
      return resolveTempCaptureTypeId({
        tempId: field.tempId,
        ctx,
        typeInstanceId,
      });
    }
    if (typeof field.symbol === "number") {
      return ownerSymbolTypes.get(field.symbol) ?? field.typeId;
    }
    return field.typeId;
  })();
  const specializedTypeId = substitution
    ? ctx.program.types.substitute(baseTypeId, substitution)
    : baseTypeId;
  return {
    ...field,
    typeId: specializedTypeId,
    wasmType: wasmTypeFor(specializedTypeId, ctx),
  };
};

export const specializeContinuationSite = ({
  site,
  ctx,
  typeInstanceId,
}: {
  site: ContinuationSite;
  ctx: CodegenContext;
  typeInstanceId?: ProgramFunctionInstanceId;
}): ContinuationSite => {
  if (typeof typeInstanceId !== "number") {
    return site;
  }
  const key = specializationKey({ site, typeInstanceId });
  const cached = ctx.effectsState.contSiteByKey.get(key);
  if (cached) {
    return cached;
  }

  const substitution = buildInstanceSubstitution({ ctx, typeInstanceId });
  const ownerSymbolTypes = ownerSymbolTypesFor({
    site,
    ctx,
    typeInstanceId,
  });
  const envFields = site.envFields.map((field) =>
    specializeEnvField({
      field,
      ctx,
      typeInstanceId,
      substitution,
      ownerSymbolTypes,
    })
  );
  const envType = defineStructType(ctx.mod, {
    name: `voydContEnv_${sanitizeIdentifier(ctx.moduleLabel)}_${sanitizeIdentifier(
      site.contBaseName
    )}_${site.siteId}__inst${typeInstanceId}`,
    fields: envFields.map((field) => ({
      name: field.name,
      type: field.wasmType,
      mutable: false,
    })),
    supertype: modBinaryenTypeToHeapType(ctx.mod, site.baseEnvType),
    final: true,
  });

  const specialized: ContinuationSite =
    site.kind === "perform"
      ? {
          ...site,
          envFields,
          envType,
        }
      : {
          ...site,
          envFields,
          envType,
        };

  ctx.effectsState.contSiteByKey.set(key, specialized);
  return specialized;
};
