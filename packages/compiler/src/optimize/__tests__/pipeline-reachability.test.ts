import { describe, expect, it } from "vitest";
import { codegenProgram } from "../../codegen/index.js";
import {
  buildOptimized,
  findFunction,
  findModuleLet,
} from "./pipeline-test-helpers.js";

describe("compiler optimization pipeline: reachability", () => {
  it("tracks reachable cross-module module lets and prunes unrelated specializations", async () => {
    const { optimized } = await buildOptimized({
      files: {
        "main.voyd": `
use src::util::get_value

pub fn main() -> i32
  get_value()
`,
        "util.voyd": `
fn id<T>(value: T) -> T
  value

fn keep<T>(value: T) -> T
  id<T>(value)

fn drop<T>(value: T) -> T
  id<T>(value)

let kept = keep(7)
let discarded = drop(true)

pub fn get_value() -> i32
  kept
`,
      },
    });

    const utilModuleId = "src::util";
    const dropFn = findFunction({
      moduleId: utilModuleId,
      name: "drop",
      program: optimized.program,
    });
    expect(dropFn?.kind).toBe("function");
    if (!dropFn || dropFn.kind !== "function") return;

    const kept = findModuleLet({
      moduleId: utilModuleId,
      name: "kept",
      program: optimized.program,
    });
    const discarded = findModuleLet({
      moduleId: utilModuleId,
      name: "discarded",
      program: optimized.program,
    });
    expect(kept?.kind).toBe("module-let");
    expect(discarded?.kind).toBe("module-let");
    if (!kept || !discarded) return;

    const dropInstantiations = optimized.program.functions.getInstantiationInfo(
      utilModuleId,
      dropFn.symbol,
    );
    expect(dropInstantiations?.size ?? 0).toBe(0);

    const reachableModuleLets =
      optimized.facts.reachableModuleLets.get(utilModuleId);
    expect(reachableModuleLets?.has(kept.symbol)).toBe(true);
    expect(reachableModuleLets?.has(discarded.symbol)).toBe(false);
  });

  it("keeps non-entry test exports reachable in optimized all-module test builds", async () => {
    const { optimized, entryModuleId, tests } = await buildOptimized({
      files: {
        "main.voyd": `
use src::util::anchor

pub fn main() -> i32
  anchor()
`,
        "util.voyd": `
pub fn anchor() -> i32
  1

test "reachable from export root":
  anchor()
`,
      },
      includeTests: true,
      optimizeOptions: {
        testMode: true,
        testScope: "all",
      },
    });

    const utilTest = tests.find((test) => test.moduleId === "src::util");
    expect(utilTest?.exportName).toBeDefined();
    if (!utilTest?.exportName) return;

    const utilModuleId = "src::util";
    const testFn = Array.from(
      optimized.program.modules.get(utilModuleId)?.hir.items.values() ?? [],
    ).find(
      (item) =>
        item.kind === "function" &&
        optimized.program.symbols
          .getName(
            optimized.program.symbols.idOf({
              moduleId: utilModuleId,
              symbol: item.symbol,
            }),
          )
          ?.startsWith("__test__"),
    );
    expect(testFn?.kind).toBe("function");
    if (!testFn || testFn.kind !== "function") return;

    const instanceId = optimized.program.functions.getInstanceId(
      utilModuleId,
      testFn.symbol,
      [],
    );
    expect(typeof instanceId).toBe("number");
    if (typeof instanceId !== "number") return;
    expect(optimized.facts.reachableFunctionInstances.has(instanceId)).toBe(
      true,
    );

    const codegen = codegenProgram({
      program: optimized.program,
      entryModuleId,
      optimization: optimized.facts,
      options: {
        optimize: false,
        validate: false,
        runtimeDiagnostics: false,
        testMode: true,
        testScope: "all",
      },
    });
    expect(codegen.diagnostics).toHaveLength(0);
    expect(codegen.module.emitText()).toContain(
      `(export "${utilTest.exportName}"`,
    );
  });
});
