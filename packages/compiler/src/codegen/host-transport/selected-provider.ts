import type { CodegenContext } from "../context.js";
import type { ProgramSymbolId } from "../../semantics/ids.js";
import {
  resolveSelectedHostTransportProvider,
  SELECTED_HOST_TRANSPORT_IMPLEMENTATION,
} from "../../compiler-contracts/index.js";
import { requireFunctionMeta } from "../function-lookup.js";
import { stateFor } from "../effects/host-boundary/state.js";
import type {
  HostTransportIdentity,
  HostTransportProviderFunctions,
} from "./provider.js";

const SELECTED_PROVIDER_KEY = Symbol("voyd.hostTransport.selectedProvider");
const REACHABILITY_STATE = Symbol.for("voyd.codegen.reachabilityState");

type ReachabilityState = { symbols?: Set<ProgramSymbolId> };

export type SelectedHostTransportProvider = HostTransportProviderFunctions & {
  identity: HostTransportIdentity;
};

/**
 * Resolves the one build-selected transport provider before wrappers are
 * emitted. The first transport release intentionally selects std MessagePack
 * internally; public source-level provider selection is outside this release.
 */
export const ensureSelectedHostTransportProvider = (
  ctx: CodegenContext,
): SelectedHostTransportProvider =>
  stateFor(ctx, SELECTED_PROVIDER_KEY, () => {
    const resolved = resolveSelectedHostTransportProvider(ctx.program);
    const functions = {
      createReader: requireMeta(ctx, resolved.functions.createReader),
      readerComplete: requireMeta(ctx, resolved.functions.readerComplete),
      createWriter: requireMeta(ctx, resolved.functions.createWriter),
      finishWriter: requireMeta(ctx, resolved.functions.finishWriter),
    };
    [
      ...Object.values(resolved.functions),
      ...resolved.readerImplementation.methods.map(
        ({ implMethod }) => implMethod,
      ),
      ...resolved.writerImplementation.methods.map(
        ({ implMethod }) => implMethod,
      ),
    ].forEach((symbol) => markReachable({ ctx, symbol }));
    return {
      identity: resolved.identity,
      readerTypeId: resolved.readerTypeId,
      writerTypeId: resolved.writerTypeId,
      ...functions,
    };
  });

export const buildSelectedHostTransportIdentity =
  (): HostTransportIdentity => ({
    id: SELECTED_HOST_TRANSPORT_IMPLEMENTATION.id,
    version: SELECTED_HOST_TRANSPORT_IMPLEMENTATION.version,
  });

export const enqueueSelectedHostTransportProviderReachability = ({
  ctx,
  enqueue,
}: {
  ctx: CodegenContext;
  enqueue: (symbol: ProgramSymbolId) => void;
}): void => {
  const resolved = resolveSelectedHostTransportProvider(ctx.program);
  Object.values(resolved.functions).forEach(enqueue);
  resolved.readerImplementation.methods.forEach(({ implMethod }) =>
    enqueue(implMethod),
  );
  resolved.writerImplementation.methods.forEach(({ implMethod }) =>
    enqueue(implMethod),
  );
};

const requireMeta = (ctx: CodegenContext, symbol: ProgramSymbolId) => {
  const ref = ctx.program.symbols.refOf(symbol);
  return requireFunctionMeta({
    ctx,
    moduleId: ref.moduleId,
    symbol: ref.symbol,
  });
};

const markReachable = ({
  ctx,
  symbol,
}: {
  ctx: CodegenContext;
  symbol: ProgramSymbolId;
}): void => {
  const state = ctx.programHelpers.getHelperState<ReachabilityState>(
    REACHABILITY_STATE,
    () => ({ symbols: new Set<ProgramSymbolId>() }),
  );
  const symbols = state.symbols ?? new Set<ProgramSymbolId>();
  state.symbols = symbols;
  const ref = ctx.program.symbols.refOf(symbol);
  symbols.add(
    ctx.program.symbols.canonicalIdOf(
      ref.moduleId,
      ref.symbol,
    ) as ProgramSymbolId,
  );
};
