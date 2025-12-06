import { describe, expect, it } from "vitest";

import { parse } from "../../../parser/parser.js";
import { semanticsPipeline } from "../../pipeline.js";
import type { HirCallExpr, HirExpression } from "../../hir/index.js";

const effectOps = (
  row: number,
  effects: ReturnType<typeof semanticsPipeline>["typing"]["effects"]
): readonly string[] => effects.getRow(row).operations.map((op) => op.name);

const findCallByCallee = (
  hir: ReturnType<typeof semanticsPipeline>["hir"],
  symbolName: string,
  symbolTable: ReturnType<typeof semanticsPipeline>["symbolTable"]
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

    const { typing, hir, symbolTable } = semanticsPipeline(ast);
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

    const { typing, hir, symbolTable } = semanticsPipeline(ast);
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

    expect(caught && (caught as any).diagnostic?.code).toBe("TY0015");
  });

  it("rejects multiple tail resumes", () => {
    const ast = parse(
      `
eff Async
  fn await(tail) -> i32

fn doubled()
  try
    Async::await()
  Async::await(tail):
    tail(1)
    tail(2)
`,
      "effects.voyd"
    );

    let caught: unknown;
    try {
      semanticsPipeline(ast);
    } catch (error) {
      caught = error;
    }

    expect(caught && (caught as any).diagnostic?.code).toBe("TY0015");
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

    const { typing, symbolTable } = semanticsPipeline(ast);
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

    const { typing, symbolTable } = semanticsPipeline(ast);
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

    const { typing, symbolTable } = semanticsPipeline(ast);
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
    expect(typing.effects.isOpen(mainSig.effectRow)).toBe(true);
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

    const { typing, symbolTable } = semanticsPipeline(ast);
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
