import type { CodegenContext, FunctionMetadata } from "./context.js";
import type { HirFunction } from "../semantics/hir/index.js";
import { incrementCompilerPerfCounter } from "../perf.js";
import type { DefaultIdentityGuardCompanionFallbackReason } from "../perf-counter-schema.js";

export interface DefaultIdentityGuardEntry {
  base: FunctionMetadata;
  meta: FunctionMetadata;
  item: HirFunction;
}

type DefaultIdentityGuardEntryState = {
  byBaseName: Map<string, DefaultIdentityGuardEntry>;
  pending: DefaultIdentityGuardEntry[];
  compiled: Set<string>;
};

const DEFAULT_IDENTITY_GUARD_ENTRY_STATE = Symbol(
  "voyd.codegen.defaultIdentityGuardEntryState",
);

const recordDefaultIdentityGuardCompanionFallback = (
  reason: DefaultIdentityGuardCompanionFallbackReason,
): void =>
  incrementCompilerPerfCounter(
    `codegen.default_identity_guard_companion.fallback.${reason}`,
  );

const stateOf = (ctx: CodegenContext): DefaultIdentityGuardEntryState =>
  ctx.programHelpers.getHelperState<DefaultIdentityGuardEntryState>(
    DEFAULT_IDENTITY_GUARD_ENTRY_STATE,
    () => ({
      byBaseName: new Map(),
      pending: [],
      compiled: new Set(),
    }),
  );

const functionItemFor = ({
  ctx,
  meta,
}: {
  ctx: CodegenContext;
  meta: FunctionMetadata;
}): HirFunction | undefined => {
  const targetCtx = ctx.moduleContexts.get(meta.moduleId);
  const targetModule =
    targetCtx?.module ?? ctx.program.modules.get(meta.moduleId);
  return Array.from(targetModule?.hir.items.values() ?? []).find(
    (item): item is HirFunction =>
      item.kind === "function" && item.symbol === meta.symbol,
  );
};

/**
 * Returns the ABI-compatible entry that accepts the deferred conflict bit.
 * The ordinary entry remains free of identity-guard branches.
 */
export const getOrCreateDefaultIdentityGuardEntry = ({
  ctx,
  meta,
}: {
  ctx: CodegenContext;
  meta: FunctionMetadata;
}): FunctionMetadata => {
  incrementCompilerPerfCounter(
    "codegen.default_identity_guard_companion.requested",
  );
  if (meta.defaultIdentityGuardEntry) {
    incrementCompilerPerfCounter(
      "codegen.default_identity_guard_companion.reused",
    );
    return meta;
  }
  const targetCtx = ctx.moduleContexts.get(meta.moduleId);
  const targetModule =
    targetCtx?.module ?? ctx.program.modules.get(meta.moduleId);
  if (!targetModule?.defaultIdentityGuardTargets.has(meta.symbol)) {
    recordDefaultIdentityGuardCompanionFallback("missing-protocol");
    throw new Error(
      `callable ${meta.moduleId}::${meta.symbol} does not advertise the default identity-guard protocol`,
    );
  }
  const item = functionItemFor({ ctx, meta });
  if (!item) {
    recordDefaultIdentityGuardCompanionFallback("missing-body");
    throw new Error(
      `codegen missing default identity-guard target ${meta.moduleId}::${meta.symbol}`,
    );
  }
  const key = `${meta.moduleId}:${meta.wasmName}`;
  const state = stateOf(ctx);
  const existing = state.byBaseName.get(key);
  if (existing) {
    incrementCompilerPerfCounter(
      "codegen.default_identity_guard_companion.reused",
    );
    return existing.meta;
  }
  const guardedMeta: FunctionMetadata = {
    ...meta,
    wasmName: `${meta.wasmName}__default_identity_guard_v1`,
    defaultIdentityGuardEntry: true,
  };
  const entry = { base: meta, meta: guardedMeta, item };
  state.byBaseName.set(key, entry);
  state.pending.push(entry);
  incrementCompilerPerfCounter(
    "codegen.default_identity_guard_companion.created",
  );
  return guardedMeta;
};

export const takePendingDefaultIdentityGuardEntries = (
  ctx: CodegenContext,
): DefaultIdentityGuardEntry[] => {
  const state = stateOf(ctx);
  const pending = state.pending.filter(
    (entry) =>
      entry.meta.moduleId === ctx.moduleId &&
      !state.compiled.has(entry.meta.wasmName),
  );
  state.pending = state.pending.filter(
    (entry) =>
      entry.meta.moduleId !== ctx.moduleId &&
      !state.compiled.has(entry.meta.wasmName),
  );
  return pending;
};

export const markDefaultIdentityGuardEntryCompiled = ({
  ctx,
  wasmName,
}: {
  ctx: CodegenContext;
  wasmName: string;
}): void => {
  stateOf(ctx).compiled.add(wasmName);
  incrementCompilerPerfCounter(
    "codegen.default_identity_guard_companion.compiled",
  );
};
