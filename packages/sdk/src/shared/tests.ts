import type {
  EffectHandler,
  TestCase,
  TestCollection,
  TestEvent,
  TestInfo,
  TestReporter,
  TestResult,
  TestRunOptions,
  TestRunSummary,
} from "./types.js";
import { createHost, registerHandlers } from "./host.js";
import type { VoydHost } from "@voyd/js-host";

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

const buildTestInfo = ({
  test,
  displayName,
}: {
  test: TestCase;
  displayName: string;
}): TestInfo => ({
  id: test.id,
  moduleId: test.moduleId,
  modulePath: test.modulePath,
  description: test.description,
  displayName,
  modifiers: test.modifiers,
  location: test.location,
});

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

const planTests = ({
  cases,
  filter,
}: {
  cases: readonly TestCase[];
  filter?: TestRunOptions["filter"];
}): PlannedTest[] => {
  const filtered = filter
    ? cases.flatMap((test) => {
        const displayName = buildDisplayName(test);
        const info = buildTestInfo({ test, displayName });
        return filter(info) ? [{ test, displayName }] : [];
      })
    : cases.map((test) => ({ test, displayName: buildDisplayName(test) }));
  const hasOnly = filtered.some(({ test }) => test.modifiers.only);
  const respectOnly = hasOnly;

  return filtered.map(({ test, displayName }) => {
    if (test.modifiers.skip) {
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
    const exportName = plan.test.exportName ?? plan.test.id;
    await host.run(exportName);
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
  options,
}: {
  cases: readonly TestCase[];
  wasm: Uint8Array;
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
  const isolation = options.isolation ?? "per-test";

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

    const testHost =
      isolation === "shared"
        ? (sharedHost ??= await createTestHost({ wasm, options, onLog }))
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
}: {
  cases: readonly TestCase[];
  wasm: Uint8Array;
}): TestCollection => {
  const hasOnly = cases.some((test) => test.modifiers.only);
  return {
    cases,
    hasOnly,
    run: (runOptions) => runTests({ cases, wasm, options: runOptions }),
  };
};
