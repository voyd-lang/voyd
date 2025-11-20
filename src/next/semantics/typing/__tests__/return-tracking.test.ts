import { describe, expect, it } from "vitest";
import { runTypingPipeline } from "../typing.js";
import { createModuleContext } from "./helpers.js";

describe("return tracking", () => {
  it("allows return statements inside typed functions", () => {
    const ctx = createModuleContext();
    const fnSymbol = ctx.symbolTable.declare({
      name: "withReturn",
      kind: "value",
      declaredAt: ctx.nextNode(),
    });
    const valueExpr = ctx.createLiteral("i32", "42");
    const body = ctx.createBlock([ctx.createReturn(valueExpr)], valueExpr);
    ctx.addFunction(fnSymbol, body, {
      typeKind: "named",
      path: ["i32"],
      ast: ctx.nextNode(),
      span: ctx.span,
    });

    const hir = ctx.builder.finalize();
    const typing = runTypingPipeline({
      symbolTable: ctx.symbolTable,
      hir,
      overloads: new Map(),
      decls: ctx.decls,
    });

    const scheme = typing.table.getSymbolScheme(fnSymbol);
    expect(scheme).toBeDefined();
    const instantiated = typing.arena.instantiate(scheme!, []);
    const fnType = typing.arena.get(instantiated);
    expect(fnType).toMatchObject({ kind: "function" });
    if (fnType.kind !== "function") {
      throw new Error("expected function type");
    }
    const returnTypeDesc = typing.arena.get(fnType.returnType);
    expect(returnTypeDesc).toMatchObject({ kind: "primitive", name: "i32" });
  });

  it("permits empty return statements in void functions", () => {
    const ctx = createModuleContext();
    const fnSymbol = ctx.symbolTable.declare({
      name: "voidReturn",
      kind: "value",
      declaredAt: ctx.nextNode(),
    });
    const body = ctx.createBlock([ctx.createReturn()]);
    ctx.addFunction(fnSymbol, body, {
      typeKind: "named",
      path: ["void"],
      ast: ctx.nextNode(),
      span: ctx.span,
    });

    const hir = ctx.builder.finalize();
    const typing = runTypingPipeline({
      symbolTable: ctx.symbolTable,
      hir,
      overloads: new Map(),
      decls: ctx.decls,
    });

    const scheme = typing.table.getSymbolScheme(fnSymbol);
    expect(scheme).toBeDefined();
    const instantiated = typing.arena.instantiate(scheme!, []);
    const fnType = typing.arena.get(instantiated);
    expect(fnType).toMatchObject({ kind: "function" });
    if (fnType.kind !== "function") {
      throw new Error("expected function type");
    }
    const returnTypeDesc = typing.arena.get(fnType.returnType);
    expect(returnTypeDesc).toMatchObject({ kind: "primitive", name: "voyd" });
  });

  it("rejects missing return values for non-void functions", () => {
    const ctx = createModuleContext();
    const fnSymbol = ctx.symbolTable.declare({
      name: "missingReturn",
      kind: "value",
      declaredAt: ctx.nextNode(),
    });
    const trailingExpr = ctx.createLiteral("i32", "1");
    const body = ctx.createBlock([ctx.createReturn()], trailingExpr);
    ctx.addFunction(fnSymbol, body, {
      typeKind: "named",
      path: ["i32"],
      ast: ctx.nextNode(),
      span: ctx.span,
    });

    const hir = ctx.builder.finalize();
    expect(() =>
      runTypingPipeline({
        symbolTable: ctx.symbolTable,
        hir,
        overloads: new Map(),
        decls: ctx.decls,
      })
    ).toThrow(/return statement/);
  });
});
