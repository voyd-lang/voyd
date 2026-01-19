import type {
  EffectHandler,
  TestCase,
  TestCollection,
  TestEvent,
  TestReporter,
  TestResult,
  TestRunOptions,
  TestRunSummary,
  VoydHost,
} from "./types.js";
import { createHost, registerHandlers } from "./host.js";

class TestFailure extends Error {
  constructor(message?: string) {
    super(message ?? "Test failed");
    this.name = "TestFailure";
  }
}

class TestSkip extends Error {
  constructor(message?: string) {
    super(message ?? "Test skipped");
    this.name = "TestSkip";
  }
}

type PlannedTest = {
  test: TestCase;
  displayName: string;
  status: "pending" | "skipped";
};

const buildDisplayName = (test: TestCase): string => {
  if (test.description) {
    return `${test.modulePath}::${test.description}`;
  }

  if (test.location) {
    return `${test.modulePath}::<${test.location.filePath}:${test.location.startLine}:${test.location.startColumn}>`;
  }

  return `${test.modulePath}::<${test.id}>`;
};

const extractMessage = (value: unknown): string | undefined => {
  if (typeof value === "string") {
    return value;
  }

  if (value instanceof Error) {
    return value.message;
  }

  return undefined;
};

const buildLogMessage = (args: unknown[]): string => {
  if (args.length === 0) {
    return "";
  }

  if (args.length === 1) {
    return String(args[0]);
  }

  return args.map((entry) => String(entry)).join(" ");
};

const matchesFilter = ({
  test,
  displayName,
  filter,
}: {
  test: TestCase;
  displayName: string;
  filter?: TestRunOptions["filter"];
}): boolean => {
  const match = filter?.match;
  if (!match) {
    return true;
  }

  if (typeof match === "string") {
    if (
      test.id === match ||
      test.moduleId === match ||
      test.modulePath === match
    ) {
      return true;
    }
    return displayName.includes(match);
  }

  const regex = new RegExp(match.source, match.flags);
  return (
    regex.test(displayName) ||
    regex.test(test.id) ||
    regex.test(test.moduleId) ||
    regex.test(test.modulePath)
  );
};

const planTests = ({
  cases,
  filter,
}: {
  cases: readonly TestCase[];
  filter?: TestRunOptions["filter"];
}): PlannedTest[] => {
  const hasOnly = cases.some((test) => test.modifiers.only);
  const respectOnly =
    filter?.only === true || (filter?.only !== false && hasOnly);
  const includeSkipped = filter?.skip === true;

  return cases.map((test) => {
    const displayName = buildDisplayName(test);
    if (!matchesFilter({ test, displayName, filter })) {
      return { test, displayName, status: "skipped" };
    }

    if (test.modifiers.skip && !includeSkipped) {
      return { test, displayName, status: "skipped" };
    }

    if (respectOnly && !test.modifiers.only) {
      return { test, displayName, status: "skipped" };
    }

    return { test, displayName, status: "pending" };
  });
};

const emitEvent = async ({
  reporter,
  event,
}: {
  reporter?: TestReporter;
  event: TestEvent;
}): Promise<void> => {
  if (!reporter) {
    return;
  }

  await reporter.onEvent(event);
};

const registerTestHandlers = ({
  host,
  handlers,
  onLog,
}: {
  host: VoydHost;
  handlers?: Record<string, EffectHandler>;
  onLog?: (message: string) => void;
}): void => {
  if (handlers) {
    registerHandlers({ host, handlers });
  }

  host.registerHandlersByLabelSuffix({
    ".fail": (...args: unknown[]) => {
      throw new TestFailure(extractMessage(args[0]));
    },
    ".skip": (...args: unknown[]) => {
      throw new TestSkip(extractMessage(args[0]));
    },
    ".log": (...args: unknown[]) => {
      if (!onLog) {
        return null;
      }
      onLog(buildLogMessage(args));
      return null;
    },
  });
};

const summarizeRun = ({
  results,
  startedAt,
}: {
  results: TestResult[];
  startedAt: number;
}): TestRunSummary => ({
  total: results.length,
  passed: results.filter((result) => result.status === "passed").length,
  failed: results.filter((result) => result.status === "failed").length,
  skipped: results.filter((result) => result.status === "skipped").length,
  durationMs: Date.now() - startedAt,
});

const createPlannedResult = ({
  plan,
  status,
  durationMs,
  error,
}: {
  plan: PlannedTest;
  status: TestResult["status"];
  durationMs: number;
  error?: unknown;
}): TestResult => ({
  test: plan.test,
  displayName: plan.displayName,
  status,
  durationMs,
  error,
});

const createTestHost = async ({
  wasm,
  options,
  onLog,
}: {
  wasm: Uint8Array;
  options: TestRunOptions;
  onLog?: (message: string) => void;
}): Promise<VoydHost> => {
  const host = await createHost({
    wasm,
    imports: options.imports,
    bufferSize: options.bufferSize,
  });
  registerTestHandlers({ host, handlers: options.handlers, onLog });
  return host;
};

const resolveSharedHost = async ({
  wasm,
  baseHost,
  options,
  onLog,
}: {
  wasm: Uint8Array;
  baseHost: VoydHost;
  options: TestRunOptions;
  onLog?: (message: string) => void;
}): Promise<VoydHost> => {
  const useBaseHost =
    !options.imports && typeof options.bufferSize !== "number";
  const host = useBaseHost
    ? baseHost
    : await createHost({
        wasm,
        imports: options.imports,
        bufferSize: options.bufferSize,
      });
  registerTestHandlers({ host, handlers: options.handlers, onLog });
  return host;
};

const runPlannedTest = async ({
  plan,
  host,
  reporter,
}: {
  plan: PlannedTest;
  host: VoydHost;
  reporter?: TestReporter;
}): Promise<TestResult> => {
  await emitEvent({
    reporter,
    event: {
      type: "test:start",
      test: plan.test,
      displayName: plan.displayName,
    },
  });

  const startedAt = Date.now();

  try {
    await host.run(plan.test.id);
    return createPlannedResult({
      plan,
      status: "passed",
      durationMs: Date.now() - startedAt,
    });
  } catch (error) {
    if (error instanceof TestSkip) {
      return createPlannedResult({
        plan,
        status: "skipped",
        durationMs: Date.now() - startedAt,
      });
    }

    return createPlannedResult({
      plan,
      status: "failed",
      durationMs: Date.now() - startedAt,
      error,
    });
  }
};

const runTests = async ({
  cases,
  wasm,
  host,
  options,
}: {
  cases: readonly TestCase[];
  wasm: Uint8Array;
  host: VoydHost;
  options: TestRunOptions;
}): Promise<TestRunSummary> => {
  await emitEvent({ reporter: options.reporter, event: { type: "discovery:start" } });
  await emitEvent({
    reporter: options.reporter,
    event: { type: "discovery:complete", cases },
  });

  const planned = planTests({ cases, filter: options.filter });
  const results: TestResult[] = [];
  const startedAt = Date.now();
  let sharedHost: VoydHost | undefined;
  let activeTest: PlannedTest | undefined;

  const onLog = (message: string) => {
    if (!activeTest) {
      return;
    }
    void emitEvent({
      reporter: options.reporter,
      event: { type: "test:log", test: activeTest.test, message },
    });
  };

  for (const plan of planned) {
    if (plan.status === "skipped") {
      const result = createPlannedResult({
        plan,
        status: "skipped",
        durationMs: 0,
      });
      results.push(result);
      await emitEvent({
        reporter: options.reporter,
        event: { type: "test:result", result },
      });
      continue;
    }

    activeTest = plan;

    const testHost = options.reuseHost
      ? (sharedHost ??= await resolveSharedHost({
          wasm,
          baseHost: host,
          options,
          onLog,
        }))
      : await createTestHost({ wasm, options, onLog });

    const result = await runPlannedTest({
      plan,
      host: testHost,
      reporter: options.reporter,
    });
    results.push(result);
    await emitEvent({
      reporter: options.reporter,
      event: { type: "test:result", result },
    });
    activeTest = undefined;
  }

  const summary = summarizeRun({ results, startedAt });
  await emitEvent({
    reporter: options.reporter,
    event: { type: "run:complete", summary },
  });
  return summary;
};

export const createTestCollection = ({
  cases,
  wasm,
  host,
}: {
  cases: readonly TestCase[];
  wasm: Uint8Array;
  host: VoydHost;
}): TestCollection => {
  const hasOnly = cases.some((test) => test.modifiers.only);
  return {
    cases,
    hasOnly,
    run: (options) => runTests({ cases, wasm, host, options }),
  };
};
