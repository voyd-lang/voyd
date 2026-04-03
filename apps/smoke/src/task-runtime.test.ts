import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { createSdk, type CompileResult } from "@voyd-lang/sdk";
import { createDeterministicRuntime, createVoydHost } from "@voyd-lang/sdk/js-host";

const fixtureEntryPath = path.join(
  import.meta.dirname,
  "..",
  "fixtures",
  "task-runtime.voyd"
);

const expectCompileSuccess = (
  result: CompileResult
): Extract<CompileResult, { success: true }> => {
  if (!result.success) {
    throw new Error(result.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
  }
  expect(result.success).toBe(true);
  return result;
};

const createTaskHost = async ({
  compiled,
  onUnhandledTaskFailed,
}: {
  compiled: Extract<CompileResult, { success: true }>;
  onUnhandledTaskFailed?: (error: Error, details: { runId: string; taskId: number }) => void;
}) => {
  const runtime = createDeterministicRuntime();
  const host = await createVoydHost({
    wasm: compiled.wasm,
    scheduler: {
      scheduleTask: runtime.scheduleTask,
      onUnhandledTaskFailed,
    },
    defaultAdapters: {
      runtime: "node",
      runtimeHooks: {
        monotonicNowMillis: runtime.monotonicNowMillis,
        systemNowMillis: runtime.systemNowMillis,
        sleepMillis: runtime.sleepMillis,
      },
    },
  });

  return { host, runtime };
};

const createTaskHostWithCustomTime = async ({
  compiled,
  sleepHandler,
  onUnhandledTaskFailed,
}: {
  compiled: Extract<CompileResult, { success: true }>;
  sleepHandler: (ms: number) => unknown;
  onUnhandledTaskFailed?: (error: Error, details: { runId: string; taskId: number }) => void;
}) => {
  const runtime = createDeterministicRuntime();
  const host = await createVoydHost({
    wasm: compiled.wasm,
    scheduler: {
      scheduleTask: runtime.scheduleTask,
      onUnhandledTaskFailed,
    },
    defaultAdapters: false,
  });
  const monotonicNow = compiled.effects.findUniqueOpByLabelSuffix(
    "Time::monotonic_now_millis"
  );
  const systemNow = compiled.effects.findUniqueOpByLabelSuffix("Time::system_now_millis");
  const sleep = compiled.effects.findUniqueOpByLabelSuffix("Time::sleep_millis");
  host.registerHandler(
    monotonicNow.effectId,
    monotonicNow.opId,
    monotonicNow.signatureHash,
    ({ tail }) => tail(runtime.monotonicNowMillis())
  );
  host.registerHandler(
    systemNow.effectId,
    systemNow.opId,
    systemNow.signatureHash,
    ({ tail }) => tail(runtime.systemNowMillis())
  );
  host.registerHandler(sleep.effectId, sleep.opId, sleep.signatureHash, ({ tail }, ms) =>
    tail(sleepHandler(Number(ms)))
  );
  host.initEffects();

  return { host, runtime };
};

const drainRuntime = async (
  runtime: ReturnType<typeof createDeterministicRuntime>,
  passes = 3
): Promise<void> => {
  for (let index = 0; index < passes; index += 1) {
    await runtime.runUntilIdle();
    await Promise.resolve();
  }
};

const advanceRuntime = async (
  runtime: ReturnType<typeof createDeterministicRuntime>,
  steps: number[]
): Promise<void> => {
  for (const step of steps) {
    await runtime.advanceBy(step);
    await drainRuntime(runtime);
  }
};

describe("smoke: task runtime", () => {
  let compiled: Extract<CompileResult, { success: true }>;

  beforeAll(async () => {
    const sdk = createSdk();
    compiled = expectCompileSuccess(await sdk.compile({ entryPath: fixtureEntryPath }));
  }, 120_000);

  it("runs spawned work asynchronously and joins the result", async () => {
    const { host, runtime } = await createTaskHost({ compiled });
    const outcome = host.run<number>("spawn_join_probe");
    await drainRuntime(runtime);
    await expect(outcome).resolves.toBe(41);
  });

  it("awaits spawned work through Task.await()", async () => {
    const { host, runtime } = await createTaskHost({ compiled });
    const outcome = host.run<number>("spawn_await_probe");
    await drainRuntime(runtime);
    await expect(outcome).resolves.toBe(41);
  });

  it("joins pure bool task values through the public task API", async () => {
    const { host, runtime } = await createTaskHost({ compiled });
    const outcome = host.run<number>("spawn_join_bool_probe");
    await drainRuntime(runtime);
    await expect(outcome).resolves.toBe(1);
  });

  it("joins effectful child task values through the public task API", async () => {
    const { host, runtime } = await createTaskHost({ compiled });
    const outcome = host.run<number>("effectful_join_probe");
    await advanceRuntime(runtime, [5, 5]);
    await expect(outcome).resolves.toBe(7);
  });

  it("yields to other ready tasks through the public task API", async () => {
    const { host, runtime } = await createTaskHost({ compiled });
    const outcome = host.run<number>("yield_now_probe");
    await drainRuntime(runtime);
    await expect(outcome).resolves.toBe(1);
  });

  it("decodes observed child failures through join()", async () => {
    const { host, runtime } = await createTaskHost({ compiled });
    const outcome = host.run<number>("join_failure_probe");
    await drainRuntime(runtime);
    await expect(outcome).resolves.toBe(1);
  });

  it("cancels sleeping tasks and ignores their late completions", async () => {
    const { host, runtime } = await createTaskHost({ compiled });
    const outcome = host.run<number>("cancel_probe");
    await advanceRuntime(runtime, [5, 15, 20]);
    await expect(outcome).resolves.toBe(1);
  });

  it("cancels attached child tasks when their owner is cancelled", async () => {
    const { host, runtime } = await createTaskHost({ compiled });
    const outcome = host.run<number>("owner_cancel_cascades_probe");
    await advanceRuntime(runtime, [5, 20, 20]);
    await expect(outcome).resolves.toBe(0);
  });

  it("surfaces owner failures even when attached children were still live", async () => {
    const { host, runtime } = await createTaskHost({ compiled });
    const outcome = host.run<number>("owner_failure_does_not_hang_probe");
    await advanceRuntime(runtime, [5, 20]);
    await expect(outcome).resolves.toBe(1);
  });

  it("builds timeouts on detached tasks", async () => {
    const { host, runtime } = await createTaskHost({ compiled });
    const outcome = host.run<number>("timeout_probe");
    await advanceRuntime(runtime, [5, 5]);
    await expect(outcome).resolves.toBe(7);
  });

  it("fails timeouts instead of running callbacks when sleep fails", async () => {
    const { host, runtime } = await createTaskHostWithCustomTime({
      compiled,
      sleepHandler: () => ({ ok: false, code: 7, message: "blocked" }),
    });
    const outcome = host.run<number>("timeout_sleep_failure_probe");
    await drainRuntime(runtime);
    await expect(outcome).resolves.toBe(1);
  });

  it("fails interval drivers instead of hot-looping when sleep fails", async () => {
    const unhandledFailures: Array<{ message: string; taskId: number }> = [];
    const { host, runtime } = await createTaskHostWithCustomTime({
      compiled,
      sleepHandler: () => ({ ok: false, code: 7, message: "blocked" }),
      onUnhandledTaskFailed: (error, details) => {
        unhandledFailures.push({
          message: error.message,
          taskId: details.taskId,
        });
      },
    });
    const outcome = host.run<number>("interval_sleep_failure_probe");
    await drainRuntime(runtime);
    await expect(outcome).resolves.toBe(1);
    expect(unhandledFailures).toHaveLength(1);
    expect(unhandledFailures[0]?.message).toBe("blocked");
  });

  it("resumes detached sleeping tasks", async () => {
    const { host, runtime } = await createTaskHost({ compiled });
    const outcome = host.run<number>("timeout_direct_probe");
    await advanceRuntime(runtime, [5, 5]);
    await expect(outcome).resolves.toBe(7);
  });

  it("runs detached tasks that call captured callbacks", async () => {
    const { host, runtime } = await createTaskHost({ compiled });
    const outcome = host.run<number>("detached_callback_probe");
    await drainRuntime(runtime);
    await expect(outcome).resolves.toBe(7);
  });

  it("runs cross-module callbacks after sleeping without task detachment", async () => {
    const { host, runtime } = await createTaskHost({ compiled });
    const outcome = host.run<number>("after_delay_probe");
    await advanceRuntime(runtime, [5, 5]);
    await expect(outcome).resolves.toBe(7);
  });

  it("runs effectful cross-module callbacks after sleeping", async () => {
    const { host, runtime } = await createTaskHost({ compiled });
    const outcome = host.run<number>("after_delay_effectful_probe");
    await advanceRuntime(runtime, [5, 7, 5]);
    await expect(outcome).resolves.toBe(7);
  });

  it("keeps serial intervals non-overlapping", async () => {
    const { host, runtime } = await createTaskHost({ compiled });
    const outcome = host.run<number>("interval_serial_probe");
    await advanceRuntime(runtime, [5, 7, 8, 20]);
    await expect(outcome).resolves.toBe(1);
  });

  it("runs pure serial interval callbacks after sleeping", async () => {
    const { host, runtime } = await createTaskHost({ compiled });
    const outcome = host.run<number>("interval_serial_pure_probe");
    await advanceRuntime(runtime, [5, 5, 5, 5, 20]);
    await expect(outcome).resolves.toBe(3);
  });

  it("allows concurrent interval overlap explicitly", async () => {
    const { host, runtime } = await createTaskHost({ compiled });
    const outcome = host.run<number>("interval_concurrent_probe");
    await advanceRuntime(runtime, [5, 5, 5, 5, 20]);
    await expect(outcome).resolves.toBe(3);
  });

  it("fails owners that complete with unobserved attached child failures", async () => {
    const { host, runtime } = await createTaskHost({ compiled });
    const outcome = host.run<number>("attached_failure_probe");
    await drainRuntime(runtime);
    await expect(outcome).rejects.toThrow(/unobserved child task failure|attached child failed/);
  });

  it("reports unobserved detached child failures without failing the root task", async () => {
    const unhandledFailures: Array<{ message: string; taskId: number }> = [];
    const { host, runtime } = await createTaskHost({
      compiled,
      onUnhandledTaskFailed: (error, details) => {
        unhandledFailures.push({
          message: error.message,
          taskId: details.taskId,
        });
      },
    });
    const outcome = host.run<number>("detached_failure_probe");
    await drainRuntime(runtime);
    await expect(outcome).resolves.toBe(1);
    expect(unhandledFailures).toHaveLength(1);
    expect(unhandledFailures[0]?.message).toMatch(/detached child failed/);
  });
});
