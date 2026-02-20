import { describe, expect, it } from "vitest";
import { SymbolTable } from "../binder/index.js";

describe("SymbolTable", () => {
  it("resolves bindings across lexical scopes", () => {
    const table = new SymbolTable({ rootOwner: 0 });
    const rootSymbol = table.declare({
      name: "x",
      kind: "value",
      declaredAt: 1,
    });

    const fnScope = table.createScope({
      parent: table.rootScope,
      kind: "function",
      owner: 2,
    });

    table.enterScope(fnScope);
    const innerSymbol = table.declare({
      name: "x",
      kind: "value",
      declaredAt: 3,
    });
    table.exitScope();

    expect(table.resolve("x", fnScope)).toBe(innerSymbol);
    expect(table.resolve("x", table.rootScope)).toBe(rootSymbol);
    expect(table.resolveAll("x", fnScope)).toEqual([innerSymbol, rootSymbol]);
  });

  it("restores to a snapshot", () => {
    const table = new SymbolTable({ rootOwner: 0 });
    table.declare({ name: "root", kind: "module", declaredAt: 1 });
    const snap = table.snapshot();

    table.declare({ name: "temp", kind: "value", declaredAt: 2 });
    table.restore(snap);

    expect(table.resolve("temp", table.rootScope)).toBeUndefined();
    expect(table.resolve("root", table.rootScope)).toBeDefined();
  });

  it("supports kind-aware resolution domains", () => {
    const table = new SymbolTable({ rootOwner: 0 });
    const valueSymbol = table.declare({
      name: "get",
      kind: "value",
      declaredAt: 1,
    });
    const effectOpSymbol = table.declare({
      name: "get",
      kind: "effect-op",
      declaredAt: 2,
    });

    expect(
      table.resolveByKinds("get", table.rootScope, ["effect-op"]),
    ).toBe(effectOpSymbol);
    expect(table.resolveByKinds("get", table.rootScope, ["value"])).toBe(
      valueSymbol,
    );
    expect(
      table.resolveAllByKinds("get", table.rootScope, ["value", "effect-op"]),
    ).toEqual([valueSymbol, effectOpSymbol]);
  });

  it("resolves with custom predicates across lexical scopes", () => {
    const table = new SymbolTable({ rootOwner: 0 });
    table.declare({ name: "x", kind: "effect-op", declaredAt: 1 });
    const fnScope = table.createScope({
      parent: table.rootScope,
      kind: "function",
      owner: 2,
    });
    table.enterScope(fnScope);
    const localValue = table.declare({ name: "x", kind: "value", declaredAt: 3 });
    table.exitScope();

    const resolved = table.resolveWhere("x", fnScope, (record) =>
      record.kind !== "effect-op",
    );
    expect(resolved).toBe(localValue);
  });
});
