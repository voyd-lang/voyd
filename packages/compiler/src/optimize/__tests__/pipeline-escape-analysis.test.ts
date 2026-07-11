import { describe, expect, it } from "vitest";
import { walkExpression } from "../../semantics/hir/index.js";
import { buildOptimized, findFunction } from "./pipeline-test-helpers.js";

describe("compiler optimization pipeline: escape-analysis", () => {
  it("records non-escaping aggregate and parameter facts across direct pure calls", async () => {
    const { optimized } = await buildOptimized({
      files: {
        "main.voyd": `
obj Vec2 {
  x: i32,
  y: i32
}

fn sum(vec: Vec2) -> i32
  vec.x + vec.y

pub fn main() -> i32
  let vec = Vec2 { x: 1, y: 2 }
  sum(vec)
`,
      },
    });

    const moduleId = "src::main";
    const program = optimized.program;
    const aggregateFact = Array.from(
      optimized.facts.escapeAnalysis.origins.get(moduleId)?.values() ?? [],
    ).find(
      (fact) =>
        fact.originKind === "aggregate" &&
        !fact.escapes &&
        fact.directLocalSymbols.length === 1,
    );
    expect(aggregateFact).toMatchObject({
      originKind: "aggregate",
      escapes: false,
      escapeReasons: [],
    });
    expect(aggregateFact?.directLocalSymbols).toHaveLength(1);

    const sumFn = findFunction({ moduleId, name: "sum", program });
    expect(sumFn?.kind).toBe("function");
    if (!sumFn || sumFn.kind !== "function") return;
    const sumInstanceId = program.functions.getInstanceId(
      moduleId,
      sumFn.symbol,
      [],
    );
    expect(typeof sumInstanceId).toBe("number");
    if (typeof sumInstanceId !== "number") return;
    expect(
      optimized.facts.escapeAnalysis.parameters
        .get(sumInstanceId)
        ?.get(sumFn.parameters[0]!.symbol),
    ).toMatchObject({
      escapes: false,
      escapeReasons: [],
    });
  });

  it("propagates parameter escapes through a multi-hop caller worklist", async () => {
    const { optimized } = await buildOptimized({
      files: {
        "main.voyd": `
obj Vec2 { x: i32, y: i32 }

fn sink(vec: Vec2) -> Vec2
  vec

fn middle(vec: Vec2) -> Vec2
  sink(vec)

fn outer(vec: Vec2) -> Vec2
  middle(vec)

pub fn main() -> i32
  outer(Vec2 { x: 1, y: 2 }).x
`,
      },
    });

    const moduleId = "src::main";
    const parameterFact = (name: string) => {
      const fn = findFunction({
        moduleId,
        name,
        program: optimized.program,
      });
      expect(fn?.kind).toBe("function");
      if (!fn || fn.kind !== "function") return undefined;
      const instanceId = optimized.program.functions.getInstanceId(
        moduleId,
        fn.symbol,
        [],
      );
      return typeof instanceId === "number"
        ? optimized.facts.escapeAnalysis.parameters
            .get(instanceId)
            ?.get(fn.parameters[0]!.symbol)
        : undefined;
    };

    expect(parameterFact("sink")).toMatchObject({
      escapes: true,
      escapeReasons: ["return"],
    });
    expect(parameterFact("middle")).toMatchObject({
      escapes: true,
      escapeReasons: ["call-boundary"],
    });
    expect(parameterFact("outer")).toMatchObject({
      escapes: true,
      escapeReasons: ["call-boundary"],
    });
  });

  it("tracks local aliases back to parameter escape facts", async () => {
    const { optimized } = await buildOptimized({
      files: {
        "main.voyd": `
eff Log
  info(resume, x: i32) -> i32

obj Vec2 {
  x: i32,
  y: i32
}

fn worker(): Log -> i32
  Log::info(5)

fn escaping_identity(vec: Vec2) -> Vec2
  vec

fn identity_alias(vec: Vec2) -> Vec2
  let alias = vec
  alias

fn alias_to_escaping_callee(vec: Vec2) -> Vec2
  let alias = vec
  escaping_identity(alias)

fn alias_closure_capture(vec: Vec2) -> i32
  let alias = vec
  let cb = () => alias.x
  cb()

fn alias_effect_capture(vec: Vec2): () -> i32
  let alias = vec
  try
    worker()
  Log::info(resume, x):
    alias.x + x

fn alias_non_escape(vec: Vec2) -> i32
  let alias = vec
  alias.x + alias.y

pub fn main(): () -> i32
  identity_alias(Vec2 { x: 1, y: 2 }).x +
    alias_to_escaping_callee(Vec2 { x: 3, y: 4 }).x +
    alias_closure_capture(Vec2 { x: 5, y: 6 }) +
    alias_effect_capture(Vec2 { x: 7, y: 8 }) +
    alias_non_escape(Vec2 { x: 9, y: 10 })
`,
      },
    });

    const moduleId = "src::main";
    const program = optimized.program;
    const parameterFact = (name: string) => {
      const fn = findFunction({ moduleId, name, program });
      expect(fn?.kind, name).toBe("function");
      if (!fn || fn.kind !== "function") {
        return undefined;
      }
      const instanceId = program.functions.getInstanceId(
        moduleId,
        fn.symbol,
        [],
      );
      expect(typeof instanceId, name).toBe("number");
      if (typeof instanceId !== "number") {
        return undefined;
      }
      return optimized.facts.escapeAnalysis.parameters
        .get(instanceId)
        ?.get(fn.parameters[0]!.symbol);
    };

    expect(parameterFact("identity_alias")).toMatchObject({
      escapes: true,
      escapeReasons: ["return"],
    });
    expect(parameterFact("alias_to_escaping_callee")).toMatchObject({
      escapes: true,
      escapeReasons: ["call-boundary"],
    });
    expect(parameterFact("alias_closure_capture")).toMatchObject({
      escapes: true,
      escapeReasons: ["closure-capture"],
    });
    expect(parameterFact("alias_effect_capture")).toMatchObject({
      escapes: true,
      escapeReasons: ["effect-handler-capture"],
    });
    expect(parameterFact("alias_non_escape")).toMatchObject({
      escapes: false,
      escapeReasons: [],
    });
  });

  it("tracks aliases through value-producing initializers", async () => {
    const { optimized } = await buildOptimized({
      files: {
        "main.voyd": `
obj Vec2 {
  x: i32,
  y: i32
}

fn if_alias(vec: Vec2, flag: bool) -> Vec2
  let alias =
    if flag:
      vec
    else:
      vec
  alias

fn block_alias(vec: Vec2) -> Vec2
  let alias =
    let inner = vec
    inner
  alias

fn aggregate_if(flag: bool) -> Vec2
  let alias =
    if flag:
      Vec2 { x: 1, y: 2 }
    else:
      Vec2 { x: 3, y: 4 }
  alias

fn aggregate_block() -> Vec2
  let alias =
    let inner = Vec2 { x: 5, y: 6 }
    inner
  alias

pub fn main() -> i32
  if_alias(Vec2 { x: 7, y: 8 }, true).x +
    block_alias(Vec2 { x: 9, y: 10 }).x +
    aggregate_if(false).x +
    aggregate_block().x
`,
      },
    });

    const moduleId = "src::main";
    const program = optimized.program;
    const parameterFact = (name: string) => {
      const fn = findFunction({ moduleId, name, program });
      expect(fn?.kind, name).toBe("function");
      if (!fn || fn.kind !== "function") {
        return undefined;
      }
      const instanceId = program.functions.getInstanceId(
        moduleId,
        fn.symbol,
        [],
      );
      expect(typeof instanceId, name).toBe("number");
      if (typeof instanceId !== "number") {
        return undefined;
      }
      return optimized.facts.escapeAnalysis.parameters
        .get(instanceId)
        ?.get(fn.parameters[0]!.symbol);
    };
    const aggregateFactsForFunction = (name: string) => {
      const fn = findFunction({ moduleId, name, program });
      expect(fn?.kind, name).toBe("function");
      if (!fn || fn.kind !== "function") {
        return [];
      }
      const moduleView = program.modules.get(moduleId);
      const facts = optimized.facts.escapeAnalysis.origins.get(moduleId);
      const exprIds: number[] = [];
      if (!moduleView || !facts) {
        return [];
      }
      walkExpression({
        exprId: fn.body,
        hir: moduleView.hir,
        onEnterExpression: (exprId, expr) => {
          if (expr.exprKind === "object-literal") {
            exprIds.push(exprId);
          }
        },
      });
      return exprIds.map((exprId) => facts.get(exprId));
    };

    expect(parameterFact("if_alias")).toMatchObject({
      escapes: true,
      escapeReasons: ["return"],
    });
    expect(parameterFact("block_alias")).toMatchObject({
      escapes: true,
      escapeReasons: ["return"],
    });
    expect(aggregateFactsForFunction("aggregate_if")).toEqual([
      expect.objectContaining({
        escapes: true,
        escapeReasons: ["return"],
      }),
      expect.objectContaining({
        escapes: true,
        escapeReasons: ["return"],
      }),
    ]);
    expect(aggregateFactsForFunction("aggregate_block")).toEqual([
      expect.objectContaining({
        escapes: true,
        escapeReasons: ["return"],
      }),
    ]);
  });

  it("treats exported aggregate parameters as public-boundary escapes", async () => {
    const { optimized } = await buildOptimized({
      files: {
        "main.voyd": `
obj Vec2 {
  x: i32,
  y: i32
}

pub fn exported(vec: Vec2) -> i32
  vec.x
`,
      },
    });

    const moduleId = "src::main";
    const program = optimized.program;
    const exportedFn = findFunction({ moduleId, name: "exported", program });
    expect(exportedFn?.kind).toBe("function");
    if (!exportedFn || exportedFn.kind !== "function") return;
    const exportedInstanceId = program.functions.getInstanceId(
      moduleId,
      exportedFn.symbol,
      [],
    );
    expect(typeof exportedInstanceId).toBe("number");
    if (typeof exportedInstanceId !== "number") return;
    expect(
      optimized.facts.escapeAnalysis.parameters
        .get(exportedInstanceId)
        ?.get(exportedFn.parameters[0]!.symbol),
    ).toMatchObject({
      escapes: true,
      escapeReasons: ["public-boundary"],
    });
  });

  it("tracks trait-object receiver temporaries through non-escaping direct calls", async () => {
    const { optimized } = await buildOptimized({
      files: {
        "main.voyd": `
trait Runner
  fn run(self) -> i32

obj Box {
  value: i32
}

impl Runner for Box
  fn run(self) -> i32
    self.value

fn invoke(runner: Runner) -> i32
  runner.run()

pub fn main() -> i32
  invoke(Box { value: 4 })
`,
      },
    });

    const moduleId = "src::main";
    const program = optimized.program;
    const invokeFn = findFunction({ moduleId, name: "invoke", program });
    expect(invokeFn?.kind).toBe("function");
    if (!invokeFn || invokeFn.kind !== "function") return;
    const invokeInstanceId = program.functions.getInstanceId(
      moduleId,
      invokeFn.symbol,
      [],
    );
    expect(typeof invokeInstanceId).toBe("number");
    if (typeof invokeInstanceId !== "number") return;

    const runnerParam = invokeFn.parameters[0]!;
    expect(
      program.types.getTypeDesc(
        program.functions.getSignature(moduleId, invokeFn.symbol)!
          .parameters[0]!.typeId,
      ).kind,
    ).toBe("trait");
    expect(
      optimized.facts.escapeAnalysis.parameters
        .get(invokeInstanceId)
        ?.get(runnerParam.symbol),
    ).toMatchObject({
      escapes: false,
      escapeReasons: [],
    });

    const traitObjectFact = Array.from(
      optimized.facts.escapeAnalysis.origins.get(moduleId)?.values() ?? [],
    ).find((fact) => fact.originKind === "trait-object");
    expect(traitObjectFact).toMatchObject({
      escapes: false,
      escapeReasons: [],
    });
  });

  it("marks aggregate captures into closures and effect handler environments", async () => {
    const { optimized } = await buildOptimized({
      files: {
        "main.voyd": `
eff Log
  info(resume, x: i32) -> i32

obj Vec2 {
  x: i32,
  y: i32
}

fn worker(): Log -> i32
  Log::info(5)

fn closure_capture() -> i32
  let vec = Vec2 { x: 1, y: 2 }
  let cb = () => vec.x
  cb()

pub fn main(): () -> i32
  let vec = Vec2 { x: 3, y: 4 }
  closure_capture() + try
    worker()
  Log::info(resume, x):
    vec.x + x
`,
      },
    });

    const moduleId = "src::main";
    const facts = Array.from(
      optimized.facts.escapeAnalysis.origins.get(moduleId)?.values() ?? [],
    );
    expect(facts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          originKind: "closure-environment",
          escapes: false,
          escapeReasons: [],
        }),
        expect.objectContaining({
          originKind: "effect-environment",
          escapes: false,
          escapeReasons: [],
        }),
        expect.objectContaining({
          originKind: "aggregate",
          escapes: true,
          escapeReasons: ["closure-capture"],
        }),
        expect.objectContaining({
          originKind: "aggregate",
          escapes: true,
          escapeReasons: ["effect-handler-capture"],
        }),
      ]),
    );
  });
});
