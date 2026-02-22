const DEFAULT_MAX_DRAIN_TURNS = 10_000;

type ScheduledTimer = {
  callback: () => void;
  dueAtMs: number;
  order: number;
};

export type DeterministicRuntimeOptions = {
  startMonotonicMs?: number;
  startSystemMs?: number;
  maxDrainTurns?: number;
};

export type DeterministicRuntime = {
  scheduleTask: (task: () => void) => void;
  sleepMillis: (ms: number) => Promise<void>;
  monotonicNowMillis: () => bigint;
  systemNowMillis: () => bigint;
  advanceBy: (ms: number) => Promise<void>;
  advanceTo: (monotonicMs: number) => Promise<void>;
  runUntilIdle: () => Promise<void>;
  nowMonotonicMs: () => number;
  pendingTaskCount: () => number;
  pendingTimerCount: () => number;
};

const normalizeInteger = ({
  value,
  fallback,
  minimum,
}: {
  value: number | undefined;
  fallback: number;
  minimum: number;
}): number => {
  if (value === undefined || !Number.isFinite(value)) {
    return fallback;
  }
  const normalized = Math.trunc(value);
  return normalized < minimum ? minimum : normalized;
};

const sortTimers = (timers: ScheduledTimer[]): void => {
  timers.sort((left, right) =>
    left.dueAtMs === right.dueAtMs
      ? left.order - right.order
      : left.dueAtMs - right.dueAtMs
  );
};

export const createDeterministicRuntime = (
  options: DeterministicRuntimeOptions = {}
): DeterministicRuntime => {
  const maxDrainTurns = normalizeInteger({
    value: options.maxDrainTurns,
    fallback: DEFAULT_MAX_DRAIN_TURNS,
    minimum: 1,
  });
  let monotonicMs = normalizeInteger({
    value: options.startMonotonicMs,
    fallback: 0,
    minimum: 0,
  });
  let systemMs = normalizeInteger({
    value: options.startSystemMs,
    fallback: monotonicMs,
    minimum: 0,
  });
  let nextTimerOrder = 1;

  const tasks: Array<() => void> = [];
  const timers: ScheduledTimer[] = [];

  const scheduleTask = (task: () => void): void => {
    tasks.push(task);
  };

  const enqueueTimer = (delayMs: number, callback: () => void): void => {
    const normalizedDelay = normalizeInteger({
      value: delayMs,
      fallback: 0,
      minimum: 0,
    });
    timers.push({
      callback,
      dueAtMs: monotonicMs + normalizedDelay,
      order: nextTimerOrder++,
    });
    sortTimers(timers);
  };

  const shiftDueTimers = (): ScheduledTimer[] => {
    const due: ScheduledTimer[] = [];
    while (timers.length > 0) {
      const next = timers[0];
      if (!next || next.dueAtMs > monotonicMs) {
        break;
      }
      const timer = timers.shift();
      if (timer) {
        due.push(timer);
      }
    }
    return due;
  };

  const moveTo = (targetMonotonicMs: number): void => {
    if (!Number.isFinite(targetMonotonicMs)) {
      throw new Error("target monotonic time must be finite");
    }
    const normalizedTarget = Math.trunc(targetMonotonicMs);
    if (normalizedTarget < monotonicMs) {
      throw new Error(
        `cannot move deterministic runtime backwards (${normalizedTarget} < ${monotonicMs})`
      );
    }
    const delta = normalizedTarget - monotonicMs;
    monotonicMs = normalizedTarget;
    systemMs += delta;
  };

  const drainTasks = async (): Promise<void> => {
    for (let turn = 0; turn < maxDrainTurns; turn += 1) {
      while (tasks.length > 0) {
        const task = tasks.shift();
        task?.();
      }
      await Promise.resolve();
      if (tasks.length === 0) {
        await Promise.resolve();
        if (tasks.length === 0) {
          return;
        }
      }
    }
    throw new Error("deterministic runtime exceeded max task-drain turns");
  };

  const runUntilIdle = async (): Promise<void> => {
    for (let turn = 0; turn < maxDrainTurns; turn += 1) {
      await drainTasks();
      const dueTimers = shiftDueTimers();
      if (dueTimers.length === 0) {
        if (tasks.length === 0) {
          return;
        }
        continue;
      }
      dueTimers.forEach((timer) => {
        timer.callback();
      });
    }
    throw new Error("deterministic runtime exceeded max idle-drain turns");
  };

  const advanceTo = async (targetMonotonicMs: number): Promise<void> => {
    const target = Math.trunc(targetMonotonicMs);
    if (target < monotonicMs) {
      throw new Error(
        `cannot advance deterministic runtime backwards (${target} < ${monotonicMs})`
      );
    }
    for (let turn = 0; turn < maxDrainTurns; turn += 1) {
      await runUntilIdle();
      const nextTimer = timers[0];
      if (!nextTimer || nextTimer.dueAtMs > target) {
        moveTo(target);
        await runUntilIdle();
        return;
      }
      moveTo(nextTimer.dueAtMs);
    }
    throw new Error("deterministic runtime exceeded max time-advance turns");
  };

  return {
    scheduleTask,
    sleepMillis: async (ms: number): Promise<void> =>
      new Promise((resolve) => {
        enqueueTimer(ms, resolve);
      }),
    monotonicNowMillis: () => BigInt(monotonicMs),
    systemNowMillis: () => BigInt(systemMs),
    advanceBy: (ms: number) => advanceTo(monotonicMs + Math.max(0, Math.trunc(ms))),
    advanceTo,
    runUntilIdle,
    nowMonotonicMs: () => monotonicMs,
    pendingTaskCount: () => tasks.length,
    pendingTimerCount: () => timers.length,
  };
};
