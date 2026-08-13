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
        "borrowing.ordinary.strictAscents",
        "borrowing.ordinary.dependencyEnqueues",
        "borrowing.ordinary.solverBound",
        "borrowing.ordinary.solverBoundUsage",
        "borrowing.ordinary.liveness.cfgBlocks",
        "borrowing.ordinary.liveness.cfgEdges",
        "borrowing.ordinary.liveness.trackedCapabilities",
        "borrowing.ordinary.liveness.stateInsertions",
        "borrowing.ordinary.liveness.workItems",
        "borrowing.ordinary.retainedSummaryBytes",
        "borrowing.ordinary.projectionFamilies",
        "borrowing.ordinary.widenings",
        "borrowing.explicitBorrowFacts",
        "codegen.exact_call.requests",
        "codegen.exact_call.cache_hits",
        "codegen.exact_call.cache_misses",
        "codegen.exact_call.body_visits",
        "codegen.exact_call.analysis_operations",
        "codegen.exact_call.budget_exhaustion.per_body_work",
        "codegen.exact_call.budget_exhaustion.per_body_memory",
        "codegen.exact_call.budget_exhaustion.compile_wide_memory",
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

test("historical comparisons use each revision's declared counter schema", () => {
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
        "codegen.exact_call.requests",
      ].map((name) => [name, 0]),
    ),
  };

  assert.deepEqual(
    validateCompilerSummaries({
      summaries: [summary],
      compileCount: 1,
      counterSchema: {
        available: true,
        counters: ["codegen.exact_call.requests"],
      },
    }),
    [],
  );
  assert.match(
    validateCompilerSummaries({
      summaries: [summary],
      compileCount: 1,
      counterSchema: {
        available: true,
        counters: [
          "codegen.exact_call.requests",
          "borrowing.ordinary.liveness.cfgBlocks",
        ],
      },
    }).join("\n"),
    /borrowing\.ordinary\.liveness\.cfgBlocks/u,
  );
});
