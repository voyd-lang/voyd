import { describe, expect, it } from "vitest";

import { parse } from "../../../parser/parser.js";
import { semanticsPipeline } from "../../pipeline.js";
import type { HirCallExpr, HirExpression } from "../../hir/index.js";
import { getSymbolTable } from "../../_internal/symbol-table.js";
import type { SymbolTable } from "../../binder/index.js";
import { DiagnosticError } from "../../../diagnostics/index.js";

const effectOps = (
  row: number,
  effects: ReturnType<typeof semanticsPipeline>["typing"]["effects"]
): readonly string[] => effects.getRow(row).operations.map((op) => op.name);

const findCallByCallee = (
  hir: ReturnType<typeof semanticsPipeline>["hir"],
  symbolName: string,
  symbolTable: SymbolTable
): HirCallExpr | undefined => {
  for (const expr of hir.expressions.values()) {
    if (expr.exprKind !== "call") continue;
    const callee = hir.expressions.get(expr.callee);
    if (callee?.exprKind !== "identifier") continue;
    const name = symbolTable.getSymbol(callee.symbol).name;
    if (name === symbolName) {
      return expr as HirCallExpr;
    }
  }
  return undefined;
};

const findCallsByCallee = (
  hir: ReturnType<typeof semanticsPipeline>["hir"],
  symbolName: string,
  symbolTable: SymbolTable
): HirCallExpr[] =>
  Array.from(hir.expressions.values()).filter((expr): expr is HirCallExpr => {
    if (expr.exprKind !== "call") {
      return false;
    }
    const callee = hir.expressions.get(expr.callee);
    if (callee?.exprKind !== "identifier") {
      return false;
    }
    return symbolTable.getSymbol(callee.symbol).name === symbolName;
  });

const findEffectHandler = (
  hir: ReturnType<typeof semanticsPipeline>["hir"]
): HirExpression | undefined =>
  Array.from(hir.expressions.values()).find(
    (expr) => expr.exprKind === "effect-handler"
  );

describe("effect inference", () => {
  it("records effect rows for calls and functions", () => {
    const ast = parse(
      `
eff Async
  fn await(tail) -> i32

fn main()
  Async::await()
`,
      "effects.voyd"
    );

    const semantics = semanticsPipeline(ast);
    const { typing, hir } = semantics;
    const symbolTable = getSymbolTable(semantics);
    const callExpr = findCallByCallee(hir, "await", symbolTable);
    expect(callExpr).toBeDefined();
    if (!callExpr) return;

    const callOps = effectOps(
      typing.effects.getExprEffect(callExpr.id)!,
      typing.effects
    );
    expect(callOps).toContain("Async.await");

    const mainSymbol = symbolTable.resolve("main", symbolTable.rootScope);
    expect(typeof mainSymbol).toBe("number");
    if (typeof mainSymbol !== "number") return;
    const mainSig = typing.functions.getSignature(mainSymbol);
    expect(mainSig).toBeDefined();
    if (!mainSig) return;
    const fnOps = effectOps(mainSig.effectRow, typing.effects);
    expect(fnOps).toEqual(["Async.await"]);
  });

  it("types explicit effect operation type arguments in both namespace positions", () => {
    const ast = parse(
      `
eff Gen<T>
  fn pass(resume, value: T) -> T

fn from_target(): () -> i32
  try
    Gen<i32>::pass(1)
  Gen::pass(resume, value):
    resume(value)

fn from_member(): () -> i32
  try
    Gen::pass<i32>(2)
  Gen::pass(resume, value):
    resume(value)
`,
      "effects.voyd"
    );

    const semantics = semanticsPipeline(ast);
    const { hir, typing } = semantics;
    const symbolTable = getSymbolTable(semantics);
    const passCalls = findCallsByCallee(hir, "pass", symbolTable).filter(
      (expr) => expr.args.length === 1
    );
    expect(passCalls).toHaveLength(2);

    const i32 = typing.arena.internPrimitive("i32");
    passCalls.forEach((call) => {
      const typeArgsByInstance = typing.callTypeArguments.get(call.id);
      const typeArgs = typeArgsByInstance
        ? Array.from(typeArgsByInstance.values())[0]
        : undefined;
      expect(typeArgs).toEqual([i32]);
      expect(typing.table.getExprType(call.id)).toBe(i32);
    });
  });

  it("types explicit effect operation type args for overloaded operations", () => {
    const ast = parse(
      `
eff Gen<T>
  fn pass(resume, value: T) -> T
  fn pass(resume) -> T

fn from_target(): () -> i32
  try
    Gen<i32>::pass(1)
  Gen::pass(resume, value: i32):
    resume(value)
  Gen::pass(resume):
    resume(0)
`,
      "effects.voyd"
    );

    const semantics = semanticsPipeline(ast);
    const { hir, typing } = semantics;
    const symbolTable = getSymbolTable(semantics);
    const passCalls = findCallsByCallee(hir, "pass", symbolTable).filter(
      (expr) => expr.args.length === 1
    );
    expect(passCalls).toHaveLength(1);
    const call = passCalls[0]!;

    const i32 = typing.arena.internPrimitive("i32");
    const typeArgsByInstance = typing.callTypeArguments.get(call.id);
    const typeArgs = typeArgsByInstance
      ? Array.from(typeArgsByInstance.values())[0]
      : undefined;
    expect(typeArgs).toEqual([i32]);
    expect(typing.table.getExprType(call.id)).toBe(i32);
  });

  it("diagnoses no-overload for explicit type args with mismatched argument types", () => {
    const ast = parse(
      `
eff Gen<T>
  fn pass(resume, value: T) -> T
  fn pass(resume) -> T

fn bad()
  Gen<i32>::pass(true)
`,
      "effects.voyd"
    );

    let caught: DiagnosticError | undefined;
    try {
      semanticsPipeline(ast);
    } catch (error) {
      caught = error as DiagnosticError;
    }

    expect(caught?.diagnostic.code).toBe("TY0008");
  });

  it("diagnoses mismatched annotations", () => {
    const ast = parse(
      `
eff Log
  fn write(resume, msg: i32) -> void

eff Async
  fn await(tail) -> void

fn log_it(): Async -> void
  Log::write(1)
`,
      "effects.voyd"
    );

    let caught: unknown;
    try {
      semanticsPipeline(ast);
    } catch (error) {
      caught = error;
    }

    if (caught && (caught as any).diagnostic?.code !== "TY0014") {
      // eslint-disable-next-line no-console
      console.debug((caught as any).diagnostic);
    }
    expect(caught && (caught as any).diagnostic?.code).toBe("TY0014");
  });

  it("allows effect annotations to include ops not used by the body", () => {
    const ast = parse(
      `
eff Async
  fn await(resume, value: i32) -> i32
  fn log(resume, msg: i32) -> void

fn inner(x: i32): Async -> i32
  Async::await(x) + 1
`,
      "effects.voyd"
    );

    const semantics = semanticsPipeline(ast);
    const { typing } = semantics;
    const symbolTable = getSymbolTable(semantics);
    const innerSymbol = symbolTable.resolve("inner", symbolTable.rootScope);
    expect(typeof innerSymbol).toBe("number");
    if (typeof innerSymbol !== "number") return;

    const signature = typing.functions.getSignature(innerSymbol);
    expect(signature).toBeDefined();
    if (!signature) return;

    const ops = effectOps(signature.effectRow, typing.effects);
    expect(ops).toEqual(["Async.await(i32)", "Async.log(i32)"]);
  });

  it("eliminates handled operations", () => {
    const ast = parse(
      `
eff Async
  fn await(tail) -> i32

fn handled()
  try
    Async::await()
  Async::await(tail):
    tail(1)
`,
      "effects.voyd"
    );

    const semantics = semanticsPipeline(ast);
    const { typing, hir } = semantics;
    const symbolTable = getSymbolTable(semantics);
    const handler = findEffectHandler(hir);
    expect(handler).toBeDefined();
    if (!handler) return;
    const handlerOps = effectOps(
      typing.effects.getExprEffect(handler.id)!,
      typing.effects
    );
    expect(handlerOps).toHaveLength(0);

    const handledSymbol = symbolTable.resolve("handled", symbolTable.rootScope);
    expect(typeof handledSymbol).toBe("number");
    if (typeof handledSymbol !== "number") return;
    const signature = typing.functions.getSignature(handledSymbol);
    expect(signature).toBeDefined();
    if (!signature) return;
    expect(effectOps(signature.effectRow, typing.effects)).toHaveLength(0);
  });

  it("diagnoses missing tail resumes", () => {
    const ast = parse(
      `
eff Async
  fn await(tail) -> i32

fn missing_tail()
  try
    Async::await()
  Async::await(tail):
    1
`,
      "effects.voyd"
    );

    let caught: unknown;
    try {
      semanticsPipeline(ast);
    } catch (error) {
      caught = error;
    }

    const diagnostic = (caught as any)?.diagnostic;
    expect(diagnostic?.code).toBe("TY0015");
    expect(diagnostic?.message).toMatch(/observed 0/);
  });

  it("allows sequential tail resumptions because the first call terminates", () => {
    const ast = parse(
      `
eff Async
  fn await(tail) -> i32

fn handled()
  try
    Async::await()
  Async::await(tail):
    tail(1)
    tail(2)
`,
      "effects.voyd"
    );

    const semantics = semanticsPipeline(ast);
    const { typing } = semantics;
    const symbolTable = getSymbolTable(semantics);
    const handledSymbol = symbolTable.resolve("handled", symbolTable.rootScope);
    expect(typeof handledSymbol).toBe("number");
    if (typeof handledSymbol !== "number") return;
    const signature = typing.functions.getSignature(handledSymbol);
    expect(signature).toBeDefined();
    if (!signature) return;
    expect(effectOps(signature.effectRow, typing.effects)).toHaveLength(0);
  });

  it("rejects resumptions when the continuation escapes", () => {
    const ast = parse(
      `
eff Async
  fn await(resume, value: i32) -> i32

fn forward(cb: fn(i32) -> i32, value: i32) -> i32
  cb(value)

fn handled(value: i32)
  try
    Async::await(value)
  Async::await(resume, value):
    forward(resume, value)
`,
      "effects.voyd"
    );

    let caught: unknown;
    try {
      semanticsPipeline(ast);
    } catch (error) {
      caught = error;
    }

    const diagnostic = (caught as any)?.diagnostic;
    expect(diagnostic?.code).toBe("TY0035");
    expect(diagnostic?.message).toMatch(/continuation escapes/);
  });

  it("allows tail resumptions when later calls are unreachable", () => {
    const ast = parse(
      `
eff Async
  fn await(tail) -> i32

fn handled(flag: bool)
  try
    Async::await()
  Async::await(tail):
    if flag then:
      tail(1)
    tail(2)
`,
      "effects.voyd"
    );

    const semantics = semanticsPipeline(ast);
    const { typing } = semantics;
    const symbolTable = getSymbolTable(semantics);
    const handledSymbol = symbolTable.resolve("handled", symbolTable.rootScope);
    expect(typeof handledSymbol).toBe("number");
    if (typeof handledSymbol !== "number") return;
    const signature = typing.functions.getSignature(handledSymbol);
    expect(signature).toBeDefined();
    if (!signature) return;
    expect(effectOps(signature.effectRow, typing.effects)).toHaveLength(0);
  });

  it("allows resumptions when later calls are unreachable", () => {
    const ast = parse(
      `
eff Async
  fn await(resume) -> i32

fn handled(flag: bool)
  try
    Async::await()
  Async::await(resume):
    if flag then:
      resume(1)
    resume(2)
`,
      "effects.voyd"
    );

    const semantics = semanticsPipeline(ast);
    const { typing } = semantics;
    const symbolTable = getSymbolTable(semantics);
    const handledSymbol = symbolTable.resolve("handled", symbolTable.rootScope);
    expect(typeof handledSymbol).toBe("number");
    if (typeof handledSymbol !== "number") return;
    const signature = typing.functions.getSignature(handledSymbol);
    expect(signature).toBeDefined();
    if (!signature) return;
    expect(effectOps(signature.effectRow, typing.effects)).toHaveLength(0);
  });

  it("rejects tail continuations that escape", () => {
    const ast = parse(
      `
eff Async
  fn await(tail) -> i32

fn forward(cb: fn(i32) -> i32) -> i32
  cb(2)

fn main()
  try
    Async::await()
  Async::await(tail):
    forward(tail)
`,
      "effects.voyd"
    );

    let caught: unknown;
    try {
      semanticsPipeline(ast);
    } catch (error) {
      caught = error;
    }

    const diagnostic = (caught as any)?.diagnostic;
    expect(diagnostic?.code).toBe("TY0015");
    expect(diagnostic?.message).toMatch(/continuation escapes/);
  });

  it("rejects tail resumptions with uncertain control flow", () => {
    const ast = parse(
      `
eff Async
  fn await(tail) -> i32

fn maybe(x: bool)
  try
    Async::await()
  Async::await(tail):
    if x then:
      tail(1)
    else:
      1
`,
      "effects.voyd"
    );

    let caught: unknown;
    try {
      semanticsPipeline(ast);
    } catch (error) {
      caught = error;
    }

    const diagnostic = (caught as any)?.diagnostic;
    expect(diagnostic?.code).toBe("TY0015");
    expect(diagnostic?.message).toMatch(/observed 0\.\.1/);
  });

  it("allows resumable handlers to call resume()", () => {
    const ast = parse(
      `
eff Async
  fn await(resume, value: i32) -> i32

fn handled()
  try
    Async::await(1)
  Async::await(resume, value):
    resume(value)
`,
      "effects.voyd"
    );

    const semantics = semanticsPipeline(ast);
    const { typing } = semantics;
    const symbolTable = getSymbolTable(semantics);
    const handledSymbol = symbolTable.resolve("handled", symbolTable.rootScope);
    expect(typeof handledSymbol).toBe("number");
    if (typeof handledSymbol !== "number") return;
    const signature = typing.functions.getSignature(handledSymbol);
    expect(signature).toBeDefined();
    if (!signature) return;
    expect(effectOps(signature.effectRow, typing.effects)).toHaveLength(0);
  });

  it("keeps effects when handlers re-raise", () => {
    const ast = parse(
      `
eff Async
  fn await(resume) -> i32

fn reraises()
  try
    Async::await()
  Async::await(resume):
    Async::await()
`,
      "effects.voyd"
    );

    const semantics = semanticsPipeline(ast);
    const { typing } = semantics;
    const symbolTable = getSymbolTable(semantics);
    const reraisesSymbol = symbolTable.resolve("reraises", symbolTable.rootScope);
    expect(typeof reraisesSymbol).toBe("number");
    if (typeof reraisesSymbol !== "number") return;
    const signature = typing.functions.getSignature(reraisesSymbol);
    expect(signature).toBeDefined();
    if (!signature) return;
    expect(effectOps(signature.effectRow, typing.effects)).toEqual([
      "Async.await",
    ]);
  });

  it("reports unhandled effects even when another clause re-raises", () => {
    const ast = parse(
      `
eff Async
  fn await(resume) -> i32

eff Log
  fn write(resume, msg: i32) -> void

fn mixed()
  try
    Async::await()
    Log::write(1)
  Async::await(resume):
    Async::await()
`,
      "effects.voyd"
    );

    let caught: unknown;
    try {
      semanticsPipeline(ast);
    } catch (error) {
      caught = error;
    }

    expect(caught && (caught as any).diagnostic?.code).toBe("TY0013");
  });

  it("propagates callback effects", () => {
    const ast = parse(
      `
eff Async
  fn await(tail) -> i32

fn run(cb: fn() -> i32)
  cb()

fn main()
  run(() => Async::await())
`,
      "effects.voyd"
    );

    const semantics = semanticsPipeline(ast);
    const { typing } = semantics;
    const symbolTable = getSymbolTable(semantics);
    const runSymbol = symbolTable.resolve("run", symbolTable.rootScope);
    const mainSymbol = symbolTable.resolve("main", symbolTable.rootScope);
    expect(typeof runSymbol).toBe("number");
    expect(typeof mainSymbol).toBe("number");
    if (typeof runSymbol !== "number" || typeof mainSymbol !== "number") return;

    const runSig = typing.functions.getSignature(runSymbol);
    const mainSig = typing.functions.getSignature(mainSymbol);
    expect(runSig && mainSig).toBeTruthy();
    if (!runSig || !mainSig) return;

    expect(typing.effects.isOpen(runSig.effectRow)).toBe(true);
    expect(typing.effects.isOpen(mainSig.effectRow)).toBe(false);
    expect(effectOps(mainSig.effectRow, typing.effects)).toEqual(["Async.await"]);
  });

  it("specializes callback effects to pure for pure callbacks", () => {
    const ast = parse(
      `
fn run(cb: fn() -> i32)
  cb()

fn main()
  run(() -> i32 => 1)
`,
      "effects.voyd"
    );

    const semantics = semanticsPipeline(ast);
    const { typing } = semantics;
    const symbolTable = getSymbolTable(semantics);
    const runSymbol = symbolTable.resolve("run", symbolTable.rootScope);
    const mainSymbol = symbolTable.resolve("main", symbolTable.rootScope);
    expect(typeof runSymbol).toBe("number");
    expect(typeof mainSymbol).toBe("number");
    if (typeof runSymbol !== "number" || typeof mainSymbol !== "number") return;

    const runSig = typing.functions.getSignature(runSymbol);
    const mainSig = typing.functions.getSignature(mainSymbol);
    expect(runSig && mainSig).toBeTruthy();
    if (!runSig || !mainSig) return;

    expect(typing.effects.isOpen(runSig.effectRow)).toBe(true);
    expect(typing.effects.isEmpty(mainSig.effectRow)).toBe(true);
  });

  it("reports missing handlers for closed rows", () => {
    const ast = parse(
      `
eff Async
  fn await(tail) -> i32

fn missing()
  try Async::await()
`,
      "effects.voyd"
    );

    let caught: unknown;
    try {
      semanticsPipeline(ast);
    } catch (error) {
      caught = error;
    }

    expect(caught && (caught as any).diagnostic?.code).toBe("TY0013");
  });

  it("infers effects for generic functions", () => {
    const ast = parse(
      `
eff Async
  fn await(tail) -> i32

fn lift<T>(value: T) -> i32
  Async::await()

fn caller() -> i32
  lift(1)
`,
      "effects.voyd"
    );

    const semantics = semanticsPipeline(ast);
    const { typing } = semantics;
    const symbolTable = getSymbolTable(semantics);
    const liftSymbol = symbolTable.resolve("lift", symbolTable.rootScope);
    const callerSymbol = symbolTable.resolve("caller", symbolTable.rootScope);
    expect(typeof liftSymbol).toBe("number");
    expect(typeof callerSymbol).toBe("number");
    if (typeof liftSymbol !== "number" || typeof callerSymbol !== "number") {
      return;
    }

    const liftSig = typing.functions.getSignature(liftSymbol);
    const callerSig = typing.functions.getSignature(callerSymbol);
    expect(liftSig && callerSig).toBeTruthy();
    if (!liftSig || !callerSig) return;

    expect(effectOps(liftSig.effectRow, typing.effects)).toEqual([
      "Async.await",
    ]);
    expect(effectOps(callerSig.effectRow, typing.effects)).toEqual([
      "Async.await",
    ]);
  });
});
