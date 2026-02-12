import { describe, expect, it } from "vitest";

import type { HirCallExpr, HirIdentifierExpr } from "../../hir/index.js";
import { parse } from "../../../parser/parser.js";
import { semanticsPipeline } from "../../pipeline.js";
import { loadAst } from "../../__tests__/load-ast.js";
import { getSymbolTable } from "../../_internal/symbol-table.js";

describe("generic functions", () => {
  it("instantiates generic functions with explicit type arguments", () => {
    const ast = loadAst("function_generics.voyd");
    const semantics = semanticsPipeline(ast);
    const { hir, typing } = semantics;
    const symbolTable = getSymbolTable(semantics);
    const root = symbolTable.rootScope;

    const addSymbol = symbolTable.resolve("add", root);
    expect(typeof addSymbol).toBe("number");
    if (typeof addSymbol !== "number") {
      return;
    }

    const addScheme = typing.table.getSymbolScheme(addSymbol);
    expect(addScheme).toBeDefined();
    if (!addScheme) {
      return;
    }

    const i32 = typing.arena.internPrimitive("i32");
    const addType = typing.arena.instantiate(addScheme, [i32]);
    const addDesc = typing.arena.get(addType);
    expect(addDesc.kind).toBe("function");
    if (addDesc.kind !== "function") {
      return;
    }
    expect(addDesc.parameters.map((param) => param.type)).toEqual([i32, i32]);
    expect(addDesc.returnType).toBe(i32);

    const addCall = Array.from(hir.expressions.values()).find(
      (expr): expr is HirCallExpr => {
        if (expr.exprKind !== "call") {
          return false;
        }
        const callee = hir.expressions.get(expr.callee);
        return (
          callee?.exprKind === "identifier" &&
          (callee as HirIdentifierExpr).symbol === addSymbol
        );
      }
    );

    expect(addCall).toBeDefined();
    if (!addCall) {
      return;
    }
    expect(typing.table.getExprType(addCall.id)).toBe(i32);
  });

  it("infers generic type arguments from lambda return types", () => {
    const ast = parse(
      `
fn hold<T>(cb: fn() -> T): () -> (fn() -> T)
  cb

pub fn main(): () -> i32
  let cb = hold(() => 1)
  cb()
`,
      "infer.voyd",
    );

    const semantics = semanticsPipeline(ast);
    const { hir, typing } = semantics;
    const symbolTable = getSymbolTable(semantics);
    const root = symbolTable.rootScope;

    const holdSymbol = symbolTable.resolve("hold", root);
    expect(typeof holdSymbol).toBe("number");
    if (typeof holdSymbol !== "number") {
      return;
    }

    const holdCall = Array.from(hir.expressions.values()).find(
      (expr): expr is HirCallExpr => {
        if (expr.exprKind !== "call") {
          return false;
        }
        const callee = hir.expressions.get(expr.callee);
        return (
          callee?.exprKind === "identifier" &&
          (callee as HirIdentifierExpr).symbol === holdSymbol
        );
      }
    );

    expect(holdCall).toBeDefined();
    if (!holdCall) {
      return;
    }

    const typeArgsByInstance = typing.callTypeArguments.get(holdCall.id);
    const typeArgs = typeArgsByInstance
      ? Array.from(typeArgsByInstance.values())[0]
      : undefined;
    expect(typeArgs).toBeDefined();
    const intType = typing.arena.internPrimitive("i32");
    expect(typeArgs).toEqual([intType]);
  });

  it("infers zero-arg generic calls through union return context", () => {
    const ast = parse(
      `
obj Some<T> {
  value: T
}

obj None {}

type Optional<T> = Some<T> | None

fn none<T>() -> Optional<T>
  None {}

fn from_return() -> Optional<i32>
  none()

fn from_arg(value: Optional<i32>) -> i32
  0

pub fn main() -> i32
  let _ = from_return()
  from_arg(none())
`,
      "union_return_context_inference.voyd",
    );

    const semantics = semanticsPipeline(ast);
    const { hir, typing } = semantics;
    const symbolTable = getSymbolTable(semantics);
    const root = symbolTable.rootScope;

    const noneSymbol = symbolTable.resolve("none", root);
    expect(typeof noneSymbol).toBe("number");
    if (typeof noneSymbol !== "number") {
      return;
    }

    const noneCalls = Array.from(hir.expressions.values()).filter(
      (expr): expr is HirCallExpr => {
        if (expr.exprKind !== "call") {
          return false;
        }
        const callee = hir.expressions.get(expr.callee);
        return (
          callee?.exprKind === "identifier" &&
          (callee as HirIdentifierExpr).symbol === noneSymbol
        );
      },
    );
    expect(noneCalls).toHaveLength(2);

    const i32 = typing.arena.internPrimitive("i32");
    noneCalls.forEach((callExpr) => {
      const typeArgsByInstance = typing.callTypeArguments.get(callExpr.id);
      const typeArgs = typeArgsByInstance
        ? Array.from(typeArgsByInstance.values())[0]
        : undefined;
      expect(typeArgs).toEqual([i32]);
    });
  });

  it("backtracks union member matching for generic return inference", () => {
    const ast = parse(
      `
obj Box<T> {}

type Out<T> = Box<T> | Box<i32>

fn make<T>() -> Out<T>
  Box<T> {}

fn from_return() -> Box<i64> | Box<i32>
  make()

pub fn main() -> i32
  let _ = from_return()
  0
`,
      "union_return_context_backtracking.voyd",
    );

    const semantics = semanticsPipeline(ast);
    const { hir, typing } = semantics;
    const symbolTable = getSymbolTable(semantics);
    const root = symbolTable.rootScope;

    const makeSymbol = symbolTable.resolve("make", root);
    expect(typeof makeSymbol).toBe("number");
    if (typeof makeSymbol !== "number") {
      return;
    }

    const makeCall = Array.from(hir.expressions.values()).find(
      (expr): expr is HirCallExpr => {
        if (expr.exprKind !== "call") {
          return false;
        }
        const callee = hir.expressions.get(expr.callee);
        return (
          callee?.exprKind === "identifier" &&
          (callee as HirIdentifierExpr).symbol === makeSymbol
        );
      },
    );
    expect(makeCall).toBeDefined();
    if (!makeCall) {
      return;
    }

    const typeArgsByInstance = typing.callTypeArguments.get(makeCall.id);
    const typeArgs = typeArgsByInstance
      ? Array.from(typeArgsByInstance.values())[0]
      : undefined;
    const i64 = typing.arena.internPrimitive("i64");
    expect(typeArgs).toEqual([i64]);
  });

  it("infers union generics when context includes extra members", () => {
    const ast = parse(
      `
obj Box<T> {}
obj Extra {}

type Out<T> = Box<T> | Box<i32>

fn make<T>() -> Out<T>
  Box<T> {}

fn from_return() -> Box<i64> | Box<i32> | Extra
  make()

pub fn main() -> i32
  let _ = from_return()
  0
`,
      "union_return_context_extra_members.voyd",
    );

    const semantics = semanticsPipeline(ast);
    const { hir, typing } = semantics;
    const symbolTable = getSymbolTable(semantics);
    const root = symbolTable.rootScope;

    const makeSymbol = symbolTable.resolve("make", root);
    expect(typeof makeSymbol).toBe("number");
    if (typeof makeSymbol !== "number") {
      return;
    }

    const makeCall = Array.from(hir.expressions.values()).find(
      (expr): expr is HirCallExpr => {
        if (expr.exprKind !== "call") {
          return false;
        }
        const callee = hir.expressions.get(expr.callee);
        return (
          callee?.exprKind === "identifier" &&
          (callee as HirIdentifierExpr).symbol === makeSymbol
        );
      },
    );
    expect(makeCall).toBeDefined();
    if (!makeCall) {
      return;
    }

    const typeArgsByInstance = typing.callTypeArguments.get(makeCall.id);
    const typeArgs = typeArgsByInstance
      ? Array.from(typeArgsByInstance.values())[0]
      : undefined;
    const i64 = typing.arena.internPrimitive("i64");
    expect(typeArgs).toEqual([i64]);
  });

  it("infers bare union type-parameter members from remainder context", () => {
    const ast = parse(
      `
obj None {}
type Optional<T> = T | None

fn none<T>() -> Optional<T>
  None {}

fn from_return() -> i32 | i64 | None
  none()

pub fn main() -> i32
  let _ = from_return()
  0
`,
      "union_return_context_bare_type_param_remainder.voyd",
    );

    const semantics = semanticsPipeline(ast);
    const { hir, typing } = semantics;
    const symbolTable = getSymbolTable(semantics);
    const root = symbolTable.rootScope;

    const noneSymbol = symbolTable.resolve("none", root);
    expect(typeof noneSymbol).toBe("number");
    if (typeof noneSymbol !== "number") {
      return;
    }

    const noneCall = Array.from(hir.expressions.values()).find(
      (expr): expr is HirCallExpr => {
        if (expr.exprKind !== "call") {
          return false;
        }
        const callee = hir.expressions.get(expr.callee);
        return (
          callee?.exprKind === "identifier" &&
          (callee as HirIdentifierExpr).symbol === noneSymbol
        );
      },
    );
    expect(noneCall).toBeDefined();
    if (!noneCall) {
      return;
    }

    const typeArgsByInstance = typing.callTypeArguments.get(noneCall.id);
    const typeArgs = typeArgsByInstance
      ? Array.from(typeArgsByInstance.values())[0]
      : undefined;
    expect(typeArgs).toBeDefined();
    if (!typeArgs) {
      return;
    }
    const inferred = typing.arena.get(typeArgs[0]!);
    expect(inferred.kind).toBe("union");
    if (inferred.kind !== "union") {
      return;
    }
    const i32 = typing.arena.internPrimitive("i32");
    const i64 = typing.arena.internPrimitive("i64");
    expect(inferred.members).toHaveLength(2);
    expect(inferred.members).toContain(i32);
    expect(inferred.members).toContain(i64);
  });

  it("preserves concrete bindings when bare union members see extra context", () => {
    const ast = parse(
      `
obj Box<T> {}
type Out<T> = T | Box<T>

fn make<T>() -> Out<T>
  Box<T> {}

fn from_return() -> i32 | i64 | Box<i32>
  make()

pub fn main() -> i32
  let _ = from_return()
  0
`,
      "union_return_context_preserve_concrete_binding.voyd",
    );

    const semantics = semanticsPipeline(ast);
    const { hir, typing } = semantics;
    const symbolTable = getSymbolTable(semantics);
    const root = symbolTable.rootScope;

    const makeSymbol = symbolTable.resolve("make", root);
    expect(typeof makeSymbol).toBe("number");
    if (typeof makeSymbol !== "number") {
      return;
    }

    const makeCall = Array.from(hir.expressions.values()).find(
      (expr): expr is HirCallExpr => {
        if (expr.exprKind !== "call") {
          return false;
        }
        const callee = hir.expressions.get(expr.callee);
        return (
          callee?.exprKind === "identifier" &&
          (callee as HirIdentifierExpr).symbol === makeSymbol
        );
      },
    );
    expect(makeCall).toBeDefined();
    if (!makeCall) {
      return;
    }

    const typeArgsByInstance = typing.callTypeArguments.get(makeCall.id);
    const typeArgs = typeArgsByInstance
      ? Array.from(typeArgsByInstance.values())[0]
      : undefined;
    const i32 = typing.arena.internPrimitive("i32");
    expect(typeArgs).toEqual([i32]);
  });

  it("does not infer union-based generics when member bindings conflict", () => {
    const ast = parse(
      `
obj Left<T> {}
obj Right<T> {}
type Either<T> = Left<T> | Right<T>

fn make<T>() -> Either<T>
  Left<T> {}

fn conflicting() -> Left<i32> | Right<i64>
  make()

pub fn main() -> i32
  0
`,
      "union_return_context_conflict.voyd",
    );

    expect(() => semanticsPipeline(ast)).toThrow(/make is missing 1 type argument/);
  });
});
