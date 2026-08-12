import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

export type CompilerPerfSummary = {
  schemaVersion?: number;
  phasesMs: Record<string, number>;
  counters: Record<string, number>;
  overlapped?: boolean;
};

export type ProcessMemoryReport = {
  sampledPeakRssBytes: number;
  processMaxRssBytes: number;
  processMaxRssGrowthBytes: number;
};

const PERF_PREFIX = "[voyd:compiler:perf] ";

export const emitBenchmarkReport = ({
  report,
  outputPath,
}: {
  report: unknown;
  outputPath?: string;
}): string => {
  const output = JSON.stringify(report, null, 2);
  if (outputPath) {
    writeFileSync(resolve(outputPath), `${output}\n`);
  }
  console.log(output);
  return output;
};

export const createProcessMemoryTracker = () => {
  const baselineMaxRssBytes = processMaxRssBytes();
  let sampledPeakRssBytes = process.memoryUsage().rss;
  const sample = (): void => {
    sampledPeakRssBytes = Math.max(
      sampledPeakRssBytes,
      process.memoryUsage().rss,
    );
  };
  const interval = setInterval(sample, 5);
  interval.unref();

  return {
    sample,
    finish: (): ProcessMemoryReport => {
      clearInterval(interval);
      sample();
      const maximumRssBytes = processMaxRssBytes();
      return {
        sampledPeakRssBytes,
        processMaxRssBytes: maximumRssBytes,
        processMaxRssGrowthBytes: Math.max(
          0,
          maximumRssBytes - baselineMaxRssBytes,
        ),
      };
    },
  };
};

export const captureCompilerPerf = async <T>(
  operation: () => Promise<T>,
): Promise<{ value: T; summaries: CompilerPerfSummary[] }> => {
  const summaries: CompilerPerfSummary[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]): void => {
    const message = args.length === 1 ? String(args[0]) : undefined;
    if (message?.startsWith(PERF_PREFIX)) {
      summaries.push(
        JSON.parse(message.slice(PERF_PREFIX.length)) as CompilerPerfSummary,
      );
      return;
    }
    originalError(...args);
  };

  try {
    return { value: await operation(), summaries };
  } finally {
    console.error = originalError;
  }
};

export const processMaxRssBytes = (): number =>
  process.resourceUsage().maxRSS * 1024;
