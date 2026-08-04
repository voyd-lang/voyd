import type { CodegenContext, FunctionMetadata } from "./context.js";
import type { HirFunction } from "../semantics/hir/index.js";

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
  if (meta.defaultIdentityGuardEntry) {
    return meta;
  }
  const targetCtx = ctx.moduleContexts.get(meta.moduleId);
  const protocol = targetCtx?.module.callableRuntimeProtocols.get(
    meta.symbol,
  )?.defaultIdentityGuardProtocol;
  if (protocol !== "presence-conflict-bit-v1") {
    throw new Error(
      `callable ${meta.moduleId}::${meta.symbol} does not advertise the default identity-guard protocol`,
    );
  }
  const item = functionItemFor({ ctx, meta });
  if (!item) {
    throw new Error(
      `codegen missing default identity-guard target ${meta.moduleId}::${meta.symbol}`,
    );
  }
  const key = `${meta.moduleId}:${meta.wasmName}`;
  const state = stateOf(ctx);
  const existing = state.byBaseName.get(key);
  if (existing) {
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
};
