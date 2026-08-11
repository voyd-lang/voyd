import { murmurHash3 } from "@voyd-lang/lib/murmur-hash.js";
import type { CodegenContext } from "../context.js";
import type {
  HirExprId,
  ProgramFunctionInstanceId,
  ProgramSymbolId,
  SymbolId,
  TypeId,
  TypeParamId,
} from "../../semantics/ids.js";
import { getRequiredExprType } from "../types.js";
import {
  resolveEffectSignatureTypes,
  resolveHandlerClauseSignature,
} from "./effect-signature.js";
import { resolveEffectOpRuntimeInfo } from "./op-ids.js";
import { walkHirExpression } from "../hir-walk.js";
import type { ContinuationSite } from "./effect-lowering/types.js";
import { performSiteArgTypes } from "./perform-site.js";
import { RESUME_KIND, type ResumeKind } from "./runtime-abi.js";
import {
  deriveBoundarySchema,
  withDtoFingerprint,
  type BoundarySchema,
} from "../boundary/schema.js";

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
  operationId?: string;
  boundary?: {
    params: readonly BoundarySchema[];
    result: BoundarySchema;
  };
  external?: {
    params: readonly BoundarySchema[];
    result: BoundarySchema;
    declaredOnly?: boolean;
  };
};

export type EffectRegistry = {
  entries: readonly EffectOpEntry[];
  effectIdsByModule: ReadonlyMap<string, readonly EffectIdInfo[]>;
  getEntry: (key: EffectOpKey) => EffectOpEntry | undefined;
  getOpIndex: (key: EffectOpKey) => number | undefined;
  getEffectId: (
    moduleId: string,
    localEffectIndex: number,
  ) => EffectIdInfo | undefined;
  keyFor: (
    effectId: EffectIdHash,
    opId: number,
    signatureHash: number,
  ) => EffectOpKey;
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

const mergeExternalMetadata = ({
  entry,
  candidate,
}: {
  entry: EffectOpEntry;
  candidate: EffectOpEntry["external"];
}): void => {
  if (!candidate) return;
  if (!entry.external) {
    entry.external = candidate;
    return;
  }
  if (entry.external.declaredOnly && !candidate.declaredOnly) {
    entry.external = candidate;
  }
};

const boundaryMetadataFor = ({
  ctx,
  label,
  params,
  result,
}: {
  ctx: CodegenContext;
  label: string;
  params: readonly TypeId[];
  result: TypeId;
}): EffectOpEntry["boundary"] => {
  if (
    ![...params, result].every((typeId) =>
      ctx.program.dtoPlans.isEligible({ typeId, moduleId: ctx.moduleId }),
    )
  ) {
    return undefined;
  }
  return {
    params: params.map((typeId, index) =>
      withDtoFingerprint(
        deriveBoundarySchema({
          typeId,
          ctx,
          label: `${label} arg${index}`,
          options: { tagStandaloneVariants: true },
        }),
      ),
    ),
    result: withDtoFingerprint(
      deriveBoundarySchema({
        typeId: result,
        ctx,
        label: `${label} result`,
        options: { tagStandaloneVariants: true },
      }),
    ),
  };
};

const toEffectOpKey = (
  effectId: EffectIdHash,
  opId: number,
  signatureHash: number,
): EffectOpKey =>
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
}: {
  ctx: CodegenContext;
  effectName: string;
  explicitId?: string;
}): EffectIdInfo => {
  const fallbackId = `${ctx.module.meta.packageId}::${ctx.moduleId}::${effectName}`;
  const id = explicitId ?? fallbackId;
  return { id, hash: hashEffectId(id) };
};

type SignatureTypeKeyState = {
  typeId: TypeId;
  ctx: CodegenContext;
  active: Map<TypeId, number>;
  binders: Map<TypeParamId, number>;
};

const signatureTypeKeyFor = ({
  typeId,
  ctx,
}: {
  typeId: TypeId;
  ctx: CodegenContext;
}): string => {
  const fingerprint = ctx.program.dtoPlans.isEligible({
    typeId,
    moduleId: ctx.moduleId,
  })
    ? ctx.program.dtoPlans.get({ typeId, moduleId: ctx.moduleId }).fingerprint
    : undefined;
  if (fingerprint) {
    return `dto:${fingerprint}`;
  }
  return signatureTypeKeyForInternal({
    typeId,
    ctx,
    active: new Map<TypeId, number>(),
    binders: new Map<TypeParamId, number>(),
  });
};

const signatureTypeKeyForInternal = ({
  typeId,
  ctx,
  active,
  binders,
}: SignatureTypeKeyState): string => {
  const activeIndex = active.get(typeId);
  if (typeof activeIndex === "number") {
    return `recursive:${activeIndex}`;
  }
  active.set(typeId, active.size);
  try {
    const desc = ctx.program.types.getTypeDesc(typeId);
    let baseKey: string;
    switch (desc.kind) {
      case "primitive":
        baseKey = `prim:${desc.name}`;
        break;
      case "recursive": {
        const binderIndex = binders.size;
        const nextBinders = new Map(binders);
        nextBinders.set(desc.binder, binderIndex);
        baseKey = `mu:${binderIndex}.${signatureTypeKeyForInternal({
          typeId: desc.body,
          ctx,
          active,
          binders: nextBinders,
        })}`;
        break;
      }
      case "type-param-ref": {
        const binderIndex = binders.get(desc.param);
        baseKey =
          typeof binderIndex === "number"
            ? `recparam:${binderIndex}`
            : `typeparam:${desc.param}`;
        break;
      }
      case "nominal-object":
        baseKey = `nominal:${desc.owner}<${desc.typeArgs
          .map((arg) =>
            signatureTypeKeyForInternal({ typeId: arg, ctx, active, binders }),
          )
          .join(",")}>`;
        break;
      case "value-object":
        baseKey = `value:${desc.owner}<${desc.typeArgs
          .map((arg) =>
            signatureTypeKeyForInternal({ typeId: arg, ctx, active, binders }),
          )
          .join(",")}>`;
        break;
      case "trait":
        baseKey = `trait:${desc.owner}<${desc.typeArgs
          .map((arg) =>
            signatureTypeKeyForInternal({ typeId: arg, ctx, active, binders }),
          )
          .join(",")}>`;
        break;
      case "structural-object":
        baseKey = `struct:{${desc.fields
          .map(
            (field) =>
              `${field.name}${field.optional ? "?" : ""}:${signatureTypeKeyForInternal(
                {
                  typeId: field.type,
                  ctx,
                  active,
                  binders,
                },
              )}`,
          )
          .join(",")}}`;
        break;
      case "function":
        baseKey = `fn:(${desc.parameters
          .map((param) =>
            signatureTypeKeyForInternal({
              typeId: param.type,
              ctx,
              active,
              binders,
            }),
          )
          .join(",")})->${signatureTypeKeyForInternal({
          typeId: desc.returnType,
          ctx,
          active,
          binders,
        })}`;
        break;
      case "union": {
        const members = desc.members
          .map((member) =>
            signatureTypeKeyForInternal({
              typeId: member,
              ctx,
              active,
              binders,
            }),
          )
          .sort();
        baseKey = `union:${members.join("|")}`;
        break;
      }
      case "intersection": {
        const nominal =
          typeof desc.nominal === "number"
            ? signatureTypeKeyForInternal({
                typeId: desc.nominal,
                ctx,
                active,
                binders,
              })
            : "none";
        const structural =
          typeof desc.structural === "number"
            ? signatureTypeKeyForInternal({
                typeId: desc.structural,
                ctx,
                active,
                binders,
              })
            : "none";
        const traits =
          desc.traits && desc.traits.length > 0
            ? desc.traits
                .map((trait) =>
                  signatureTypeKeyForInternal({
                    typeId: trait,
                    ctx,
                    active,
                    binders,
                  }),
                )
                .sort()
                .join("|")
            : "none";
        baseKey = `intersection:${nominal}&${structural}&traits:${traits}`;
        break;
      }
      case "fixed-array":
        baseKey = `fixed-array:${signatureTypeKeyForInternal({
          typeId: desc.element,
          ctx,
          active,
          binders,
        })}`;
        break;
      default:
        baseKey = `${(desc as { kind: string }).kind}:${typeId}`;
        break;
    }
    return baseKey;
  } finally {
    active.delete(typeId);
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
  const paramKeys = params.map((param) =>
    signatureTypeKeyFor({
      typeId: param,
      ctx,
    }),
  );
  const returnKey = signatureTypeKeyFor({
    typeId: returnType,
    ctx,
  });
  return murmurHash3(`(${paramKeys.join(",")})->${returnKey}`);
};

export const resolvePerformSignature = ({
  site,
  ctx,
  typeInstanceId,
}: {
  site: Extract<ContinuationSite, { kind: "perform" }>;
  ctx: CodegenContext;
  typeInstanceId?: ProgramFunctionInstanceId;
}): {
  params: readonly TypeId[];
  returnType: TypeId;
} => {
  const signature = ctx.program.functions.getSignature(
    ctx.moduleId,
    site.effectSymbol,
  );
  const callInfo = ctx.program.calls.getCallInfo(ctx.moduleId, site.exprId);
  const callTypeArgs = (() => {
    if (typeof typeInstanceId === "number") {
      return callInfo.typeArgs?.get(typeInstanceId);
    }
    if (callInfo.typeArgs && callInfo.typeArgs.size === 1) {
      return callInfo.typeArgs.values().next().value;
    }
    return undefined;
  })();
  const signatureTypeParams = signature?.typeParams ?? [];
  const hasCallTypeArgs =
    signatureTypeParams.length > 0 &&
    callTypeArgs &&
    callTypeArgs.length === signatureTypeParams.length;
  if (signature && (signatureTypeParams.length === 0 || hasCallTypeArgs)) {
    const paramTypes = signature.parameters.map((param) => param.typeId);
    return {
      ...resolveEffectSignatureTypes({
        ctx,
        signature,
        typeInstanceId,
        typeArgs: hasCallTypeArgs ? callTypeArgs : undefined,
        paramTypes,
        fallbackParams: paramTypes,
        returnType: signature.returnType,
        fallbackReturnType: signature.returnType,
      }),
    };
  }
  const signatureParams =
    signature?.parameters.map((param) => param.typeId) ?? [];
  const paramTypes = performSiteArgTypes({
    exprId: site.exprId,
    ctx,
    typeInstanceId,
  });
  const exprType = getRequiredExprType(site.exprId, ctx, typeInstanceId);
  return {
    ...resolveEffectSignatureTypes({
      ctx,
      signature,
      typeInstanceId,
      typeArgs: hasCallTypeArgs ? callTypeArgs : undefined,
      paramTypes,
      fallbackParams: signatureParams,
      returnType: exprType,
      fallbackReturnType: signature?.returnType,
    }),
  };
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
  return ctx.module.meta.effects.map((effect) =>
    resolveEffectId({
      ctx,
      effectName: registrySymbolName({
        ctx,
        moduleId: ctx.moduleId,
        symbol: effect.symbol,
        sourceName: effect.name,
        freshPrefix: "effect",
      }),
      explicitId: effect.effectId,
    }),
  );
};

const registrySymbolName = ({
  ctx,
  moduleId,
  symbol,
  sourceName,
  freshPrefix,
}: {
  ctx: CodegenContext;
  moduleId: string;
  symbol: SymbolId;
  sourceName: string;
  freshPrefix: "effect" | "operation";
}): string => {
  const programSymbol = ctx.program.symbols.idOf({ moduleId, symbol });
  return ctx.program.symbols.isFresh(programSymbol)
    ? `${freshPrefix}_${symbol}`
    : sourceName;
};

const registryEffectAndOpNames = ({
  ctx,
  sourceModuleId,
  effectMeta,
  localEffectIndex,
  opIndex,
}: {
  ctx: CodegenContext;
  sourceModuleId: string;
  effectMeta: CodegenContext["module"]["meta"]["effects"][number] | undefined;
  localEffectIndex: number;
  opIndex: number;
}): { effectName: string; opName: string } => {
  const opMeta = effectMeta?.operations[opIndex];
  return {
    effectName: effectMeta
      ? registrySymbolName({
          ctx,
          moduleId: sourceModuleId,
          symbol: effectMeta.symbol,
          sourceName: effectMeta.name,
          freshPrefix: "effect",
        })
      : `effect_${localEffectIndex}`,
    opName: opMeta
      ? registrySymbolName({
          ctx,
          moduleId: sourceModuleId,
          symbol: opMeta.symbol,
          sourceName: opMeta.name,
          freshPrefix: "operation",
        })
      : `operation_${opIndex}`,
  };
};

export const buildEffectRegistry = (
  contexts: readonly CodegenContext[],
  reachableFunctionSymbols?: ReadonlySet<ProgramSymbolId>,
  includeExternalDeclarations = false,
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
      const owner = ownerByExpr.get(site.exprId);
      const siteReachable =
        owner === undefined ||
        !reachableFunctionSymbols ||
        reachableFunctionSymbols.has(
          ctx.program.symbols.canonicalIdOf(
            ctx.moduleId,
            owner,
          ) as ProgramSymbolId,
        );
      const info = ctx.module.effectsInfo.operations.get(site.effectSymbol);
      if (!info) {
        throw new Error(`missing effect info for op ${site.effectSymbol}`);
      }
      const sourceModuleId = info.sourceModuleId ?? ctx.moduleId;
      const sourceModule = ctx.program.modules.get(sourceModuleId);
      if (!sourceModule) {
        throw new Error(
          `missing source module for effect op ${site.effectSymbol}`,
        );
      }
      const effectIds = effectIdsByModule.get(sourceModuleId);
      if (!effectIds) {
        throw new Error(`missing effect ids for module ${sourceModuleId}`);
      }
      const effectId = effectIds[info.localEffectIndex];
      if (!effectId) {
        throw new Error(
          `missing effect id for ${sourceModuleId}:${info.localEffectIndex}`,
        );
      }
      const effectMeta = sourceModule.meta.effects[info.localEffectIndex];
      const { effectName, opName } = registryEffectAndOpNames({
        ctx,
        sourceModuleId,
        effectMeta,
        localEffectIndex: info.localEffectIndex,
        opIndex: info.opIndex,
      });
      const label = `${sourceModuleId}::${effectName}.${opName}`;
      const resumeKind =
        info.resumable === "tail" ? RESUME_KIND.tail : RESUME_KIND.resume;
      const instances =
        owner !== undefined ? (instancesBySymbol.get(owner) ?? []) : [];
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
        const boundary = boundaryMetadataFor({
          ctx,
          label: `${effectId.id}::${opName}`,
          params: signature.params,
          result: signature.returnType,
        });
        const external =
          effectMeta?.external && boundary
            ? {
                ...boundary,
                ...(!siteReachable ? { declaredOnly: true } : {}),
              }
            : undefined;
        const existing = entriesByKey.get(key);
        if (existing) {
          mergeExternalMetadata({ entry: existing, candidate: external });
          existing.boundary ??= boundary;
          return;
        }
        entriesByKey.set(key, {
          opIndex: -1,
          effectId,
          opId: info.opIndex,
          resumeKind,
          signatureHash,
          label,
          effectName,
          opName,
          operationId: effectMeta?.operations[info.opIndex]?.operationId,
          ...(boundary ? { boundary } : {}),
          ...(external ? { external } : {}),
        });
      });
    });

    ctx.module.effectsIr.info.handlers.forEach((handler, handlerExprId) => {
      const owner = ownerByExpr.get(handlerExprId);
      const instances =
        owner !== undefined ? (instancesBySymbol.get(owner) ?? []) : [];
      const instanceList = instances.length > 0 ? instances : [undefined];

      handler.expr.handlers.forEach((clause) => {
        const resolved = resolveEffectOpRuntimeInfo(clause.operation, ctx);
        if (!resolved) {
          throw new Error(
            `missing effect info for handler op ${clause.operation}`,
          );
        }
        const { info, moduleId } = resolved;
        const sourceModuleId = info.sourceModuleId ?? moduleId;
        const sourceModule = ctx.program.modules.get(sourceModuleId);
        if (!sourceModule) {
          throw new Error(
            `missing source module for handler op ${clause.operation}`,
          );
        }
        const effectIds = effectIdsByModule.get(sourceModuleId);
        const effectId = effectIds?.[info.localEffectIndex];
        if (!effectId) {
          throw new Error(
            `missing effect id for ${sourceModuleId}:${info.localEffectIndex}`,
          );
        }
        const effectMeta = sourceModule.meta.effects[info.localEffectIndex];
        const { effectName, opName } = registryEffectAndOpNames({
          ctx,
          sourceModuleId,
          effectMeta,
          localEffectIndex: info.localEffectIndex,
          opIndex: info.opIndex,
        });
        const label = `${sourceModuleId}::${effectName}.${opName}`;
        const resumeKind =
          info.resumable === "tail" ? RESUME_KIND.tail : RESUME_KIND.resume;

        instanceList.forEach((instanceId) => {
          const signature = resolveHandlerClauseSignature({
            ctx,
            handlerBody: handler.expr.body,
            clause,
            typeInstanceId: instanceId,
          });
          const signatureHash = signatureHashFor({
            params: signature.params,
            returnType: signature.returnType,
            ctx,
          });
          const key = toEffectOpKey(effectId.hash, info.opIndex, signatureHash);
          const boundary = boundaryMetadataFor({
            ctx,
            label: `${effectId.id}::${opName}`,
            params: signature.params,
            result: signature.returnType,
          });
          if (entriesByKey.has(key)) {
            const existing = entriesByKey.get(key)!;
            existing.boundary ??= boundary;
            return;
          }
          entriesByKey.set(key, {
            opIndex: -1,
            effectId,
            opId: info.opIndex,
            resumeKind,
            signatureHash,
            label,
            effectName,
            opName,
            operationId: effectMeta?.operations[info.opIndex]?.operationId,
            ...(boundary ? { boundary } : {}),
          });
        });
      });
    });
  });

  // External effect declarations are interface definitions, so adapter binding
  // generation must see their operations even when the declaring package does
  // not perform them itself.
  if (includeExternalDeclarations) {
    contexts.forEach((ctx) => {
      const effectIds = effectIdsByModule.get(ctx.moduleId) ?? [];
      ctx.module.meta.effects.forEach((effect, localEffectIndex) => {
        if (!effect.external) return;
        const effectId = effectIds[localEffectIndex];
        if (!effectId)
          throw new Error(`missing external effect id for ${effect.name}`);
        effect.operations.forEach((op, opId) => {
          const { effectName, opName } = registryEffectAndOpNames({
            ctx,
            sourceModuleId: ctx.moduleId,
            effectMeta: effect,
            localEffectIndex,
            opIndex: opId,
          });
          const signature = ctx.program.functions.getSignature(
            ctx.moduleId,
            op.symbol,
          );
          if (!signature)
            throw new Error(
              `missing external effect signature for ${effect.name}.${op.name}`,
            );
          if (signature.typeParams.length > 0) {
            throw new Error(
              `generic external effect operations are not supported: ${effect.name}.${op.name}`,
            );
          }
          const params = signature.parameters.map((param) => param.typeId);
          const signatureHash = signatureHashFor({
            params,
            returnType: signature.returnType,
            ctx,
          });
          const key = toEffectOpKey(effectId.hash, opId, signatureHash);
          const external = {
            params: params.map((typeId, index) =>
              withDtoFingerprint(
                deriveBoundarySchema({
                  typeId,
                  ctx,
                  label: `${effectId.id}::${opName} arg${index}`,
                  options: { tagStandaloneVariants: true },
                }),
              ),
            ),
            result: withDtoFingerprint(
              deriveBoundarySchema({
                typeId: signature.returnType,
                ctx,
                label: `${effectId.id}::${opName} result`,
                options: { tagStandaloneVariants: true },
              }),
            ),
            declaredOnly: true,
          };
          const existing = entriesByKey.get(key);
          if (existing) {
            existing.external ??= external;
            existing.boundary ??= external;
            return;
          }
          entriesByKey.set(key, {
            opIndex: -1,
            effectId,
            opId,
            resumeKind:
              op.resumable === "tail" ? RESUME_KIND.tail : RESUME_KIND.resume,
            signatureHash,
            label: `${ctx.moduleId}::${effectName}.${opName}`,
            effectName,
            opName,
            operationId: op.operationId,
            boundary: external,
            external,
          });
        });
      });
    });
  }

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
    const key = toEffectOpKey(
      entry.effectId.hash,
      entry.opId,
      entry.signatureHash,
    );
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
  const sourceModuleId = info.sourceModuleId ?? ctx.moduleId;
  const sourceModule = ctx.program.modules.get(sourceModuleId);
  if (!sourceModule) {
    throw new Error(`missing source module for effect op ${site.effectSymbol}`);
  }
  const effectMeta = sourceModule.meta.effects[info.localEffectIndex];
  const effectId = registry.getEffectId(sourceModuleId, info.localEffectIndex);
  if (!effectId) {
    throw new Error(
      `missing effect id for ${sourceModuleId}:${info.localEffectIndex}`,
    );
  }
  const resumeKind =
    info.resumable === "tail" ? RESUME_KIND.tail : RESUME_KIND.resume;
  const { effectName, opName } = registryEffectAndOpNames({
    ctx,
    sourceModuleId,
    effectMeta,
    localEffectIndex: info.localEffectIndex,
    opIndex: info.opIndex,
  });
  const label = `${sourceModuleId}::${effectName}.${opName}`;
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
      `missing effect op entry for ${label} (effect=${effectId.id}, op=${info.opIndex}, signature=${signatureHash})`,
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
