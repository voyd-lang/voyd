import { murmurHash3 } from "@voyd/lib/murmur-hash.js";
import type { CodegenContext } from "../context.js";
import type {
  HirExprId,
  ProgramFunctionInstanceId,
  SymbolId,
  TypeId,
} from "../../semantics/ids.js";
import { isPackageVisible } from "../../semantics/hir/index.js";
import { diagnosticFromCode, normalizeSpan } from "../../diagnostics/index.js";
import type { SourceSpan } from "../../diagnostics/types.js";
import { getRequiredExprType } from "../types.js";
import { buildInstanceSubstitution } from "../type-substitution.js";
import { walkHirExpression } from "../hir-walk.js";
import type { ContinuationSite } from "./effect-lowering/types.js";
import { performSiteArgTypes } from "./perform-site.js";
import { RESUME_KIND, type ResumeKind } from "./runtime-abi.js";

const encoder = new TextEncoder();
const FNV_OFFSET = 14695981039346656037n;
const FNV_PRIME = 1099511628211n;
const FNV_MASK = 0xffffffffffffffffn;

export type EffectIdHash = {
  value: bigint;
  low: number;
  high: number;
};

export type EffectIdInfo = {
  id: string;
  hash: EffectIdHash;
};

export type EffectOpEntry = {
  opIndex: number;
  effectId: EffectIdInfo;
  opId: number;
  resumeKind: ResumeKind;
  signatureHash: number;
  label: string;
  effectName: string;
  opName: string;
};

export type EffectRegistry = {
  entries: readonly EffectOpEntry[];
  effectIdsByModule: ReadonlyMap<string, readonly EffectIdInfo[]>;
  getEntry: (key: EffectOpKey) => EffectOpEntry | undefined;
  getOpIndex: (key: EffectOpKey) => number | undefined;
  getEffectId: (moduleId: string, localEffectIndex: number) => EffectIdInfo | undefined;
  keyFor: (effectId: EffectIdHash, opId: number, signatureHash: number) => EffectOpKey;
};

export type EffectOpInstanceInfo = {
  effectId: EffectIdInfo;
  opId: number;
  opIndex: number;
  resumeKind: ResumeKind;
  signatureHash: number;
  label: string;
};

export type EffectOpKey = string;

const toEffectOpKey = (effectId: EffectIdHash, opId: number, signatureHash: number): EffectOpKey =>
  `${effectId.high.toString(16).padStart(8, "0")}${effectId.low.toString(16).padStart(8, "0")}:${opId}:${signatureHash}`;

const hashEffectId = (value: string): EffectIdHash => {
  const bytes = encoder.encode(value);
  let hash = FNV_OFFSET;
  bytes.forEach((byte) => {
    hash ^= BigInt(byte);
    hash = (hash * FNV_PRIME) & FNV_MASK;
  });
  return {
    value: hash,
    low: Number(hash & 0xffffffffn) >>> 0,
    high: Number((hash >> 32n) & 0xffffffffn) >>> 0,
  };
};

const resolveEffectId = ({
  ctx,
  effectName,
  explicitId,
  visibility,
  spanHint,
}: {
  ctx: CodegenContext;
  effectName: string;
  explicitId?: string;
  visibility: { level: string };
  spanHint?: SourceSpan;
}): EffectIdInfo => {
  const fallbackId = `${ctx.module.meta.packageId}::${ctx.moduleId}::${effectName}`;
  if (!explicitId && isPackageVisible(visibility)) {
    ctx.diagnostics.report(
      diagnosticFromCode({
        code: "CG0004",
        params: {
          kind: "missing-effect-id",
          effectName,
          fallbackId,
        },
        span: normalizeSpan(spanHint, ctx.module.hir.module.span),
        severity: "warning",
        phase: "codegen",
      })
    );
  }
  const id = explicitId ?? fallbackId;
  return { id, hash: hashEffectId(id) };
};

const signatureTypeKeyFor = (
  typeId: TypeId,
  ctx: CodegenContext,
  seen: Set<TypeId>
): string => {
  if (seen.has(typeId)) {
    return `recursive:${typeId}`;
  }
  seen.add(typeId);
  const desc = ctx.program.types.getTypeDesc(typeId);
  switch (desc.kind) {
    case "primitive":
      return `prim:${desc.name}`;
    case "type-param-ref":
      return `typeparam:${desc.param}`;
    case "nominal-object":
      return `nominal:${desc.owner}<${desc.typeArgs
        .map((arg) => signatureTypeKeyFor(arg, ctx, seen))
        .join(",")}>`;
    case "trait":
      return `trait:${desc.owner}<${desc.typeArgs
        .map((arg) => signatureTypeKeyFor(arg, ctx, seen))
        .join(",")}>`;
    case "structural-object":
      return `struct:{${desc.fields
        .map(
          (field) =>
            `${field.name}${field.optional ? "?" : ""}:${signatureTypeKeyFor(
              field.type,
              ctx,
              seen
            )}`
        )
        .join(",")}}`;
    case "function":
      return `fn:(${desc.parameters
        .map((param) => signatureTypeKeyFor(param.type, ctx, seen))
        .join(",")})->${signatureTypeKeyFor(desc.returnType, ctx, seen)}`;
    case "union": {
      const members = desc.members
        .map((member) => signatureTypeKeyFor(member, ctx, seen))
        .sort();
      return `union:${members.join("|")}`;
    }
    case "intersection": {
      const nominal =
        typeof desc.nominal === "number"
          ? signatureTypeKeyFor(desc.nominal, ctx, seen)
          : "none";
      const structural =
        typeof desc.structural === "number"
          ? signatureTypeKeyFor(desc.structural, ctx, seen)
          : "none";
      return `intersection:${nominal}&${structural}`;
    }
    case "fixed-array":
      return `fixed-array:${signatureTypeKeyFor(desc.element, ctx, seen)}`;
    default:
      return `${(desc as { kind: string }).kind}:${typeId}`;
  }
};

export const signatureHashFor = ({
  params,
  returnType,
  ctx,
}: {
  params: readonly TypeId[];
  returnType: TypeId;
  ctx: CodegenContext;
}): number => {
  const paramKeys = params.map((param) => signatureTypeKeyFor(param, ctx, new Set()));
  const returnKey = signatureTypeKeyFor(returnType, ctx, new Set());
  return murmurHash3(`(${paramKeys.join(",")})->${returnKey}`);
};

const resolveTypeId = ({
  typeId,
  fallback,
  substitution,
  ctx,
}: {
  typeId: TypeId;
  fallback?: TypeId;
  substitution?: Map<number, TypeId>;
  ctx: CodegenContext;
}): TypeId => {
  const desc = ctx.program.types.getTypeDesc(typeId);
  const shouldFallback =
    desc.kind === "type-param-ref" ||
    (desc.kind === "primitive" && desc.name === "unknown");
  const base = shouldFallback && typeof fallback === "number" ? fallback : typeId;
  return substitution ? ctx.program.types.substitute(base, substitution) : base;
};

export const resolvePerformSignature = ({
  site,
  ctx,
  typeInstanceId,
}: {
  site: Extract<ContinuationSite, { kind: "perform" }>;
  ctx: CodegenContext;
  typeInstanceId?: ProgramFunctionInstanceId;
}): { params: readonly TypeId[]; returnType: TypeId } => {
  const signature = ctx.program.functions.getSignature(ctx.moduleId, site.effectSymbol);
  const callTypeArgs = ctx.program.calls.getCallInfo(ctx.moduleId, site.exprId).typeArgs;
  const substitution = new Map<number, TypeId>();
  const instanceSubstitution = buildInstanceSubstitution({ ctx, typeInstanceId });
  instanceSubstitution?.forEach((value, key) => {
    substitution.set(key, value);
  });
  const signatureTypeParams = signature?.typeParams ?? [];
  const hasCallTypeArgs =
    signatureTypeParams.length > 0 &&
    callTypeArgs &&
    callTypeArgs.length === signatureTypeParams.length;
  if (hasCallTypeArgs) {
    signatureTypeParams.forEach((param, index) => {
      const typeArg = callTypeArgs[index];
      if (typeof typeArg !== "number") return;
      const resolvedArg = instanceSubstitution
        ? ctx.program.types.substitute(typeArg, instanceSubstitution)
        : typeArg;
      substitution.set(param.typeParam, resolvedArg);
    });
  }
  const activeSubstitution =
    substitution.size > 0 ? substitution : undefined;
  if (signature && (signatureTypeParams.length === 0 || hasCallTypeArgs)) {
    const resolvedParams = signature.parameters.map((param) =>
      resolveTypeId({
        typeId: param.typeId,
        fallback: param.typeId,
        substitution: activeSubstitution,
        ctx,
      })
    );
    const resolvedReturn = resolveTypeId({
      typeId: signature.returnType,
      fallback: signature.returnType,
      substitution: activeSubstitution,
      ctx,
    });
    return { params: resolvedParams, returnType: resolvedReturn };
  }
  const signatureParams = signature?.parameters.map((param) => param.typeId) ?? [];
  const paramTypes = performSiteArgTypes({
    exprId: site.exprId,
    ctx,
    typeInstanceId,
  });
  const resolvedParams = paramTypes.map((typeId, index) =>
    resolveTypeId({
      typeId,
      fallback: signatureParams[index],
      substitution: activeSubstitution,
      ctx,
    })
  );
  const exprType = getRequiredExprType(site.exprId, ctx, typeInstanceId);
  const resolvedReturn = resolveTypeId({
    typeId: exprType,
    fallback: signature?.returnType,
    substitution: activeSubstitution,
    ctx,
  });
  return { params: resolvedParams, returnType: resolvedReturn };
};

const buildOwnerMap = (ctx: CodegenContext): Map<HirExprId, SymbolId> => {
  const ownerByExpr = new Map<HirExprId, SymbolId>();
  ctx.module.hir.items.forEach((item) => {
    if (item.kind !== "function") return;
    walkHirExpression({
      exprId: item.body,
      ctx,
      visitLambdaBodies: true,
      visitHandlerBodies: true,
      visitor: {
        onExpr: (exprId) => {
          ownerByExpr.set(exprId, item.symbol);
        },
      },
    });
  });
  return ownerByExpr;
};

const collectEffectIds = (ctx: CodegenContext): EffectIdInfo[] => {
  const effectItems = new Map<SymbolId, { span: SourceSpan }>();
  ctx.module.hir.items.forEach((item) => {
    if (item.kind !== "effect") return;
    effectItems.set(item.symbol, { span: item.span });
  });
  return ctx.module.meta.effects.map((effect) =>
    resolveEffectId({
      ctx,
      effectName: effect.name,
      explicitId: effect.effectId,
      visibility: effect.visibility,
      span: effectItems.get(effect.symbol)?.span,
    })
  );
};

export const buildEffectRegistry = (
  contexts: readonly CodegenContext[]
): EffectRegistry => {
  const entriesByKey = new Map<EffectOpKey, EffectOpEntry>();
  const effectIdsByModule = new Map<string, EffectIdInfo[]>();

  contexts.forEach((ctx) => {
    effectIdsByModule.set(ctx.moduleId, collectEffectIds(ctx));
  });

  contexts.forEach((ctx) => {
    const ownerByExpr = buildOwnerMap(ctx);
    const instancesBySymbol = new Map<SymbolId, ProgramFunctionInstanceId[]>();
    ctx.functionInstances.forEach((meta, instanceId) => {
      if (meta.moduleId !== ctx.moduleId) return;
      const bucket = instancesBySymbol.get(meta.symbol) ?? [];
      bucket.push(instanceId);
      instancesBySymbol.set(meta.symbol, bucket);
    });

    ctx.effectLowering.sites.forEach((site) => {
      if (site.kind !== "perform") return;
      const info = ctx.module.effectsInfo.operations.get(site.effectSymbol);
      if (!info) {
        throw new Error(`missing effect info for op ${site.effectSymbol}`);
      }
      const effectIds = effectIdsByModule.get(ctx.moduleId);
      if (!effectIds) {
        throw new Error(`missing effect ids for module ${ctx.moduleId}`);
      }
      const effectId = effectIds[info.localEffectIndex];
      if (!effectId) {
        throw new Error(`missing effect id for ${ctx.moduleId}:${info.localEffectIndex}`);
      }
      const effectMeta = ctx.module.meta.effects[info.localEffectIndex];
      const opMeta = effectMeta?.operations[info.opIndex];
      const opName = opMeta?.name ?? `${info.opIndex}`;
      const effectName = effectMeta?.name ?? `${info.localEffectIndex}`;
      const label = `${ctx.moduleId}::${effectName}.${opName}`;
      const resumeKind =
        info.resumable === "tail" ? RESUME_KIND.tail : RESUME_KIND.resume;
      const owners = ownerByExpr.get(site.exprId);
      const instances = owners ? instancesBySymbol.get(owners) ?? [] : [];
      const instanceList = instances.length > 0 ? instances : [undefined];

      instanceList.forEach((instanceId) => {
        const signature = resolvePerformSignature({
          site,
          ctx,
          typeInstanceId: instanceId,
        });
        const signatureHash = signatureHashFor({
          params: signature.params,
          returnType: signature.returnType,
          ctx,
        });
        const key = toEffectOpKey(effectId.hash, info.opIndex, signatureHash);
        if (!entriesByKey.has(key)) {
          entriesByKey.set(key, {
            opIndex: -1,
            effectId,
            opId: info.opIndex,
            resumeKind,
            signatureHash,
            label,
            effectName,
            opName,
          });
        }
      });
    });
  });

  const entries = Array.from(entriesByKey.values()).sort((a, b) => {
    if (a.effectId.hash.high !== b.effectId.hash.high) {
      return a.effectId.hash.high - b.effectId.hash.high;
    }
    if (a.effectId.hash.low !== b.effectId.hash.low) {
      return a.effectId.hash.low - b.effectId.hash.low;
    }
    if (a.opId !== b.opId) {
      return a.opId - b.opId;
    }
    return a.signatureHash - b.signatureHash;
  });

  entries.forEach((entry, index) => {
    entry.opIndex = index;
  });

  const byKey = new Map<EffectOpKey, EffectOpEntry>();
  entries.forEach((entry) => {
    const key = toEffectOpKey(entry.effectId.hash, entry.opId, entry.signatureHash);
    byKey.set(key, entry);
  });

  return {
    entries,
    effectIdsByModule,
    getEntry: (key) => byKey.get(key),
    getOpIndex: (key) => byKey.get(key)?.opIndex,
    getEffectId: (moduleId, localEffectIndex) =>
      effectIdsByModule.get(moduleId)?.[localEffectIndex],
    keyFor: (effectId, opId, signatureHash) =>
      toEffectOpKey(effectId, opId, signatureHash),
  };
};

export const getEffectOpInstanceInfo = ({
  ctx,
  site,
  typeInstanceId,
  registry,
}: {
  ctx: CodegenContext;
  site: Extract<ContinuationSite, { kind: "perform" }>;
  typeInstanceId?: ProgramFunctionInstanceId;
  registry: EffectRegistry;
}): EffectOpInstanceInfo => {
  const info = ctx.module.effectsInfo.operations.get(site.effectSymbol);
  if (!info) {
    throw new Error(`missing effect info for op ${site.effectSymbol}`);
  }
  const effectMeta = ctx.module.meta.effects[info.localEffectIndex];
  if (!effectMeta) {
    throw new Error(`missing effect metadata for ${ctx.moduleId}:${info.localEffectIndex}`);
  }
  const effectId = registry.getEffectId(ctx.moduleId, info.localEffectIndex);
  if (!effectId) {
    throw new Error(`missing effect id for ${ctx.moduleId}:${info.localEffectIndex}`);
  }
  const resumeKind =
    info.resumable === "tail" ? RESUME_KIND.tail : RESUME_KIND.resume;
  const opMeta = effectMeta.operations[info.opIndex];
  const opName = opMeta?.name ?? `${info.opIndex}`;
  const label = `${ctx.moduleId}::${effectMeta.name}.${opName}`;
  const signature = resolvePerformSignature({ site, ctx, typeInstanceId });
  const signatureHash = signatureHashFor({
    params: signature.params,
    returnType: signature.returnType,
    ctx,
  });
  const key = registry.keyFor(effectId.hash, info.opIndex, signatureHash);
  const opIndex = registry.getOpIndex(key);
  if (opIndex === undefined) {
    throw new Error(
      `missing effect op entry for ${label} (effect=${effectId.id}, op=${info.opIndex}, signature=${signatureHash})`
    );
  }
  return {
    effectId,
    opId: info.opIndex,
    opIndex,
    resumeKind,
    signatureHash,
    label,
  };
};
