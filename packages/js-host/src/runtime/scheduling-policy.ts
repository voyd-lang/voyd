export type RuntimeSchedulingKind = "node" | "deno" | "browser" | "unknown";

const queueMicrotaskOrPromise = (task: () => void): void => {
  if (typeof queueMicrotask === "function") {
    queueMicrotask(task);
    return;
  }
  Promise.resolve().then(task);
};

const scheduleMacrotaskOrMicrotask = (task: () => void): void => {
  if (typeof setTimeout === "function") {
    setTimeout(task, 0);
    return;
  }
  queueMicrotaskOrPromise(task);
};

const scheduleNodeTaskOrFallback = (task: () => void): void => {
  if (typeof setImmediate === "function") {
    setImmediate(task);
    return;
  }
  scheduleMacrotaskOrMicrotask(task);
};

export const scheduleTaskForRuntimePolicy = (
  runtime: RuntimeSchedulingKind
): ((task: () => void) => void) =>
  runtime === "node"
    ? scheduleNodeTaskOrFallback
    : scheduleMacrotaskOrMicrotask;
