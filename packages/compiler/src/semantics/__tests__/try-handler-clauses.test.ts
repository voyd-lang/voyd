import { describe, expect, it } from "vitest";
import { parse } from "../../parser/parser.js";
import { Form, type Expr } from "../../parser/index.js";
import { runBindingPipeline } from "../binding/binding.js";
import { SymbolTable } from "../binder/index.js";
import type { BindingResult } from "../binding/types.js";
import {
  collectTryHandlerClauses,
  isTryHandlerClause,
  stripTryHandlerClauses,
} from "../try-handler-clauses.js";

const bind = (source: string): { ast: Form; binding: BindingResult } => {
  const ast = parse(source, "try_handler_clauses.voyd");
  const symbolTable = new SymbolTable({ rootOwner: ast.syntaxId });
  symbolTable.declare({
    name: "try_handler_clauses.voyd",
    kind: "module",
    declaredAt: ast.syntaxId,
  });

  return {
    ast,
    binding: runBindingPipeline({
      moduleForm: ast,
      symbolTable,
    }),
  };
};

const getResolver = (binding: BindingResult) => ({
  resolveBareHandlerHead: ({ name, scope }: { name: string; scope: number }) =>
    typeof binding.symbolTable.resolveByKinds(name, scope, ["effect-op"]) === "number",
  getNestedScope: ({ expr, parentScope }: { expr: Form; parentScope: number }) =>
    binding.scopeByNode.get(expr.syntaxId) ?? parentScope,
});

const findFirstTry = (expr: Expr | undefined): Form | undefined => {
  if (!expr || !(expr instanceof Form)) {
    return undefined;
  }

  if (expr.calls("try")) {
    return expr;
  }

  return expr.toArray().reduce<Form | undefined>(
    (found, child) => found ?? findFirstTry(child),
    undefined,
  );
};

describe("try handler clause helpers", () => {
  it("skips ordinary colon clauses inside try bodies", () => {
    const { ast, binding } = bind(`
eff Async
  fn await(tail) -> void
eff Log
  fn write(tail) -> void

fn forward_nested(flag: bool)
  try forward
    if
      flag:
        Async::await()
      else:
        Log::write()
  Async::await(tail):
    tail()
`);
    const tryExpr = findFirstTry(ast);
    expect(tryExpr).toBeDefined();
    if (!tryExpr) {
      return;
    }

    const body = tryExpr.at(2);
    const handlers = collectTryHandlerClauses({
      expr: body,
      scope: binding.symbolTable.rootScope,
      ...getResolver(binding),
    });

    expect(handlers).toHaveLength(0);
  });

  it("collects inline handlers nested inside branch bodies", () => {
    const { ast, binding } = bind(`
eff Async
  fn await(tail) -> void
eff Log
  fn write(tail) -> void

fn forward_nested_branch(flag: bool)
  try forward
    if
      flag:
        Async::await()
        Async::await(tail):
          tail()
        void
      else:
        Log::write()
        void
`);
    const tryExpr = findFirstTry(ast);
    expect(tryExpr).toBeDefined();
    if (!tryExpr) {
      return;
    }

    const body = tryExpr.at(2);
    const handlers = collectTryHandlerClauses({
      expr: body,
      scope: binding.symbolTable.rootScope,
      ...getResolver(binding),
    });

    expect(handlers).toHaveLength(1);
    expect(handlers[0]?.at(1)?.toJSON()).toEqual(["::", "Async", ["await", "tail"]]);
  });

  it("recognizes bare zero-arg handler heads when wrappers share the name", () => {
    const { ast, binding } = bind(`
eff Env
  get(tail) -> i32

fn get() -> i32
  0

fn main() -> i32
  try
    Env::get()
  get():
    1
`);
    const tryExpr = findFirstTry(ast);
    expect(tryExpr).toBeDefined();
    if (!tryExpr) {
      return;
    }

    const clause = tryExpr.rest.at(-1);
    expect(
      isTryHandlerClause({
        expr: clause,
        scope: binding.symbolTable.rootScope,
        resolveBareHandlerHead: getResolver(binding).resolveBareHandlerHead,
      }),
    ).toBe(true);
  });

  it("does not strip handlers across nested try boundaries", () => {
    const { ast, binding } = bind(`
eff Async
  fn await(tail) -> i32

fn main() -> i32
  try
    try
      Async::await()
      Async::await(tail):
        tail(1)
`);
    const tryExpr = findFirstTry(ast);
    expect(tryExpr).toBeDefined();
    if (!tryExpr) {
      return;
    }

    const body = tryExpr.at(1);
    const stripped = stripTryHandlerClauses({
      expr: body,
      scope: binding.symbolTable.rootScope,
      ...getResolver(binding),
    });

    expect(stripped.handlers).toHaveLength(0);
    expect(stripped.expr).toBe(body);
  });
});
