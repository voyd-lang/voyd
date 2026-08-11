import type { CodegenContext } from "../context.js";
import type { ProgramSymbolId } from "../../semantics/ids.js";
import {
  enqueueMsgPackProviderReachability,
  ensureMsgPackProviderFunctions,
  type MsgPackProviderFunctions,
} from "../host-transport/providers/msgpack.js";

export const SELECTED_HOST_TRANSPORT_IDENTITY = {
  id: "voyd.std.msgpack",
  version: 1,
} as const;

export type SelectedHostTransportProvider = MsgPackProviderFunctions & {
  identity: typeof SELECTED_HOST_TRANSPORT_IDENTITY;
};

/**
 * Resolves the one build-selected transport provider before wrappers are
 * emitted. The first transport release intentionally selects std MessagePack
 * internally; public source-level provider selection is outside this release.
 */
export const ensureSelectedHostTransportProvider = (
  ctx: CodegenContext,
): SelectedHostTransportProvider => ({
  identity: SELECTED_HOST_TRANSPORT_IDENTITY,
  ...ensureMsgPackProviderFunctions(ctx),
});

export const enqueueSelectedHostTransportProviderReachability = ({
  ctx,
  enqueue,
}: {
  ctx: CodegenContext;
  enqueue: (symbol: ProgramSymbolId) => void;
}): void => {
  enqueueMsgPackProviderReachability({ ctx, enqueue });
};
