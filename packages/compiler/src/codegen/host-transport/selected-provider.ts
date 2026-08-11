import type { CodegenContext } from "../context.js";
import type { ProgramSymbolId } from "../../semantics/ids.js";
import { MSGPACK_HOST_TRANSPORT_PROVIDER } from "../host-transport/providers/msgpack.js";
import type {
  HostTransportIdentity,
  HostTransportProviderFunctions,
} from "./provider.js";

const BUILD_SELECTED_HOST_TRANSPORT_PROVIDER = MSGPACK_HOST_TRANSPORT_PROVIDER;
const HOST_TRANSPORT_PROVIDER_INTRINSIC = "voyd.std.host-transport-provider";

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
  identity: selectedProviderIdentity(ctx),
  ...BUILD_SELECTED_HOST_TRANSPORT_PROVIDER.ensureFunctions(ctx),
});

export const enqueueSelectedHostTransportProviderReachability = ({
  ctx,
  enqueue,
}: {
  ctx: CodegenContext;
  enqueue: (symbol: ProgramSymbolId) => void;
}): void => {
  selectedProviderIdentity(ctx);
  BUILD_SELECTED_HOST_TRANSPORT_PROVIDER.enqueueReachability({ ctx, enqueue });
};

const selectedProviderIdentity = (
  ctx: CodegenContext,
): HostTransportIdentity => {
  const expected = BUILD_SELECTED_HOST_TRANSPORT_PROVIDER.identity;
  const selected = ctx.program.symbols
    .hostTransportDeclarations()
    .filter(
      ({ declaration }) =>
        declaration.id === expected.id && declaration.version === expected.version,
    );
  if (selected.length !== 1) {
    throw new Error(
      selected.length === 0
        ? `missing @host_transport(id: "${expected.id}", version: ${expected.version}) declaration`
        : `duplicate @host_transport declaration for ${expected.id}@${expected.version}`,
    );
  }
  const provider = selected[0]!;
  if (ctx.program.symbols.getPackageId(provider.symbol) !== "std") {
    throw new Error(
      "the selected host transport provider is not a registered link root",
    );
  }
  const template = ctx.program.objects.getTemplate(provider.symbol);
  if (!template || template.fields.length !== 0 || template.params.length !== 0) {
    throw new Error("@host_transport must annotate a stateless object");
  }
  const markerTrait = ctx.program.symbols.resolveIntrinsicType(
    HOST_TRANSPORT_PROVIDER_INTRINSIC,
  );
  const marker =
    markerTrait === undefined
      ? undefined
      : ctx.program.traits
          .getImplTemplates()
          .find(
            (impl) =>
              ctx.program.symbols.getName(impl.traitSymbol) ===
                ctx.program.symbols.getName(markerTrait) &&
              ctx.program.types.getNominalOwner(impl.target) === provider.symbol,
          );
  if (!marker) {
    throw new Error(
      "@host_transport provider must implement the compiler-known HostTransportProvider trait",
    );
  }
  return provider.declaration;
};
