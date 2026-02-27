import {
  globalRecord,
  hostError,
  hostOk,
  readField,
  toStringOrUndefined,
} from "../helpers.js";
import {
  opEntries,
  registerMissingOpHandlers,
  registerOpHandler,
  registerUnsupportedHandlers,
} from "../registration.js";
import { ENV_EFFECT_ID, type CapabilityDefinition } from "../types.js";

export const envCapabilityDefinition: CapabilityDefinition = {
  capability: "env",
  effectId: ENV_EFFECT_ID,
  register: async ({ host, runtime, diagnostics }) => {
    const entries = opEntries({ host, effectId: ENV_EFFECT_ID });
    if (entries.length === 0) {
      return 0;
    }

    const deno =
      runtime === "deno" ? (globalRecord.Deno as Record<string, unknown>) : undefined;
    const denoEnv = deno?.env as
      | {
          get?: (key: string) => string | undefined;
          set?: (key: string, value: string) => void;
        }
      | undefined;
    const processRecord = globalRecord.process as
      | { env?: Record<string, string | undefined> }
      | undefined;
    const processEnv = runtime === "node" ? processRecord?.env : undefined;

    const hasEnv = !!processEnv || (!!denoEnv?.get && !!denoEnv?.set);
    if (!hasEnv) {
      return registerUnsupportedHandlers({
        host,
        effectId: ENV_EFFECT_ID,
        capability: "env",
        runtime,
        reason: "environment variable APIs are not available",
        diagnostics,
      });
    }

    const implementedOps = new Set<string>();
    let registered = 0;

    registered += registerOpHandler({
      host,
      effectId: ENV_EFFECT_ID,
      opName: "get",
      handler: ({ tail }, keyPayload) => {
        const key = toStringOrUndefined(keyPayload) ?? "";
        try {
          const value = processEnv
            ? processEnv[key]
            : denoEnv?.get
              ? denoEnv.get(key)
              : undefined;
          return tail(value ?? null);
        } catch {
          // Deno can throw when env access is denied; treat as unavailable key.
          return tail(null);
        }
      },
    });
    implementedOps.add("get");

    registered += registerOpHandler({
      host,
      effectId: ENV_EFFECT_ID,
      opName: "set",
      handler: ({ tail }, payload) => {
        try {
          const key = toStringOrUndefined(readField(payload, "key")) ?? "";
          const value = toStringOrUndefined(readField(payload, "value")) ?? "";
          if (processEnv) {
            processEnv[key] = value;
          } else if (denoEnv?.set) {
            denoEnv.set(key, value);
          }
          return tail(hostOk());
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return tail(hostError(message));
        }
      },
    });
    implementedOps.add("set");

    return (
      registered +
      registerMissingOpHandlers({
        host,
        effectId: ENV_EFFECT_ID,
        implementedOps,
        diagnostics,
      })
    );
  },
};
