import {
  scheduleTaskForRuntimePolicy,
  type RuntimeSchedulingKind,
} from "./scheduling-policy.js";

export type HostRuntimeKind = RuntimeSchedulingKind;

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

export const scheduleTaskForRuntime = (
  runtime: HostRuntimeKind
): ((task: () => void) => void) => scheduleTaskForRuntimePolicy(runtime);
