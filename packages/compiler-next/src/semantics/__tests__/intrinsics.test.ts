import { describe, expect, it } from "vitest";
import { parse } from "../../parser/index.js";
import { semanticsPipeline } from "../pipeline.js";
import type { ModuleGraph, ModuleNode } from "../../modules/types.js";

const SOURCE = `
fn new_fixed_array<T>(size: i32) -> i32 0
fn get<T>(arr: i32, index: i32) -> i32 0
fn set<T>(arr: i32, index: i32, value: i32) -> i32 0
fn copy<T>(dest: i32, opts: { from: i32 }) -> i32 0
fn length<T>(arr: i32) -> i32 0
fn helper() -> i32 0
`;

const FIXED_ARRAY_FILE = "packages/std_next/fixed_array.voyd";

const getMetadata = ({
  name,
  modulePath,
  moduleId,
}: {
  name: string;
  modulePath: string;
  moduleId?: string;
}): Record<string, unknown> | undefined => {
  const ast = parse(SOURCE, modulePath);
  const result = moduleId
    ? semanticsPipeline(
        buildPipelineInput({
          ast,
          moduleId,
          filePath: modulePath,
        })
      )
    : semanticsPipeline(ast);
  const { symbolTable } = result;
  return symbolTable
    .snapshot()
    .symbols.find(
      (entry) => entry?.name === name && entry.kind === "value"
    )?.metadata as Record<string, unknown> | undefined;
};

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

describe("intrinsic tagging", () => {
  it("tags std_next fixed_array wrappers with intrinsic metadata", () => {
    const expectedMetadata: Record<string, Record<string, unknown>> = {
      new_fixed_array: {
        intrinsic: true,
        intrinsicName: "__array_new",
        intrinsicUsesSignature: false,
      },
      get: {
        intrinsic: true,
        intrinsicName: "__array_get",
        intrinsicUsesSignature: true,
      },
      set: {
        intrinsic: true,
        intrinsicName: "__array_set",
        intrinsicUsesSignature: true,
      },
      copy: {
        intrinsic: true,
        intrinsicName: "__array_copy",
        intrinsicUsesSignature: true,
      },
      length: {
        intrinsic: true,
        intrinsicName: "__array_len",
        intrinsicUsesSignature: false,
      },
    };

    const moduleIds = [FIXED_ARRAY_FILE, "std::fixed_array"];

    moduleIds.forEach((moduleId) => {
      Object.entries(expectedMetadata).forEach(([name, metadata]) => {
        const metadataForId =
          moduleId === FIXED_ARRAY_FILE
            ? getMetadata({ name, modulePath: moduleId })
            : getMetadata({
                name,
                modulePath: FIXED_ARRAY_FILE,
                moduleId,
              });
        expect(metadataForId).toMatchObject(metadata);
      });
    });
  });

  it("leaves other modules untouched", () => {
    expect(
      getMetadata({ name: "new_fixed_array", modulePath: "packages/std/fixed_array.voyd" })
    ).not.toMatchObject({ intrinsic: true });
    expect(
      getMetadata({ name: "helper", modulePath: "packages/std_next/fixed_array.voyd" })
    ).not.toMatchObject({ intrinsic: true });
  });
});
