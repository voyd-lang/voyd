import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createVoydHost } from "@voyd-lang/js-host";
import { monomorphizeProgram } from "../../semantics/linking.js";
import { buildProgramCodegenView } from "../../semantics/codegen-view/index.js";
import { optimizeProgram } from "../../optimize/pipeline.js";
import { codegenProgram } from "../index.js";
import { compileEffectFixture } from "./support/effects-harness.js";

const perf = vi.hoisted(() => ({ increment: vi.fn() }));
vi.mock("../../perf.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../perf.js")>()),
  incrementCompilerPerfCounter: perf.increment,
}));

const recordedCounters = (): string[] =>
  perf.increment.mock.calls.map(([name]) => String(name));

const fixturePath = resolve(
  import.meta.dirname,
  "__fixtures__/range_for_fast_path.voyd",
);

const watForExport = (wat: string, exportName: string): string => {
  return watForFunctionName(wat, functionNameForExport(wat, exportName));
};

const functionNameForExport = (wat: string, exportName: string): string => {
  const exportMatch = wat.match(
    new RegExp(`\\(export "${exportName}" \\(func \\$([^\\s\\)]+)\\)\\)`),
  );
  expect(exportMatch).not.toBeNull();
  return exportMatch![1]!;
};

const watForFunctionName = (wat: string, functionName: string): string => {
  const start = wat.indexOf(`(func $${functionName} `);
  let depth = 0;
  for (let index = start; index < wat.length; index += 1) {
    if (wat[index] === "(") depth += 1;
    if (wat[index] === ")") depth -= 1;
    if (depth === 0) return wat.slice(start, index + 1);
  }
  throw new Error(`unterminated function ${functionName}`);
};

const compileFixture = async () => {
  const prepared = await compileEffectFixture({
    entryPath: fixturePath,
    codegenOptions: {
      validate: true,
      effectsHostBoundary: "off",
      boundaryExports: false,
    },
  });
  const modules = [...prepared.semantics.values()];
  const monomorphized = monomorphizeProgram({
    modules,
    semantics: prepared.semantics,
  });
  const program = buildProgramCodegenView(modules, {
    instances: monomorphized.instances,
    moduleTyping: monomorphized.moduleTyping,
  });
  const optimized = optimizeProgram({
    program,
    modules,
    entryModuleId: prepared.entryModuleId,
  });
  const generated = codegenProgram({
    program: optimized.program,
    entryModuleId: prepared.entryModuleId,
    optimization: optimized.facts,
    options: { validate: true, boundaryExports: false },
  });
  const baseline = codegenProgram({
    program,
    entryModuleId: prepared.entryModuleId,
    options: { validate: true, boundaryExports: false },
  });
  return { prepared, optimized, generated, baseline };
};

describe("intrinsic Range<i32> for-loop fast path", () => {
  it("emits a direct counted loop and retains stable-field forwarding", async () => {
    const { prepared, optimized, generated, baseline } = await compileFixture();
    const host = await createVoydHost({ wasm: generated.wasm! });
    await expect(host.run<number>("stable_range_sum")).resolves.toBe(35);

    const forwarding = optimized.facts.stableFieldLoadForwarding.get(
      prepared.entryModuleId,
    );
    expect(forwarding?.size).toBe(1);

    const generatedWat = watForExport(
      generated.module.emitText(),
      "stable_range_sum",
    );
    const baselineWat = watForExport(
      baseline.module.emitText(),
      "stable_range_sum",
    );
    expect(generatedWat).toContain("range_for_loop");
    expect(generatedWat).not.toContain("$std__range__RangeIterator");
    expect(generatedWat).not.toContain("call_ref");
    expect(generatedWat.match(/\(struct\.get\b/g)?.length ?? 0).toBeLessThan(
      baselineWat.match(/\(struct\.get\b/g)?.length ?? 0,
    );
    expect(recordedCounters()).toContain(
      "codegen.intrinsic_range_for.accepted",
    );
  });

  it("restores generated range state across effects", async () => {
    const { generated, baseline } = await compileFixture();
    const optimizedHost = await createVoydHost({ wasm: generated.wasm! });
    const baselineHost = await createVoydHost({ wasm: baseline.wasm! });
    const cases = [
      ["effectful_range_bounds_and_progress", 60123245],
      ["effectful_range_work_around_suspension", 812424],
      ["effectful_range_multiple_suspensions", 3224],
      ["effectful_range_nested_suspending_statement", 42345],
      ["effectful_nested_range_control", 244],
      ["effectful_inclusive_max_tail", 1],
      ["effectful_handler_inside_loop", 5],
      ["effectful_range_checked_array_access", 12],
      ["effectful_range_checked_array_get", 12],
    ] as const;

    for (const [exportName, expected] of cases) {
      const optimizedValue = await optimizedHost
        .run<number>(exportName)
        .catch((error: unknown) => {
          throw new Error(`optimized ${exportName} failed`, { cause: error });
        });
      const baselineValue = await baselineHost
        .run<number>(exportName)
        .catch((error: unknown) => {
          throw new Error(`baseline ${exportName} failed`, { cause: error });
        });
      expect(optimizedValue).toBe(expected);
      expect(baselineValue).toBe(expected);
    }

    const generatedModuleWat = generated.module.emitText();
    const baselineModuleWat = baseline.module.emitText();
    const effectfulExport = "effectful_range_bounds_and_progress";
    const generatedWat = watForFunctionName(
      generatedModuleWat,
      `${functionNameForExport(generatedModuleWat, effectfulExport)}__effectful_impl`,
    );
    const baselineWat = watForFunctionName(
      baselineModuleWat,
      `${functionNameForExport(baselineModuleWat, effectfulExport)}__effectful_impl`,
    );
    expect(generatedWat).toContain("range_for_loop");
    expect(generatedWat).not.toContain("$std__range__RangeIterator");
    expect(baselineWat).toContain("range_for_loop");
    expect(baselineWat).not.toContain("$std__range__RangeIterator");

    const statementRoutingExports = [
      "effectful_range_work_around_suspension",
      "effectful_range_multiple_suspensions",
      "effectful_range_nested_suspending_statement",
    ];
    for (const exportName of statementRoutingExports) {
      const wat = watForFunctionName(
        generatedModuleWat,
        `${functionNameForExport(generatedModuleWat, exportName)}__effectful_impl`,
      );
      expect(wat).toContain("range_for_loop");
      expect(wat).not.toContain("$std__range__RangeIterator");
    }

    const checkedArrayExport = "effectful_range_checked_array_access";
    const checkedArrayWat = watForFunctionName(
      generatedModuleWat,
      `${functionNameForExport(generatedModuleWat, checkedArrayExport)}__effectful_impl`,
    );
    expect(checkedArrayWat).toContain("array.get");
    expect(checkedArrayWat).toContain("unreachable");
    expect(
      recordedCounters().some((name) =>
        name.startsWith("codegen.range_array_safe_scope.fallback."),
      ),
    ).toBe(true);
  });
});
