import assert from "node:assert/strict";
import test from "node:test";

import {
  createExecutionPlan,
  summarizeDistribution,
  validateCompilerSummaries,
} from "./web-openapi-package-scale.mjs";

test("cold comparison schedules one warmup and seven alternating samples", () => {
  const plan = createExecutionPlan({
    repositoryLabels: ["base", "head"],
    warmupCount: 1,
    sampleCount: 7,
  });
  const measured = plan.filter(({ kind }) => kind === "measured");

  assert.deepEqual(
    plan
      .filter(({ kind }) => kind === "warmup")
      .map(({ repository }) => repository),
    ["base", "head"],
  );
  assert.equal(
    measured.filter(({ repository }) => repository === "base").length,
    7,
  );
  assert.equal(
    measured.filter(({ repository }) => repository === "head").length,
    7,
  );
  assert.deepEqual(
    measured.slice(0, 6).map(({ repository }) => repository),
    ["base", "head", "head", "base", "base", "head"],
  );
  assert.deepEqual(summarizeDistribution([5, 1, 3, 2, 4]), {
    values: [5, 1, 3, 2, 4],
    min: 1,
    median: 3,
    p95: 5,
    max: 5,
    mean: 3,
  });
});

test("V-500 summaries require explicit zero-presence counters", () => {
  const summary = {
    success: true,
    phasesMs: Object.fromEntries(
      [
        "total",
        "analyzeBorrowing",
        "analyzeBorrowing.finiteLocal",
        "analyzeBorrowing.ordinaryMutation",
        "analyzeBorrowing.explicitBorrow",
      ].map((name) => [name, 0]),
    ),
    counters: Object.fromEntries(
      [
        "borrowing.ordinary.callables",
        "borrowing.ordinary.callEdges",
        "borrowing.ordinary.summaryEvaluations",
        "borrowing.ordinary.sccReevaluations",
        "borrowing.ordinary.retainedSummaryBytes",
        "borrowing.ordinary.projectionFamilies",
        "borrowing.ordinary.widenings",
        "borrowing.explicitBorrowFacts",
        "optimization.decision.accepted",
      ].map((name) => [name, 0]),
    ),
  };
  const options = {
    summaries: [summary],
    compileCount: 1,
    counterSchema: {
      available: true,
      counters: ["optimization.decision.accepted"],
    },
  };

  assert.deepEqual(validateCompilerSummaries(options), []);
  delete summary.counters["optimization.decision.accepted"];
  assert.match(
    validateCompilerSummaries(options).join("\n"),
    /optimization\.decision\.accepted/u,
  );
});
