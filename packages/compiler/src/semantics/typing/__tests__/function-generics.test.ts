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
