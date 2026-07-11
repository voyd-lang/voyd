import { describe, expect, it } from "vitest";
import { walkExpression } from "../../semantics/hir/index.js";
import type { HirLambdaExpr } from "../../semantics/hir/index.js";
import {
  buildOptimized,
  findFunction,
  getFunctionBodyValueExpr,
} from "./pipeline-test-helpers.js";

describe("compiler optimization pipeline: constant-control", () => {
  it("folds pure helper calls, prunes dead generic instances, and shrinks lambda captures", async () => {
    const { optimized } = await buildOptimized({
      files: {
        "main.voyd": `
fn add_one(value: i32) -> i32
  value + 1

fn dead<T>(value: T) -> T
  value

fn make_adder(seed: i32)
  let spare = 99
  (value: i32) =>
    if add_one(40) == 41 then:
      seed + value
    else:
      dead<i32>(spare)

pub fn main() -> i32
  let adder = make_adder(2)
  adder(3)
`,
      },
    });

    const program = optimized.program;
    const moduleId = "src::main";
    const lambda = Array.from(
      program.modules.get(moduleId)?.hir.expressions.values() ?? [],
    ).find((expr): expr is HirLambdaExpr => expr.exprKind === "lambda");
    expect(lambda?.captures.map((capture) => capture.symbol)).toHaveLength(1);

    const deadFn = findFunction({ moduleId, name: "dead", program });
    expect(deadFn?.kind).toBe("function");
    if (!deadFn || deadFn.kind !== "function") return;
    const deadInstantiations = program.functions.getInstantiationInfo(
      moduleId,
      deadFn.symbol,
    );
    expect(deadInstantiations?.size ?? 0).toBe(0);
  });

  it("folds i64 constants without losing 64-bit precision", async () => {
    const { optimized } = await buildOptimized({
      files: {
        "main.voyd": `
pub fn main() -> i64
  9007199254740993i64 + 2i64
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

    const folded = getFunctionBodyValueExpr({
      moduleId: "src::main",
      symbol: mainFn.symbol,
      program: optimized.program,
    });
    expect(folded).toMatchObject({
      exprKind: "literal",
      literalKind: "i64",
      value: "9007199254740995",
    });
  });

  it("folds i32 constants with 32-bit integer semantics", async () => {
    const { optimized } = await buildOptimized({
      files: {
        "main.voyd": `
pub fn main() -> i32
  2147483647i32 * 2147483647i32
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

    const folded = getFunctionBodyValueExpr({
      moduleId: "src::main",
      symbol: mainFn.symbol,
      program: optimized.program,
    });
    expect(folded).toMatchObject({
      exprKind: "literal",
      literalKind: "i32",
      value: "1",
    });
  });

  it("folds f32 constants with single-precision semantics", async () => {
    const scenarios = [
      {
        name: "equality rounds operands to f32 first",
        source: `
pub fn main() -> bool
  16777217.0 == 16777216.0
`,
        expected: {
          exprKind: "literal",
          literalKind: "boolean",
          value: "true",
        },
      },
      {
        name: "arithmetic rounds each folded f32 result",
        source: `
pub fn main() -> f64
  16777217.0 + 1.0
`,
        expected: {
          exprKind: "literal",
          literalKind: "f32",
          value: "16777216",
        },
      },
    ] as const;

    for (const scenario of scenarios) {
      const { optimized } = await buildOptimized({
        files: { "main.voyd": scenario.source },
        transformProgram: (program) => {
          program.modules.get("src::main")?.hir.expressions.forEach((expr) => {
            if (expr.exprKind !== "literal" || expr.literalKind !== "f64") {
              return;
            }
            expr.literalKind = "f32";
          });
        },
      });

      const mainFn = findFunction({
        moduleId: "src::main",
        name: "main",
        program: optimized.program,
      });
      expect(mainFn?.kind, scenario.name).toBe("function");
      if (!mainFn || mainFn.kind !== "function") continue;

      const folded = getFunctionBodyValueExpr({
        moduleId: "src::main",
        symbol: mainFn.symbol,
        program: optimized.program,
      });
      expect(folded, scenario.name).toMatchObject(scenario.expected);
    }
  });

  it("preserves signed division overflow traps during constant folding", async () => {
    const scenarios = [
      {
        name: "i32",
        source: `
pub fn main() -> i32
  -2147483648i32 / -1i32
`,
      },
      {
        name: "i64",
        source: `
pub fn main() -> i64
  -9223372036854775808i64 / -1i64
`,
      },
    ] as const;

    for (const scenario of scenarios) {
      const { optimized } = await buildOptimized({
        files: { "main.voyd": scenario.source },
      });

      const mainFn = findFunction({
        moduleId: "src::main",
        name: "main",
        program: optimized.program,
      });
      expect(mainFn?.kind).toBe("function");
      if (!mainFn || mainFn.kind !== "function") continue;

      const bodyExpr = getFunctionBodyValueExpr({
        moduleId: "src::main",
        symbol: mainFn.symbol,
        program: optimized.program,
      });
      expect(bodyExpr?.exprKind, scenario.name).toBe("call");
    }
  });

  it("keeps discriminant evaluation when simplifying matches with known constructors", async () => {
    const { optimized } = await buildOptimized({
      files: {
        "main.voyd": `
eff Log
  info(resume) -> void

obj Box {
  value: i32
}

fn make_box(): Log -> Box
  Log::info()
  Box { value: 1 }

pub fn main(): Log -> i32
  match(make_box())
    Box: 7
    else: 8
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

    const moduleView = optimized.program.modules.get("src::main");
    const body = getFunctionBodyValueExpr({
      moduleId: "src::main",
      symbol: mainFn.symbol,
      program: optimized.program,
    });
    expect(body?.exprKind).toBe("block");
    if (!body || body.exprKind !== "block") return;
    expect(body.statements).toHaveLength(1);

    const stmt = moduleView?.hir.statements.get(body.statements[0]!);
    expect(stmt?.kind).toBe("expr-stmt");
    if (!stmt || stmt.kind !== "expr-stmt") return;

    const discriminant = moduleView?.hir.expressions.get(stmt.expr);
    expect(discriminant?.exprKind).toBe("call");
  });

  it("uses exact parameter facts to simplify constructor matches", async () => {
    const { optimized } = await buildOptimized({
      files: {
        "main.voyd": `
obj Box {
  value: i32
}

obj Alt {
  value: i32
}

type Runner = Box | Alt

fn classify(runner: Runner) -> i32
  match(runner)
    Box: 7
    else: 8

fn invoke(runner: Runner) -> i32
  classify(runner)

pub fn main() -> i32
  invoke(Box { value: 4 })
`,
      },
    });

    const moduleId = "src::main";
    const program = optimized.program;
    const classifyFn = findFunction({ moduleId, name: "classify", program });
    expect(classifyFn?.kind).toBe("function");
    if (!classifyFn || classifyFn.kind !== "function") return;
    const moduleView = program.modules.get(moduleId);
    expect(moduleView).toBeDefined();
    if (!moduleView) return;

    let sawMatch = false;
    walkExpression({
      exprId: classifyFn.body,
      hir: moduleView.hir,
      onEnterExpression: (_exprId, expr) => {
        if (expr.exprKind === "match") {
          sawMatch = true;
          return { stop: true };
        }
      },
    });
    expect(sawMatch).toBe(false);
  });
});
