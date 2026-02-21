import { describe, expect, it } from "vitest";
import { resolve, sep } from "node:path";
import { ensureDispatcher } from "../effects/dispatcher.js";
import { createEffectsState } from "../effects/state.js";
import { createTestCodegenContext } from "./support/test-codegen-context.js";
import { createMemoryModuleHost } from "../../modules/memory-host.js";
import { createNodePathAdapter } from "../../modules/node-path-adapter.js";
import { buildModuleGraph } from "../../modules/graph.js";
import { analyzeModules, emitProgram } from "../../pipeline-shared.js";

const helperFunctionCount = (wat: string, name: string): number =>
  (wat.match(new RegExp(`^\\s*\\(func \\$${name}\\b`, "gm")) ?? []).length;

describe("program helper registry", () => {
  it("emits the dispatcher once across module contexts", () => {
    const { ctx } = createTestCodegenContext();
    const ctxB = {
      ...ctx,
      moduleId: "test_b",
      moduleLabel: "test_b",
      effectsState: createEffectsState(),
      effectLowering: {
        sitesByExpr: new Map(),
        sites: [],
        callArgTemps: new Map(),
        tempTypeIds: new Map(),
      },
    };

    ensureDispatcher(ctx);
    ensureDispatcher(ctxB);

    const wat = ctx.mod.emitText();
    const matches = wat.match(/\$__voyd_dispatch\b/g) ?? [];
    expect(matches).toHaveLength(1);
  });

  it("dedupes helpers in multi-module test builds", async () => {
    const root = resolve("/proj/src");
    const host = createMemoryModuleHost({
      files: {
        [`${root}${sep}main.voyd`]: `eff Async
  await(tail) -> i32

fn effectful_value(): Async -> i32
  Async::await()

fn caller(): Async -> i32
  let value = effectful_value()
  value + 1

test "alpha":
  caller()

pub use self::util::all
`,
        [`${root}${sep}main${sep}util.voyd`]: `eff Async
  await(tail) -> i32

fn effectful_value(): Async -> i32
  Async::await()

fn caller(): Async -> i32
  let value = effectful_value()
  value + 2

test "beta":
  caller()
`,
      },
      pathAdapter: createNodePathAdapter(),
    });
    const graph = await buildModuleGraph({
      entryPath: `${root}${sep}main.voyd`,
      roots: { src: root },
      host,
    });
    const { diagnostics, semantics } = analyzeModules({ graph, includeTests: true });
    const errors = diagnostics.filter((diag) => diag.severity === "error");
    expect(errors).toHaveLength(0);

    const { module } = await emitProgram({
      graph,
      semantics,
      codegenOptions: {
        testMode: true,
      },
    });

    const wat = module.emitText();
    const dispatcherMatches = wat.match(/\(func \$__voyd_dispatch\b/g) ?? [];
    expect(dispatcherMatches).toHaveLength(1);
    const bindMatches = wat.match(/\(func \$__voyd_cont_bind\b/g) ?? [];
    expect(bindMatches).toHaveLength(1);
  });

  it("dedupes runtime helpers when emitEffectHelpers is enabled", async () => {
    const root = resolve("/proj/src");
    const host = createMemoryModuleHost({
      files: {
        [`${root}${sep}main.voyd`]: `eff Async
  await(tail) -> i32

fn effectful_value(): Async -> i32
  Async::await()

fn caller(): Async -> i32
  let value = effectful_value()
  value + 1

test "alpha":
  caller()

pub use self::util::all
`,
        [`${root}${sep}main${sep}util.voyd`]: `eff Async
  await(tail) -> i32

fn effectful_value(): Async -> i32
  Async::await()

fn caller(): Async -> i32
  let value = effectful_value()
  value + 2

test "beta":
  caller()
`,
      },
      pathAdapter: createNodePathAdapter(),
    });
    const graph = await buildModuleGraph({
      entryPath: `${root}${sep}main.voyd`,
      roots: { src: root },
      host,
    });
    const { diagnostics, semantics } = analyzeModules({ graph, includeTests: true });
    const errors = diagnostics.filter((diag) => diag.severity === "error");
    expect(errors).toHaveLength(0);

    const { module } = await emitProgram({
      graph,
      semantics,
      codegenOptions: {
        testMode: true,
        emitEffectHelpers: true,
      },
    });

    const wat = module.emitText();
    [
      "__voyd_outcome_tag",
      "__voyd_outcome_unwrap_i32",
      "__voyd_effect_id",
      "__voyd_effect_op_id",
      "__voyd_effect_resume_kind",
    ].forEach((name) => {
      expect(helperFunctionCount(wat, name)).toBe(1);
    });
  });
});
