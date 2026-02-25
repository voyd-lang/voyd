import type { RunOutcome, VoydRunHandle } from "../protocol/types.js";

const DEFAULT_MAX_INTERNAL_STEPS_PER_TICK = 1024;

export type RuntimeSchedulerOptions = {
  maxInternalStepsPerTick?: number;
  scheduleTask?: (task: () => void) => void;
  onRunFailed?: (error: Error, runId: string) => void;
};

export type RuntimeStepResult<T = unknown> =
  | { kind: "next"; result: unknown }
  | { kind: "aborted" }
  | { kind: "value"; value: T };

export type RuntimeStepContext = {
  isCancelled: () => boolean;
};

type RuntimeStep<T> = (
  result: unknown,
  context: RuntimeStepContext
) => RuntimeStepResult<T> | Promise<RuntimeStepResult<T>>;

type ActiveRun = {
  id: string;
  result: unknown;
  status: "ready" | "waiting" | "terminal";
  step: RuntimeStep<unknown>;
  resolveOutcome: (outcome: RunOutcome<unknown>) => void;
};

type ExternalEvent =
  | { kind: "step"; runId: string; result: RuntimeStepResult<unknown> }
  | { kind: "failed"; runId: string; error: unknown };

const toError = (error: unknown): Error =>
  error instanceof Error ? error : new Error(String(error));

const defaultScheduleTask = (task: () => void): void => {
  if (typeof setTimeout === "function") {
    setTimeout(task, 0);
    return;
  }
  if (typeof queueMicrotask === "function") {
    queueMicrotask(task);
    return;
  }
  Promise.resolve().then(task);
};

const normalizeBudget = (value?: number): number => {
  if (!Number.isFinite(value) || value === undefined) {
    return DEFAULT_MAX_INTERNAL_STEPS_PER_TICK;
  }
  const floored = Math.floor(value);
  return floored > 0 ? floored : 1;
};

export const createRuntimeScheduler = ({
  maxInternalStepsPerTick,
  scheduleTask = defaultScheduleTask,
  onRunFailed,
}: RuntimeSchedulerOptions = {}) => {
  const budgetPerTick = normalizeBudget(maxInternalStepsPerTick);
  const runs = new Map<string, ActiveRun>();
  const readyQueue: string[] = [];
  const externalQueue: ExternalEvent[] = [];

  let nextRunId = 1;
  let pumping = false;
  let pumpScheduled = false;

  const schedulePump = (): void => {
    if (pumpScheduled) return;
    pumpScheduled = true;
    scheduleTask(() => {
      pumpScheduled = false;
      pump();
    });
  };

  const finalizeRun = (run: ActiveRun, outcome: RunOutcome<unknown>): void => {
    if (run.status === "terminal") return;
    run.status = "terminal";
    runs.delete(run.id);
    run.resolveOutcome(outcome);
    if (outcome.kind === "failed") {
      try {
        onRunFailed?.(outcome.error, run.id);
      } catch {
        // Swallow observer errors to keep scheduler behavior deterministic.
      }
    }
  };

  const enqueueReady = (run: ActiveRun): void => {
    if (run.status === "terminal" || run.status === "ready") return;
    run.status = "ready";
    readyQueue.push(run.id);
  };

  const processExternalEvents = (): void => {
    while (externalQueue.length > 0) {
      const event = externalQueue.shift();
      if (!event) continue;
      const run = runs.get(event.runId);
      if (!run || run.status === "terminal") continue;
      if (event.kind === "failed") {
        finalizeRun(run, { kind: "failed", error: toError(event.error) });
        continue;
      }
      if (event.result.kind === "aborted") {
        finalizeRun(run, {
          kind: "failed",
          error: new Error(
            `runtime step for ${run.id} reported aborted while run was still active`
          ),
        });
        continue;
      }
      if (event.result.kind === "value") {
        finalizeRun(run, { kind: "value", value: event.result.value });
        continue;
      }
      run.result = event.result.result;
      enqueueReady(run);
    }
  };

  const processReadyRun = (run: ActiveRun): void => {
    if (run.status === "terminal") return;

    run.status = "waiting";
    let pending: Promise<RuntimeStepResult<unknown>>;
    try {
      pending = Promise.resolve(
        run.step(run.result, {
          isCancelled: () => run.status === "terminal",
        })
      );
    } catch (error) {
      finalizeRun(run, { kind: "failed", error: toError(error) });
      return;
    }
    pending.then(
      (result) => {
        externalQueue.push({ kind: "step", runId: run.id, result });
        schedulePump();
      },
      (error) => {
        externalQueue.push({ kind: "failed", runId: run.id, error });
        schedulePump();
      }
    );
  };

  const pump = (): void => {
    if (pumping) return;
    pumping = true;
    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        processExternalEvents();
        let usedBudget = 0;
        while (usedBudget < budgetPerTick && readyQueue.length > 0) {
          const runId = readyQueue.shift();
          if (!runId) continue;
          const run = runs.get(runId);
          if (!run || run.status !== "ready") continue;
          processReadyRun(run);
          usedBudget += 1;
        }

        if (readyQueue.length === 0) {
          if (externalQueue.length === 0) {
            break;
          }
          continue;
        }

        schedulePump();
        break;
      }
    } finally {
      pumping = false;
    }
  };

  const startRun = <T>({
    start,
    step,
  }: {
    start: () => unknown;
    step: RuntimeStep<T>;
  }): VoydRunHandle<T> => {
    const id = `run_${nextRunId++}`;
    let resolveOutcome: ((outcome: RunOutcome<unknown>) => void) | undefined;
    const outcome = new Promise<RunOutcome<unknown>>((resolve) => {
      resolveOutcome = resolve;
    });
    if (!resolveOutcome) {
      throw new Error("failed to initialize run outcome promise");
    }

    const run: ActiveRun = {
      id,
      result: undefined,
      status: "waiting",
      step: step as RuntimeStep<unknown>,
      resolveOutcome,
    };
    runs.set(id, run);

    try {
      run.result = start();
    } catch (error) {
      finalizeRun(run, { kind: "failed", error: toError(error) });
      return {
        id,
        outcome: outcome as Promise<RunOutcome<T>>,
        cancel: () => false,
      };
    }

    enqueueReady(run);
    schedulePump();

    return {
      id,
      outcome: outcome as Promise<RunOutcome<T>>,
      cancel: (reason?: unknown): boolean => {
        const active = runs.get(id);
        if (!active || active.status === "terminal") {
          return false;
        }
        finalizeRun(active, { kind: "cancelled", reason });
        return true;
      },
    };
  };

  return {
    startRun,
  };
};
