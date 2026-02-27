import {
  globalRecord,
  hostOk,
  sleepInChunks,
  toI64,
  toNonNegativeI64,
} from "../helpers.js";
import {
  opEntries,
  registerMissingOpHandlers,
  registerOpHandler,
  registerUnsupportedHandlers,
} from "../registration.js";
import { TIME_EFFECT_ID, type CapabilityDefinition } from "../types.js";

const monotonicNow = ({
  monotonicNowMillis,
}: {
  monotonicNowMillis?: () => bigint;
}): bigint => {
  if (monotonicNowMillis) {
    return monotonicNowMillis();
  }
  const perf = globalRecord.performance as { now?: () => number } | undefined;
  if (typeof perf?.now === "function") {
    return BigInt(Math.trunc(perf.now()));
  }
  return BigInt(Date.now());
};

const systemNow = ({
  systemNowMillis,
}: {
  systemNowMillis?: () => bigint;
}): bigint => {
  if (systemNowMillis) {
    return systemNowMillis();
  }
  return BigInt(Date.now());
};

export const timeCapabilityDefinition: CapabilityDefinition = {
  capability: "timer",
  effectId: TIME_EFFECT_ID,
  register: async ({ host, runtime, diagnostics, runtimeHooks }) => {
    const entries = opEntries({ host, effectId: TIME_EFFECT_ID });
    if (entries.length === 0) {
      return 0;
    }

    const hasSleepHook = typeof runtimeHooks.sleepMillis === "function";
    if (!hasSleepHook && typeof setTimeout !== "function") {
      return registerUnsupportedHandlers({
        host,
        effectId: TIME_EFFECT_ID,
        capability: "timer",
        runtime,
        reason: "setTimeout is unavailable",
        diagnostics,
      });
    }

    const implementedOps = new Set<string>();
    let nextTimerId = 1n;
    const waitForMillis = async (totalMillis: bigint): Promise<void> => {
      const sleepHook = runtimeHooks.sleepMillis;
      const sleepChunk = sleepHook
        ? (milliseconds: number) => sleepHook(milliseconds)
        : (milliseconds: number) =>
            new Promise<void>((resolve) => {
              setTimeout(resolve, milliseconds);
            });
      await sleepInChunks({
        totalMillis,
        sleep: sleepChunk,
      });
    };

    let registered = 0;
    registered += registerOpHandler({
      host,
      effectId: TIME_EFFECT_ID,
      opName: "monotonic_now_millis",
      handler: ({ tail }) => tail(monotonicNow(runtimeHooks)),
    });
    implementedOps.add("monotonic_now_millis");

    registered += registerOpHandler({
      host,
      effectId: TIME_EFFECT_ID,
      opName: "system_now_millis",
      handler: ({ tail }) => tail(systemNow(runtimeHooks)),
    });
    implementedOps.add("system_now_millis");

    registered += registerOpHandler({
      host,
      effectId: TIME_EFFECT_ID,
      opName: "sleep_millis",
      handler: async ({ tail }, ms) => {
        const sleepMillis = toNonNegativeI64(ms);
        await waitForMillis(sleepMillis);
        return tail(hostOk());
      },
    });
    implementedOps.add("sleep_millis");

    registered += registerOpHandler({
      host,
      effectId: TIME_EFFECT_ID,
      opName: "set_timeout_millis",
      handler: async ({ tail }, ms) => {
        await waitForMillis(toNonNegativeI64(ms));
        return tail(hostOk());
      },
    });
    implementedOps.add("set_timeout_millis");

    registered += registerOpHandler({
      host,
      effectId: TIME_EFFECT_ID,
      opName: "set_interval_millis",
      handler: async ({ tail }, ms) => {
        await waitForMillis(toNonNegativeI64(ms));
        const timerId = nextTimerId;
        nextTimerId += 1n;
        return tail(hostOk(timerId));
      },
    });
    implementedOps.add("set_interval_millis");

    registered += registerOpHandler({
      host,
      effectId: TIME_EFFECT_ID,
      opName: "clear_timer",
      handler: async ({ tail }, timerIdValue) => {
        if (typeof runtimeHooks.clearTimer === "function") {
          await runtimeHooks.clearTimer(toI64(timerIdValue));
        }
        return tail(hostOk());
      },
    });
    implementedOps.add("clear_timer");

    return (
      registered +
      registerMissingOpHandlers({
        host,
        effectId: TIME_EFFECT_ID,
        implementedOps,
        diagnostics,
      })
    );
  },
};
