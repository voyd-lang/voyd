import { CAPABILITIES } from "./default/capabilities/index.js";
import { normalizeEffectBufferSize } from "./default/helpers.js";
import { opEntries } from "./default/registration.js";
import type {
  DefaultAdapterCapability,
  DefaultAdapterHost,
  DefaultAdapterOptions,
  DefaultAdapterRegistration,
} from "./default/types.js";
import { detectHostRuntime } from "../runtime/environment.js";

export type {
  DefaultAdapterCapability,
  DefaultAdapterFetchHeader,
  DefaultAdapterFetchRequest,
  DefaultAdapterFetchResponse,
  DefaultAdapterHost,
  DefaultAdapterOptions,
  DefaultAdapterOutputFlush,
  DefaultAdapterOutputTarget,
  DefaultAdapterOutputWrite,
  DefaultAdapterOutputWriteBytes,
  DefaultAdapterRegistration,
  DefaultAdapterRuntimeHooks,
} from "./default/types.js";

export const registerDefaultHostAdapters = async ({
  host,
  options = {},
}: {
  host: DefaultAdapterHost;
  options?: DefaultAdapterOptions;
}): Promise<DefaultAdapterRegistration> => {
  const runtime =
    options.runtime && options.runtime !== "auto"
      ? options.runtime
      : detectHostRuntime();
  const diagnostics: string[] = [];
  const capabilities: DefaultAdapterCapability[] = [];
  let registeredOps = 0;
  const logWriter = options.logWriter ?? console;
  const runtimeHooks = options.runtimeHooks ?? {};
  const effectBufferSize = normalizeEffectBufferSize(options.effectBufferSize);

  for (const capability of CAPABILITIES) {
    const count = await capability.register({
      host,
      runtime,
      diagnostics,
      logWriter,
      runtimeHooks,
      effectBufferSize,
    });
    const hasEffect = opEntries({ host, effectId: capability.effectId }).length > 0;
    if (!hasEffect) {
      continue;
    }
    const unsupported = diagnostics.some(
      (line) =>
        line.startsWith("Registered unsupported") &&
        line.includes(` ${capability.effectId} `)
    );
    capabilities.push({
      capability: capability.capability,
      effectId: capability.effectId,
      registeredOps: count,
      supported: !unsupported,
      reason: unsupported
        ? diagnostics.find((line) => line.includes(` ${capability.effectId} `))
        : undefined,
    });
    registeredOps += count;
  }

  diagnostics.forEach((message) => {
    options.onDiagnostic?.(message);
  });

  return {
    runtime,
    registeredOps,
    capabilities,
  };
};
