type CompilerPerfCounterSnapshot = Map<string, number>;

type CompilerPerfSummary = {
  entryPath: string;
  success: boolean;
  phasesMs: Readonly<Record<string, number>>;
  counters: Readonly<Record<string, number>>;
  diagnostics: number;
};

const COMPILER_PERF_ENV = "VOYD_COMPILER_PERF";

const readPerfEnv = (): string | undefined => {
  const processValue = (globalThis as {
    process?: { env?: Record<string, string | undefined> };
  }).process;
  return processValue?.env?.[COMPILER_PERF_ENV];
};

const PERF_ENABLED = (() => {
  const raw = readPerfEnv();
  if (!raw) return false;
  const normalized = raw.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
})();

const counters = new Map<string, number>();

const roundMs = (value: number): number =>
  Math.round(value * 1000) / 1000;

const toSortedRecord = (
  entries: ReadonlyMap<string, number>,
): Record<string, number> =>
  Object.fromEntries(
    Array.from(entries.entries()).sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  );

export const isCompilerPerfEnabled = (): boolean => PERF_ENABLED;

export const incrementCompilerPerfCounter = (
  name: string,
  amount = 1,
): void => {
  if (!PERF_ENABLED || amount === 0) {
    return;
  }
  counters.set(name, (counters.get(name) ?? 0) + amount);
};

export const snapshotCompilerPerfCounters = (): CompilerPerfCounterSnapshot =>
  PERF_ENABLED ? new Map(counters) : new Map();

export const diffCompilerPerfCounters = ({
  before,
  after,
}: {
  before: ReadonlyMap<string, number>;
  after: ReadonlyMap<string, number>;
}): Record<string, number> => {
  if (!PERF_ENABLED) {
    return {};
  }

  const keys = new Set<string>([...before.keys(), ...after.keys()]);
  const delta = new Map<string, number>();
  keys.forEach((key) => {
    const diff = (after.get(key) ?? 0) - (before.get(key) ?? 0);
    if (diff !== 0) {
      delta.set(key, diff);
    }
  });
  return toSortedRecord(delta);
};

export const normalizeCompilerPerfPhases = (
  phasesMs: Readonly<Record<string, number>>,
): Record<string, number> =>
  Object.fromEntries(
    Object.entries(phasesMs)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([phase, value]) => [phase, roundMs(value)]),
  );

export const logCompilerPerfSummary = ({
  entryPath,
  success,
  phasesMs,
  counters,
  diagnostics,
}: CompilerPerfSummary): void => {
  if (!PERF_ENABLED) {
    return;
  }

  const summary = {
    entryPath,
    success,
    diagnostics,
    phasesMs: normalizeCompilerPerfPhases(phasesMs),
    counters,
  };

  console.error(`[voyd:compiler:perf] ${JSON.stringify(summary)}`);
};
