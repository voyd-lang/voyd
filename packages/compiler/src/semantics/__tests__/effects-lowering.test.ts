import { describe, expect, it } from "vitest";
import { parse } from "../../parser/parser.js";
import { runBindingPipeline } from "../binding/binding.js";
import { SymbolTable } from "../binder/index.js";
import { createHirBuilder } from "../hir/builder.js";
import { runLoweringPipeline } from "../lowering/lowering.js";
import { toSourceSpan } from "../utils.js";
import type { ModuleNode, ModuleGraph } from "../../modules/types.js";

const lower = (code: string) => {
  const form = parse(code, "/proj/src/main.voyd");
  const symbolTable = new SymbolTable({ rootOwner: form.syntaxId });
  const module: ModuleNode = {
    id: "src::main",
    path: { namespace: "src", segments: ["main"] },
    origin: { kind: "file", filePath: "/proj/src/main.voyd" },
    ast: form,
    source: code,
    dependencies: [],
  };
  const graph: ModuleGraph = {
    entry: module.id,
    modules: new Map([[module.id, module]]),
    diagnostics: [],
  };

  const binding = runBindingPipeline({
    moduleForm: form,
    symbolTable,
    module,
    graph,
    moduleExports: new Map(),
    dependencies: new Map(),
  });

  const builder = createHirBuilder({
    path: module.id,
    scope: symbolTable.rootScope,
    ast: form.syntaxId,
    span: toSourceSpan(form),
  });

  return runLoweringPipeline({
    builder,
    binding,
    moduleNodeId: form.syntaxId,
    modulePath: module.path,
    packageId: binding.packageId,
    isPackageRoot: binding.isPackageRoot,
  });
};

describe("effects parsing/binding/lowering", () => {
  it("lowers effect declarations with operations", () => {
    const hir = lower(`
eff Async
  fn await(tail) -> i32
  fn resolve(resume, value: i32) -> void
`);
    const effect = Array.from(hir.items.values()).find(
      (item) => item.kind === "effect"
    );
    expect(effect).toBeDefined();
    if (effect?.kind !== "effect") return;
    expect(effect.operations).toHaveLength(2);
    const [awaitOp, resolveOp] = effect.operations;
    expect(awaitOp.resumable).toBe("fn");
    expect(resolveOp.resumable).toBe("ctl");
    expect(resolveOp.parameters[0]?.span).toBeDefined();
  });

  it("lowers try handlers with qualified operation heads", () => {
    const hir = lower(`
eff Async
  fn await(tail) -> i32

fn main(): Async -> i32
  try
    Async::await()
  Async::await(tail):
    tail(1)
`);
    const handler = Array.from(hir.expressions.values()).find(
      (expr) => expr.kind === "expr" && expr.exprKind === "effect-handler"
    );
    expect(handler).toBeDefined();
    if (!handler || handler.exprKind !== "effect-handler") return;
    expect(handler.handlers).toHaveLength(1);
    const clause = handler.handlers[0]!;
    expect(clause.resumable).toBe("fn");
    expect(typeof clause.operation).toBe("number");
  });

  it("lowers try handlers with resume continuations", () => {
    const hir = lower(`
eff Async
  fn await(resume, value: i32) -> i32

fn main(): Async -> i32
  try
    Async::await(1)
  Async::await(resume, value):
    resume(value)
`);
    const handler = Array.from(hir.expressions.values()).find(
      (expr) => expr.kind === "expr" && expr.exprKind === "effect-handler"
    );
    expect(handler).toBeDefined();
    if (!handler || handler.exprKind !== "effect-handler") return;
    expect(handler.handlers).toHaveLength(1);
    const clause = handler.handlers[0]!;
    expect(clause.resumable).toBe("ctl");
    expect(clause.parameters).toHaveLength(2);
  });

  it("hoists indented qualified handlers out of the try block", () => {
    const hir = lower(`
eff Async
  fn await(tail) -> i32

fn main(): Async -> i32
  try
    Async::await()
    Async::await(tail):
      tail(1)
`);
    const handler = Array.from(hir.expressions.values()).find(
      (expr) => expr.kind === "expr" && expr.exprKind === "effect-handler"
    );
    expect(handler).toBeDefined();
    if (!handler || handler.exprKind !== "effect-handler") return;
    expect(handler.handlers).toHaveLength(1);
    expect(handler.handlers[0]?.parameters).toHaveLength(1);
    expect(handler.handlers[0]?.resumable).toBe("fn");
  });

  it("marks try forward handlers to propagate unhandled operations", () => {
    const hir = lower(`
eff Async
  fn await(tail) -> i32
eff Log
  fn write(tail) -> void

fn main(): (Async, Log) -> i32
  try forward
    let value = Async::await()
    Log::write()
    value
  Async::await(tail):
    tail(1)
`);
    const handler = Array.from(hir.expressions.values()).find(
      (expr) => expr.kind === "expr" && expr.exprKind === "effect-handler"
    );
    expect(handler).toBeDefined();
    if (!handler || handler.exprKind !== "effect-handler") return;
    expect(handler.forwardUnhandled).toBe(true);
  });
});
