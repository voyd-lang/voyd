import { describe, expect, it } from "vitest";
import { buildOptimized, findFunction } from "./pipeline-test-helpers.js";

describe("compiler optimization pipeline: capture-shrinking", () => {
  it("eliminates effect handlers on proven-pure paths", async () => {
    const { optimized } = await buildOptimized({
      files: {
        "main.voyd": `
eff Log
  info(resume, x: i32) -> i32

fn pure_value() -> i32
  5

pub fn main() -> i32
  try
    pure_value()
  Log::info(resume, x):
    x
`,
      },
    });

    const mainFn = findFunction({
      moduleId: "src::main",
      name: "main",
      program: optimized.program,
    });
    expect(mainFn?.kind).toBe("function");
    if (!mainFn || mainFn.kind !== "function") return;
    const body = optimized.program.modules
      .get("src::main")
      ?.hir.expressions.get(mainFn.body);
    expect(body?.exprKind).toBe("block");
  });

  it("records minimal handler capture sets", async () => {
    const { optimized } = await buildOptimized({
      files: {
        "main.voyd": `
eff Log
  info(resume, x: i32) -> i32

fn worker(): Log -> i32
  Log::info(5)

pub fn main(): () -> i32
  let used = 3
  let unused = 9
  try
    worker()
  Log::info(resume, x):
    used + x
`,
      },
    });

    const handlerCaptures =
      optimized.facts.handlerClauseCaptures.get("src::main");
    expect(handlerCaptures?.size ?? 0).toBe(1);
    const captures = Array.from(handlerCaptures?.values() ?? [])
      .flatMap((byClause) => Array.from(byClause.values()))
      .flat();
    expect(captures).toHaveLength(1);
  });

  it("recomputes handler captures after fixed-point match simplification", async () => {
    const { optimized } = await buildOptimized({
      files: {
        "main.voyd": `
eff Log
  info(resume, x: i32) -> i32

obj Box { value: i32 }
obj Alt { value: i32 }
type Runner = Box | Alt

fn worker(): Log -> i32
  Log::info(5)

fn classify(runner: Runner) -> i32
  let eliminated_capture = 100
  try
    worker()
  Log::info(resume, x):
    match(runner)
      Box: x
      else: eliminated_capture + x

pub fn main() -> i32
  classify(Box { value: 1 })
`,
      },
    });

    const captures = Array.from(
      optimized.facts.handlerClauseCaptures.get("src::main")?.values() ?? [],
    )
      .flatMap((byClause) => Array.from(byClause.values()))
      .flat();
    // The discriminant still evaluates `runner`, but the eliminated match arm's
    // local must not survive in the handler environment.
    expect(captures).toHaveLength(1);
  });
});
