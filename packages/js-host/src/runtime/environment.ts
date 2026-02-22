export type HostRuntimeKind = "node" | "deno" | "browser" | "unknown";

export const detectHostRuntime = (): HostRuntimeKind => {
  const globalRecord = globalThis as Record<string, unknown>;
  const deno = globalRecord.Deno as { version?: { deno?: string } } | undefined;
  if (deno?.version?.deno) {
    return "deno";
  }

  const processRecord = globalRecord.process as
    | { versions?: { node?: string } }
    | undefined;
  if (processRecord?.versions?.node) {
    return "node";
  }

  if (
    typeof globalRecord.window === "object" &&
    typeof globalRecord.document === "object"
  ) {
    return "browser";
  }

  return "unknown";
};

const queueMicrotaskOrPromise = (task: () => void): void => {
  if (typeof queueMicrotask === "function") {
    queueMicrotask(task);
    return;
  }
  Promise.resolve().then(task);
};

export const scheduleTaskForRuntime = (
  runtime: HostRuntimeKind
): ((task: () => void) => void) => {
  if (runtime === "node" && typeof setImmediate === "function") {
    return (task) => {
      setImmediate(task);
    };
  }
  return queueMicrotaskOrPromise;
};
