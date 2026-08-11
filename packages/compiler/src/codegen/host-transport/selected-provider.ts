import type { CodegenContext } from "../context.js";
import type { ProgramSymbolId } from "../../semantics/ids.js";
import { MSGPACK_HOST_TRANSPORT_PROVIDER } from "../host-transport/providers/msgpack.js";
import type {
  HostTransportIdentity,
  HostTransportProviderFunctions,
} from "./provider.js";

const BUILD_SELECTED_HOST_TRANSPORT_PROVIDER = MSGPACK_HOST_TRANSPORT_PROVIDER;

export const SELECTED_HOST_TRANSPORT_IDENTITY =
  BUILD_SELECTED_HOST_TRANSPORT_PROVIDER.identity;

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
): SelectedHostTransportProvider => ({
  identity: SELECTED_HOST_TRANSPORT_IDENTITY,
  ...BUILD_SELECTED_HOST_TRANSPORT_PROVIDER.ensureFunctions(ctx),
});

export const enqueueSelectedHostTransportProviderReachability = ({
  ctx,
  enqueue,
}: {
  ctx: CodegenContext;
  enqueue: (symbol: ProgramSymbolId) => void;
}): void => {
  BUILD_SELECTED_HOST_TRANSPORT_PROVIDER.enqueueReachability({ ctx, enqueue });
};
