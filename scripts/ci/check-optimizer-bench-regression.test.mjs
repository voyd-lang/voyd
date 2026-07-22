import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  compareScorecards,
  measurementRetryScenarios,
  pairedRunOrder,
  poolScorecardMeasurements,
  scorecardInputMode,
} from "./check-optimizer-bench-regression.mjs";

const MIB = 1024 * 1024;
const limits = {
  compile: { relativePct: 20, absolute: 250 },
  runtime: { relativePct: 20, absolute: 5 },
  rss: { relativePct: 15, absolute: 32 * MIB },
  wasm: { relativePct: 5, absolute: 1024 },
  gzip: { relativePct: 5, absolute: 512 },
};

const scorecard = ({
  rssMib,
  rssSamplesMib = [rssMib - 1, rssMib, rssMib + 1],
  rssGrowthMib = rssMib,
  rssGrowthSamplesMib = [rssGrowthMib - 1, rssGrowthMib, rssGrowthMib + 1],
  compileMs = 100,
  compileSamplesMs = [compileMs - 1, compileMs, compileMs + 1],
  runtimeMs = 10,
  runtimeSamplesMs = [runtimeMs - 1, runtimeMs, runtimeMs + 1],
  wasmBytes = 10_000,
  gzipBytes = 5_000,
}) => ({
  schemaVersion: 2,
  corpusHashes: { scenario: "same-source" },
  rows: [
    {
      scenario: "scenario",
      mode: "release",
      experiment: "baseline",
      compileMedianMs: compileMs,
      compileSamplesMs,
      runtimeMedianMs: runtimeMs,
      runtimeSamplesMs,
      processMaxRssBytes: rssMib * MIB,
      processMaxRssSamplesBytes: rssSamplesMib.map((value) => value * MIB),
      processMaxRssGrowthBytes: rssGrowthMib * MIB,
      processMaxRssGrowthSamplesBytes: rssGrowthSamplesMib.map(
        (value) => value * MIB,
      ),
      wasmBytes,
      gzipBytes,
      wasmSha256: "same-artifact",
      optimizerPasses: [],
      codegenMetrics: {},
      wasmStructure: {},
    },
  ],
});

const failures = ({ base, head }) => compareScorecards({ base, head, limits });

describe("optimizer scorecard measurement retry policy", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("clears a one-off RSS regression when the paired retry is healthy", () => {
    const initialBase = scorecard({ rssMib: 100 });
    const initialHead = scorecard({ rssMib: 400 });
    const initial = failures({
      base: initialBase,
      head: initialHead,
    });
    expect(measurementRetryScenarios(initial)).toEqual(["scenario"]);

    const base = poolScorecardMeasurements({
      initial: initialBase,
      retry: scorecard({ rssMib: 100 }),
      scenarioNames: ["scenario"],
    });
    const head = poolScorecardMeasurements({
      initial: initialHead,
      retry: scorecard({ rssMib: 105 }),
      scenarioNames: ["scenario"],
    });
    expect(failures({ base, head })).toEqual([]);
  });

  it("ignores bimodal absolute RSS when compile-attributable growth is stable", () => {
    const result = failures({
      base: scorecard({
        rssMib: 1_790,
        rssSamplesMib: [1_809, 1_790, 1_789],
        rssGrowthMib: 100,
        rssGrowthSamplesMib: [101, 100, 99],
      }),
      head: scorecard({
        rssMib: 2_075,
        rssSamplesMib: [1_805, 2_075, 2_081],
        rssGrowthMib: 102,
        rssGrowthSamplesMib: [101, 102, 103],
      }),
    });
    expect(result).toEqual([]);
  });

  it("fails a majority-sample growth regression despite one low outlier", () => {
    const result = failures({
      base: scorecard({
        rssMib: 100,
        rssGrowthMib: 100,
        rssGrowthSamplesMib: [100, 100, 100],
      }),
      head: scorecard({
        rssMib: 150,
        rssGrowthMib: 150,
        rssGrowthSamplesMib: [100, 150, 150],
      }),
    });
    expect(result).toMatchObject([{ scenario: "scenario", metric: "rss" }]);
  });

  it("still fails a stable synthetic RSS regression after retry", () => {
    const base = poolScorecardMeasurements({
      initial: scorecard({ rssMib: 100 }),
      retry: scorecard({ rssMib: 100 }),
      scenarioNames: ["scenario"],
    });
    const head = poolScorecardMeasurements({
      initial: scorecard({ rssMib: 150 }),
      retry: scorecard({ rssMib: 150 }),
      scenarioNames: ["scenario"],
    });
    expect(failures({ base, head })).toMatchObject([
      { scenario: "scenario", metric: "rss" },
    ]);
  });

  it("retries compile and RSS regressions because both are sampled", () => {
    const result = failures({
      base: scorecard({ rssMib: 100 }),
      head: scorecard({ rssMib: 150, compileMs: 500 }),
    });
    expect(result.map(({ metric }) => metric)).toEqual(["compile", "rss"]);
    expect(measurementRetryScenarios(result)).toEqual(["scenario"]);
  });

  it("retries runtime-only regressions", () => {
    const result = failures({
      base: scorecard({ rssMib: 100, runtimeMs: 10 }),
      head: scorecard({ rssMib: 100, runtimeMs: 18 }),
    });
    expect(result).toMatchObject([{ scenario: "scenario", metric: "runtime" }]);
    expect(measurementRetryScenarios(result)).toEqual(["scenario"]);
  });

  it("does not retry when a deterministic artifact metric regresses", () => {
    const result = failures({
      base: scorecard({ rssMib: 100 }),
      head: scorecard({ rssMib: 150, wasmBytes: 12_000 }),
    });
    expect(result.map(({ metric }) => metric)).toEqual(["rss", "wasm"]);
    expect(measurementRetryScenarios(result)).toEqual([]);
  });

  it("pools initial and reversed-order measurements", () => {
    const initialBase = scorecard({
      rssMib: 100,
      runtimeMs: 10,
      runtimeSamplesMs: [9, 10, 11],
    });
    const retryBase = scorecard({
      rssMib: 102,
      runtimeMs: 10,
      runtimeSamplesMs: [9, 10, 11],
    });
    const initialHead = scorecard({
      rssMib: 150,
      runtimeMs: 18,
      runtimeSamplesMs: [17, 18, 19],
    });
    const retryHead = scorecard({
      rssMib: 103,
      runtimeMs: 10,
      runtimeSamplesMs: [9, 10, 11],
    });

    const base = poolScorecardMeasurements({
      initial: initialBase,
      retry: retryBase,
      scenarioNames: ["scenario"],
    });
    const head = poolScorecardMeasurements({
      initial: initialHead,
      retry: retryHead,
      scenarioNames: ["scenario"],
    });

    expect(base.rows[0].runtimeSamplesMs).toEqual([9, 10, 11, 9, 10, 11]);
    expect(head.rows[0].runtimeMedianMs).toBe(14);
    expect(failures({ base, head })).toEqual([]);
  });
});

it("prefers JSON scorecards over ambient ref environment inputs", () => {
  expect(
    scorecardInputMode({
      baseJson: "base.json",
      headJson: "head.json",
      baseRef: "ambient-base",
      headRef: "ambient-head",
    }),
  ).toBe("json");
});

it("alternates the first revision across paired scenarios", () => {
  expect(
    pairedRunOrder({
      scenarioNames: ["one", "two", "three", "four"],
      baseRef: "base",
      headRef: "head",
    }),
  ).toEqual([
    { scenario: "one", refs: ["base", "head"] },
    { scenario: "two", refs: ["head", "base"] },
    { scenario: "three", refs: ["base", "head"] },
    { scenario: "four", refs: ["head", "base"] },
  ]);
});

it("reverses initial ordering when retrying a scenario subset", () => {
  expect(
    pairedRunOrder({
      scenarioNames: ["one", "two"],
      scenarioOrder: ["zero", "one", "two", "three"],
      baseRef: "base",
      headRef: "head",
      reverse: true,
    }),
  ).toEqual([
    { scenario: "one", refs: ["base", "head"] },
    { scenario: "two", refs: ["head", "base"] },
  ]);
});
