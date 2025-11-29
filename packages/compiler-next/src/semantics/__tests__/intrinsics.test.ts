import { describe, expect, it } from "vitest";
import { parse } from "../../parser/index.js";
import { semanticsPipeline } from "../pipeline.js";
import type { ModuleGraph, ModuleNode } from "../../modules/types.js";
import type { HirFunction } from "../hir/nodes.js";
import { loadAst } from "./load-ast.js";

const UNANNOTATED_SOURCE = `
fn new_fixed_array<T>(size: i32) -> i32 0
fn get<T>(arr: i32, index: i32) -> i32 0
fn set<T>(arr: i32, index: i32, value: i32) -> i32 0
fn copy<T>(dest: i32, opts: { from: i32 }) -> i32 0
fn length<T>(arr: i32) -> i32 0
fn helper() -> i32 0
`;

const FIXED_ARRAY_FILE = "packages/std_next/fixed_array.voyd";

const buildPipelineInput = ({
  ast,
  moduleId,
  filePath,
}: {
  ast: ReturnType<typeof parse>;
  moduleId: string;
  filePath: string;
}): { module: ModuleNode; graph: ModuleGraph } => {
  const module: ModuleNode = {
    id: moduleId,
    path: { namespace: "std", segments: ["fixed_array"] },
    origin: { kind: "file", filePath },
    ast,
    source: "",
    dependencies: [],
  };
  const graph: ModuleGraph = {
    entry: module.id,
    modules: new Map([[module.id, module]]),
    diagnostics: [],
  };
  return { module, graph };
};

describe("intrinsic metadata", () => {
  it("propagates @intrinsic attributes through binding and lowering", () => {
    const ast = loadAst("intrinsic_attributes.voyd");
    const { binding, symbolTable, hir } = semanticsPipeline(ast);
    const rootScope = symbolTable.rootScope;

    const renamed = symbolTable.resolve("renamed", rootScope);
    const defaultIntrinsic = symbolTable.resolve("default_intrinsic", rootScope);
    const helper = symbolTable.resolve("helper", rootScope);

    expect(renamed).toBeDefined();
    expect(defaultIntrinsic).toBeDefined();
    expect(helper).toBeDefined();

    const renamedMetadata = symbolTable.getSymbol(renamed!)
      .metadata as Record<string, unknown>;
    const defaultMetadata = symbolTable.getSymbol(defaultIntrinsic!)
      .metadata as Record<string, unknown>;
    const helperMetadata = symbolTable.getSymbol(helper!)
      .metadata as Record<string, unknown> | undefined;

    expect(renamedMetadata).toMatchObject({
      entity: "function",
      intrinsic: true,
      intrinsicName: "__renamed_intrinsic",
      intrinsicUsesSignature: true,
    });
    expect(defaultMetadata).toMatchObject({
      entity: "function",
      intrinsic: true,
      intrinsicName: "default_intrinsic",
      intrinsicUsesSignature: false,
    });
    expect(helperMetadata?.intrinsic).toBeUndefined();

    const renamedDecl = binding.functions.find(
      (fn) => fn.symbol === renamed
    );
    const defaultDecl = binding.functions.find(
      (fn) => fn.symbol === defaultIntrinsic
    );
    const helperDecl = binding.functions.find((fn) => fn.symbol === helper);

    expect(renamedDecl?.intrinsic).toEqual({
      name: "__renamed_intrinsic",
      usesSignature: true,
    });
    expect(defaultDecl?.intrinsic).toEqual({
      name: "default_intrinsic",
      usesSignature: false,
    });
    expect(helperDecl?.intrinsic).toBeUndefined();

    const renamedHir = Array.from(hir.items.values()).find(
      (item): item is HirFunction =>
        item.kind === "function" && item.symbol === renamed
    );
    const defaultHir = Array.from(hir.items.values()).find(
      (item): item is HirFunction =>
        item.kind === "function" && item.symbol === defaultIntrinsic
    );
    const helperHir = Array.from(hir.items.values()).find(
      (item): item is HirFunction =>
        item.kind === "function" && item.symbol === helper
    );

    expect(renamedHir?.intrinsic).toEqual({
      name: "__renamed_intrinsic",
      usesSignature: true,
    });
    expect(defaultHir?.intrinsic).toEqual({
      name: "default_intrinsic",
      usesSignature: false,
    });
    expect(helperHir?.intrinsic).toBeUndefined();
  });

  it("leaves unannotated modules untouched", () => {
    const ast = parse(UNANNOTATED_SOURCE, FIXED_ARRAY_FILE);
    const { symbolTable } = semanticsPipeline(
      buildPipelineInput({
        ast,
        moduleId: FIXED_ARRAY_FILE,
        filePath: FIXED_ARRAY_FILE,
      })
    );
    const rootScope = symbolTable.rootScope;
    const names = ["new_fixed_array", "get", "set", "copy", "length", "helper"];

    names.forEach((name) => {
      const symbol = symbolTable.resolve(name, rootScope);
      expect(symbol).toBeDefined();
      const metadata = symbolTable.getSymbol(symbol!)
        .metadata as Record<string, unknown> | undefined;
      expect(metadata?.intrinsic).toBeUndefined();
    });
  });
});
