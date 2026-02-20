import { describe, expect, it } from "vitest";
import { SymbolTable } from "../../binder/index.js";
import { createTypingContext } from "../context.js";
import { importTargetFor, mapLocalSymbolToDependency } from "../import-resolution.js";
import {
  canonicalSymbolRefForTypingContext,
  localSymbolForSymbolRef,
} from "../symbol-ref-utils.js";
import type { HirGraph } from "../../hir/index.js";
import type { SourceSpan } from "../../ids.js";
import type { DependencySemantics } from "../types.js";

const DUMMY_SPAN: SourceSpan = { file: "<test>", start: 0, end: 0 };

const createEmptyHir = (scope: number): HirGraph => ({
  module: {
    kind: "module",
    id: 0,
    path: "<test>",
    scope,
    ast: 0,
    span: DUMMY_SPAN,
    items: [],
    exports: [],
  },
  items: new Map(),
  statements: new Map(),
  expressions: new Map(),
});

describe("transitive import canonicalization", () => {
  it("normalizes import targets across re-export hops", () => {
    const depBSymbolTable = new SymbolTable({ rootOwner: 0 });
    const depBSymbol = depBSymbolTable.declare({
      name: "Some",
      kind: "type",
      declaredAt: 0,
    });

    const depASymbolTable = new SymbolTable({ rootOwner: 0 });
    const depASymbol = depASymbolTable.declare({
      name: "Some",
      kind: "type",
      declaredAt: 0,
      metadata: {
        import: { moduleId: "dep::b", symbol: depBSymbol },
      },
    });

    const localSymbolTable = new SymbolTable({ rootOwner: 0 });
    const localSymbol = localSymbolTable.declare({
      name: "Some",
      kind: "type",
      declaredAt: 0,
      metadata: {
        import: { moduleId: "dep::a", symbol: depASymbol },
      },
    });

    const dependencyA = {
      moduleId: "dep::a",
      symbolTable: depASymbolTable,
    } as unknown as DependencySemantics;
    const dependencyB = {
      moduleId: "dep::b",
      symbolTable: depBSymbolTable,
    } as unknown as DependencySemantics;

    const ctx = createTypingContext({
      symbolTable: localSymbolTable,
      hir: createEmptyHir(localSymbolTable.rootScope),
      overloads: new Map(),
      moduleId: "src::main",
      imports: [
        {
          local: localSymbol,
          target: { moduleId: "dep::a", symbol: depASymbol },
        },
      ],
      availableSemantics: new Map([
        ["dep::a", dependencyA],
        ["dep::b", dependencyB],
      ]),
    });

    expect(canonicalSymbolRefForTypingContext(localSymbol, ctx)).toEqual({
      moduleId: "dep::b",
      symbol: depBSymbol,
    });
    expect(importTargetFor(localSymbol, ctx)).toEqual({
      moduleId: "dep::b",
      symbol: depBSymbol,
    });
    expect(
      localSymbolForSymbolRef({ moduleId: "dep::b", symbol: depBSymbol }, ctx),
    ).toBe(localSymbol);
    expect(
      mapLocalSymbolToDependency({
        owner: localSymbol,
        dependency: dependencyB,
        ctx,
      }),
    ).toBe(depBSymbol);
  });
});
