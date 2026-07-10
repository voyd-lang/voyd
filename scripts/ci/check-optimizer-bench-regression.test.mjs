import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  compareScorecards,
  pairedRunOrder,
  rssRetryScenarios,
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
  compileMs = 100,
}) => ({
  schemaVersion: 2,
  corpusHashes: { scenario: "same-source" },
  rows: [
    {
      scenario: "scenario",
      mode: "release",
      experiment: "baseline",
      compileMedianMs: compileMs,
      runtimeMedianMs: 10,
      processMaxRssBytes: rssMib * MIB,
      processMaxRssSamplesBytes: rssSamplesMib.map((value) => value * MIB),
      wasmBytes: 10_000,
      gzipBytes: 5_000,
      optimizerPasses: [],
      codegenMetrics: {},
      wasmStructure: {},
    },
  ],
});

const failures = ({ base, head }) => compareScorecards({ base, head, limits });

describe("optimizer scorecard RSS retry policy", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("clears a one-off RSS regression when the paired retry is healthy", () => {
    const initial = failures({
      base: scorecard({ rssMib: 100 }),
      head: scorecard({ rssMib: 150 }),
    });
    expect(rssRetryScenarios(initial)).toEqual(["scenario"]);

    const retry = failures({
      base: scorecard({ rssMib: 100 }),
      head: scorecard({ rssMib: 105 }),
    });
    expect(retry).toEqual([]);
  });

  it("ignores the runner's bimodal one-sided RSS contamination", () => {
    const result = failures({
      base: scorecard({
        rssMib: 1_790,
        rssSamplesMib: [1_809, 1_790, 1_789],
      }),
      head: scorecard({
        rssMib: 2_075,
        rssSamplesMib: [1_805, 2_075, 2_081],
      }),
    });
    expect(result).toEqual([]);
  });

  it("still fails a stable synthetic RSS regression after retry", () => {
    const retry = failures({
      base: scorecard({ rssMib: 100 }),
      head: scorecard({ rssMib: 150 }),
    });
    expect(retry).toMatchObject([{ scenario: "scenario", metric: "rss" }]);
  });

  it("does not retry when a deterministic metric also regresses", () => {
    const result = failures({
      base: scorecard({ rssMib: 100 }),
      head: scorecard({ rssMib: 150, compileMs: 500 }),
    });
    expect(result.map(({ metric }) => metric)).toEqual(["compile", "rss"]);
    expect(rssRetryScenarios(result)).toEqual([]);
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
