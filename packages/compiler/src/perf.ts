type CompilerPerfCounterSnapshot = Map<string, number>;
type CompilerPerfPhaseSnapshot = Map<string, number>;

type CompilerPerfSummary = {
  entryPath: string;
  success: boolean;
  phasesMs: Readonly<Record<string, number>>;
  counters: Readonly<Record<string, number>>;
  diagnostics: number;
  overlapped?: boolean;
};

export type CompilerPerfSession = {
  entryPath: string;
  enabled: boolean;
  startedAt: number;
  countersBefore?: CompilerPerfCounterSnapshot;
  phasesBefore?: CompilerPerfPhaseSnapshot;
  overlapped?: boolean;
  completed?: boolean;
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
const phaseDurationsMs = new Map<string, number>();
const activeSessions = new Set<CompilerPerfSession>();

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

export const startCompilerPerfPhase = (): number =>
  PERF_ENABLED ? performance.now() : 0;

export const addCompilerPerfPhaseDuration = (
  name: string,
  durationMs: number,
): void => {
  if (!PERF_ENABLED || durationMs <= 0) {
    return;
  }
  phaseDurationsMs.set(name, (phaseDurationsMs.get(name) ?? 0) + durationMs);
};

export const markCompilerPerfPhaseDuration = (
  name: string,
  startedAt: number,
): void => {
  if (!PERF_ENABLED) {
    return;
  }
  addCompilerPerfPhaseDuration(name, performance.now() - startedAt);
};

export const recordCompilerPerfDuration = ({
  name,
  startedAt,
}: {
  name: string;
  startedAt: number;
}): void => {
  if (!PERF_ENABLED) {
    return;
  }
  incrementCompilerPerfCounter(name, performance.now() - startedAt);
};

export const snapshotCompilerPerfCounters = (): CompilerPerfCounterSnapshot =>
  PERF_ENABLED ? new Map(counters) : new Map();

export const snapshotCompilerPerfPhases = (): CompilerPerfPhaseSnapshot =>
  PERF_ENABLED ? new Map(phaseDurationsMs) : new Map();

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

export const diffCompilerPerfPhases = ({
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
  overlapped,
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
    ...(overlapped ? { overlapped: true } : {}),
  };

  console.error(`[voyd:compiler:perf] ${JSON.stringify(summary)}`);
};

export const startCompilerPerfSession = ({
  entryPath,
}: {
  entryPath: string;
}): CompilerPerfSession => {
  if (!PERF_ENABLED) {
    return {
      entryPath,
      enabled: false,
      startedAt: 0,
    };
  }

  const session: CompilerPerfSession = {
    entryPath,
    enabled: true,
    startedAt: performance.now(),
    countersBefore: snapshotCompilerPerfCounters(),
    phasesBefore: snapshotCompilerPerfPhases(),
  };
  if (activeSessions.size > 0) {
    session.overlapped = true;
    activeSessions.forEach((activeSession) => {
      activeSession.overlapped = true;
    });
  }
  activeSessions.add(session);
  return session;
};

export const completeCompilerPerfSession = ({
  session,
  success,
  diagnostics,
  extraTotalMs = 0,
}: {
  session: CompilerPerfSession;
  success: boolean;
  diagnostics: number;
  extraTotalMs?: number;
}): void => {
  if (
    !session.enabled ||
    session.completed ||
    !session.countersBefore ||
    !session.phasesBefore
  ) {
    return;
  }
  session.completed = true;
  activeSessions.delete(session);

  const phases = diffCompilerPerfPhases({
    before: session.phasesBefore,
    after: snapshotCompilerPerfPhases(),
  });

  logCompilerPerfSummary({
    entryPath: session.entryPath,
    success,
    diagnostics,
    phasesMs: {
      ...phases,
      total: performance.now() - session.startedAt + extraTotalMs,
    },
    counters: diffCompilerPerfCounters({
      before: session.countersBefore,
      after: snapshotCompilerPerfCounters(),
    }),
    overlapped: session.overlapped,
  });
};
