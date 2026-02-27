import type { EffectHandler } from "../../protocol/types.js";
import type {
  DefaultAdapterCapability,
  DefaultAdapterHost,
  EffectOp,
} from "./types.js";

export const opEntries = ({
  host,
  effectId,
}: {
  host: DefaultAdapterHost;
  effectId: string;
}): EffectOp[] => host.table.ops.filter((entry) => entry.effectId === effectId);

export const registerOpHandler = ({
  host,
  effectId,
  opName,
  handler,
}: {
  host: DefaultAdapterHost;
  effectId: string;
  opName: string;
  handler: EffectHandler;
}): number => {
  const matches = host.table.ops.filter(
    (entry) => entry.effectId === effectId && entry.opName === opName
  );
  matches.forEach((entry) => {
    host.registerHandler(entry.effectId, entry.opId, entry.signatureHash, handler);
  });
  return matches.length;
};

export const registerOpAliasHandlers = ({
  host,
  effectId,
  opNames,
  handler,
}: {
  host: DefaultAdapterHost;
  effectId: string;
  opNames: readonly string[];
  handler: EffectHandler;
}): number =>
  opNames.reduce(
    (count, opName) =>
      count +
      registerOpHandler({
        host,
        effectId,
        opName,
        handler,
      }),
    0
  );

export const registerUnsupportedHandlers = ({
  host,
  effectId,
  capability,
  runtime,
  reason,
  diagnostics,
}: {
  host: DefaultAdapterHost;
  effectId: string;
  capability: DefaultAdapterCapability["capability"];
  runtime: string;
  reason: string;
  diagnostics: string[];
}): number => {
  const entries = opEntries({ host, effectId });
  if (entries.length === 0) {
    return 0;
  }
  entries.forEach((entry) => {
    host.registerHandler(entry.effectId, entry.opId, entry.signatureHash, () => {
      throw new Error(
        `Default ${capability} adapter is unavailable on ${runtime} for ${entry.label}. ${reason}. Register a custom handler or avoid using this capability in this runtime.`
      );
    });
  });
  diagnostics.push(
    `Registered unsupported ${capability} stubs for ${effectId} on ${runtime}: ${reason}`
  );
  return entries.length;
};

export const registerMissingOpHandlers = ({
  host,
  effectId,
  implementedOps,
  diagnostics,
}: {
  host: DefaultAdapterHost;
  effectId: string;
  implementedOps: Set<string>;
  diagnostics: string[];
}): number => {
  const unknownOps = opEntries({ host, effectId }).filter(
    (entry) => !implementedOps.has(entry.opName)
  );
  unknownOps.forEach((entry) => {
    host.registerHandler(entry.effectId, entry.opId, entry.signatureHash, () => {
      throw new Error(
        `Default adapter for ${effectId} does not implement op ${entry.opName} (${entry.label}). Update the adapter or register a custom handler for this op.`
      );
    });
  });
  if (unknownOps.length > 0) {
    diagnostics.push(
      `Registered ${unknownOps.length} fallback handlers for unknown ${effectId} ops`
    );
  }
  return unknownOps.length;
};
