import { describe, expect, it } from "vitest";
import { parse } from "../../parser/parser.js";
import { semanticsPipeline } from "../../semantics/pipeline.js";
import { DiagnosticError } from "../../diagnostics/index.js";
import { createContinuationBackend, GcContinuationBackend } from "../index.js";

const compile = (source: string) =>
  semanticsPipeline(parse(source, "/proj/src/main.voyd"));

describe("continuation backend runtime", () => {
  it("supports resumable operations with multiple resumes", () => {
    const semantics = compile(`
eff Ping
  fn ping(resume) -> i32

fn trigger(): Ping -> i32
  Ping::ping()

fn main(): () -> i32
  try
    trigger()
  Ping::ping(resume):
    let first = resume(1)
    let second = resume(7)
    second
`);
    const backend = createContinuationBackend({ semantics });
    expect(backend.runByName({ name: "main" })).toBe(7);
  });

  it("guards tail resumptions at runtime when continuations escape", () => {
    const semantics = compile(`
eff Async
  fn await(tail) -> i32

fn forward(cb: fn(i32) -> i32) -> i32
  0

fn main()
  try
    Async::await()
  Async::await(tail):
    forward(tail)
`);
    const backend = createContinuationBackend({ semantics });
    expect(() => backend.runByName({ name: "main" })).toThrow(/observed 0/);
  });

  it("surfaces diagnostics for unhandled operations in closed handlers", () => {
    let caught: unknown;
    try {
      compile(`
eff Async
  fn await(tail) -> i32
  fn resolve(resume, value: i32) -> i32

fn main(): Async -> i32
  try
    Async::await()
    Async::resolve(2)
  Async::await(tail):
    tail(1)
`);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DiagnosticError);
    expect((caught as DiagnosticError | undefined)?.diagnostic.code).toBe(
      "TY0013"
    );
  });

  it("drops handled operations from effect rows", () => {
    const semantics = compile(`
eff Async
  fn await(tail) -> i32

fn handled(): () -> i32
  try
    Async::await()
  Async::await(tail):
    tail(2)
`);
    const symbol = semantics.symbolTable.resolve(
      "handled",
      semantics.symbolTable.rootScope
    );
    expect(typeof symbol).toBe("number");
    if (typeof symbol !== "number") return;
    const signature = semantics.typing.functions.getSignature(symbol);
    expect(signature).toBeDefined();
    if (!signature) return;
    expect(semantics.typing.effects.isEmpty(signature.effectRow)).toBe(true);
  });

  it("runs higher-order effectful callbacks through the backend", () => {
    const semantics = compile(`
eff Async
  fn await(resume) -> i32

fn run(cb: fn() -> i32): Async -> i32
  cb()

fn awaiter(): Async -> i32
  Async::await()

fn main(): () -> i32
  try
    run(() => awaiter())
  Async::await(resume):
    resume(9)
`);
    const backend = createContinuationBackend({ semantics });
    expect(backend.runByName({ name: "main" })).toBe(9);
  });

  it("accepts the stack-switching flag while falling back to the GC backend", () => {
    const semantics = compile(`
fn main(): () -> i32
  1
`);
    const backend = createContinuationBackend({
      semantics,
      options: { stackSwitching: true },
    });
    expect(backend).toBeInstanceOf(GcContinuationBackend);
    expect(backend.mode).toBe("stack-switch");
    expect(backend.runByName({ name: "main" })).toBe(1);
  });
});
