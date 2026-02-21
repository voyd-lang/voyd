import { describe, expect, it } from "vitest";
import { resolve, sep } from "node:path";
import { createMemoryModuleHost } from "../../../modules/memory-host.js";
import { createNodePathAdapter } from "../../../modules/node-path-adapter.js";
import type { ModuleHost } from "../../../modules/types.js";
import { analyzeModules, loadModuleGraph } from "../../../pipeline.js";
import { SymbolTable } from "../../binder/index.js";
import { DeclTable } from "../../decls.js";
import { getSymbolTable } from "../../_internal/symbol-table.js";
import type { HirGraph } from "../../hir/index.js";
import type { SourceSpan } from "../../ids.js";
import { createTypingContext, createTypingState } from "../context.js";
import { seedBaseObjectType, seedPrimitiveTypes } from "../registry.js";
import { typeSatisfies } from "../type-system.js";
import type { DependencySemantics } from "../types.js";

const DUMMY_SPAN: SourceSpan = { file: "<test>", start: 0, end: 0 };

const createMemoryHost = (files: Record<string, string>): ModuleHost =>
  createMemoryModuleHost({ files, pathAdapter: createNodePathAdapter() });

const toDependencySemantics = ({
  moduleId,
  semantics,
}: {
  moduleId: string;
  semantics: ReturnType<typeof analyzeModules>["semantics"];
}): DependencySemantics => {
  const entry = semantics.get(moduleId);
  if (!entry) {
    throw new Error(`missing semantics for ${moduleId}`);
  }
  return {
    moduleId: entry.moduleId,
    packageId: entry.binding.packageId,
    symbolTable: getSymbolTable(entry),
    hir: entry.hir,
    typing: entry.typing,
    decls: entry.binding.decls,
    overloads: new Map(
      Array.from(entry.binding.overloads.entries()).map(([id, set]) => [
        id,
        set.functions.map((candidate) => candidate.symbol),
      ]),
    ),
    exports: entry.exports,
  };
};

const createBareContext = ({
  dependency,
}: {
  dependency: DependencySemantics;
}) => {
  const symbolTable = new SymbolTable({ rootOwner: 0 });
  const hir: HirGraph = {
    module: {
      kind: "module",
      id: 0,
      path: "<test>",
      scope: symbolTable.rootScope,
      ast: 0,
      span: DUMMY_SPAN,
      items: [],
      exports: [],
    },
    items: new Map(),
    statements: new Map(),
    expressions: new Map(),
  };
  const ctx = createTypingContext({
    symbolTable,
    hir,
    overloads: new Map(),
    decls: new DeclTable(),
    moduleId: "src::main",
    availableSemantics: new Map([[dependency.moduleId, dependency]]),
    arena: dependency.typing.arena,
    effects: dependency.typing.effects,
  });
  seedPrimitiveTypes(ctx);
  seedBaseObjectType(ctx);
  return { ctx, state: createTypingState("strict") };
};

describe("type satisfaction side effects", () => {
  it("does not hydrate imported trait metadata while checking satisfaction", async () => {
    const srcRoot = resolve("/proj/src");
    const stdRoot = resolve("/proj/std");
    const depPath = `${stdRoot}${sep}dep.voyd`;
    const host = createMemoryHost({
      [depPath]: `
pub trait Show
  fn show(self) -> i32

pub obj Box { value: i32 }

impl Show for Box
  api fn show(self) -> i32
    self.value
`,
    });

    const graph = await loadModuleGraph({
      entryPath: depPath,
      roots: { src: srcRoot, std: stdRoot },
      host,
    });
    const analyzed = analyzeModules({ graph });
    expect(analyzed.diagnostics).toHaveLength(0);

    const dependency = toDependencySemantics({
      moduleId: "std::dep",
      semantics: analyzed.semantics,
    });
    const template = dependency.typing.traits.getImplTemplates()[0];
    expect(template).toBeDefined();
    if (!template) {
      return;
    }

    const { ctx, state } = createBareContext({ dependency });
    const beforeImportCount = ctx.importsByLocal.size;
    const beforeAliasBuckets = ctx.importAliasesByModule.size;
    const beforeImplTemplateCount = ctx.traits.getImplTemplates().length;

    expect(typeSatisfies(template.target, template.trait, ctx, state)).toBe(false);
    expect(ctx.importsByLocal.size).toBe(beforeImportCount);
    expect(ctx.importAliasesByModule.size).toBe(beforeAliasBuckets);
    expect(ctx.traits.getImplTemplates().length).toBe(beforeImplTemplateCount);
  });
});
