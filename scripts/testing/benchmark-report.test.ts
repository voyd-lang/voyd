import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  captureCompilerPerf,
  createProcessMemoryTracker,
  emitBenchmarkReport,
} from "../benchmark-report.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  temporaryDirectories.splice(0).forEach((directory) =>
    rmSync(directory, { recursive: true, force: true }),
  );
});

describe("benchmark report support", () => {
  it("writes the same formatted JSON emitted to stdout", () => {
    const directory = mkdtempSync(join(tmpdir(), "voyd-benchmark-report-"));
    temporaryDirectories.push(directory);
    const outputPath = join(directory, "report.json");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const output = emitBenchmarkReport({
      report: { benchmark: "sample", values: [1, 2] },
      outputPath,
    });

    expect(readFileSync(outputPath, "utf8")).toBe(`${output}\n`);
    expect(log).toHaveBeenCalledWith(output);
  });

  it("captures compiler perf lines without swallowing other stderr", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await captureCompilerPerf(async () => {
      console.error(
        '[voyd:compiler:perf] {"phasesMs":{"total":2},"counters":{"accepted":1}}',
      );
      console.error("ordinary diagnostic");
      return 7;
    });

    expect(result).toEqual({
      value: 7,
      summaries: [
        { phasesMs: { total: 2 }, counters: { accepted: 1 } },
      ],
    });
    expect(error).toHaveBeenCalledWith("ordinary diagnostic");
  });

  it("reports nonnegative operating-system peak RSS", () => {
    const tracker = createProcessMemoryTracker();
    tracker.sample();

    expect(tracker.finish()).toEqual({
      sampledPeakRssBytes: expect.any(Number),
      processMaxRssBytes: expect.any(Number),
      processMaxRssGrowthBytes: expect.any(Number),
    });
  });
});
