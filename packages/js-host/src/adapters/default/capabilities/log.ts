import { readField, toStringOrUndefined } from "../helpers.js";
import {
  opEntries,
  registerMissingOpHandlers,
  registerOpHandler,
} from "../registration.js";
import { LOG_EFFECT_ID, type CapabilityDefinition } from "../types.js";

export const logCapabilityDefinition: CapabilityDefinition = {
  capability: "log",
  effectId: LOG_EFFECT_ID,
  register: async ({ host, diagnostics, logWriter }) => {
    const entries = opEntries({ host, effectId: LOG_EFFECT_ID });
    if (entries.length === 0) {
      return 0;
    }

    const implementedOps = new Set<string>();
    const registered = registerOpHandler({
      host,
      effectId: LOG_EFFECT_ID,
      opName: "emit",
      handler: ({ tail }, payload) => {
        const level = toStringOrUndefined(readField(payload, "level")) ?? "info";
        const message =
          toStringOrUndefined(readField(payload, "message")) ??
          String(readField(payload, "message") ?? "");
        const fieldsValue = readField(payload, "fields");
        const fields = Array.isArray(fieldsValue) ? fieldsValue : [];
        const structured = fields.reduce<Record<string, unknown>>((acc, entry) => {
          const key = toStringOrUndefined(readField(entry, "key"));
          if (!key) {
            return acc;
          }
          acc[key] = readField(entry, "value");
          return acc;
        }, {});
        const method = (
          level === "trace"
            ? logWriter.trace
            : level === "debug"
              ? logWriter.debug
              : level === "warn"
                ? logWriter.warn
                : level === "error"
                  ? logWriter.error
                  : logWriter.info
        ).bind(logWriter);
        method(message, structured);
        return tail();
      },
    });
    implementedOps.add("emit");

    return (
      registered +
      registerMissingOpHandlers({
        host,
        effectId: LOG_EFFECT_ID,
        implementedOps,
        diagnostics,
      })
    );
  },
};
