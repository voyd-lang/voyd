import { describe, expect, it } from "vitest";
import type { DocumentationProgramView } from "@voyd/compiler/docs/documentation-view.js";
import { createDocumentationModel } from "./model.js";

const createBaseModule = (): DocumentationProgramView["modules"][number] => ({
  id: "src::main",
  depth: 0,
  packageId: "src",
  macros: [],
  moduleLets: [],
  functions: [],
  typeAliases: [],
  objects: [],
  traits: [],
  effects: [],
  impls: [],
  reexports: [],
});

const createImplMethod = (): DocumentationProgramView["modules"][number]["impls"][number]["methods"][number] => ({
  id: 1,
  name: "method",
  visibility: { level: "public" },
  params: [],
});

describe("createDocumentationModel", () => {
  it("includes public module lets", () => {
    const module = createBaseModule();
    module.moduleLets = [
      {
        name: "answer",
        visibility: { level: "public" },
        documentation: " Exported answer.",
      },
      {
        name: "hidden",
        visibility: { level: "module" },
      },
    ];

    const model = createDocumentationModel({
      program: {
        entryModule: "src::main",
        modules: [module],
      },
    });

    expect(model.modules[0]?.moduleLets).toHaveLength(1);
    expect(model.modules[0]?.moduleLets[0]?.name).toBe("answer");
    expect(model.modules[0]?.moduleLets[0]?.documentation).toBe(
      " Exported answer.",
    );
    expect(model.modules[0]?.moduleLets[0]?.signature).toBe("let answer");
  });

  it("keeps visible impls for external target types", () => {
    const module = createBaseModule();
    module.impls = [
      {
        id: 1,
        visibility: { level: "public" },
        target: "ExternalType",
        methods: [createImplMethod()],
      },
    ];

    const model = createDocumentationModel({
      program: {
        entryModule: "src::main",
        modules: [module],
      },
    });

    expect(model.modules[0]?.impls).toHaveLength(1);
    expect(model.modules[0]?.impls[0]?.signature).toContain("ExternalType");
  });

  it("hides impls for private local target types", () => {
    const module = createBaseModule();
    module.objects = [
      {
        name: "Hidden",
        visibility: { level: "module" },
        fields: [],
      },
    ];
    module.impls = [
      {
        id: 1,
        visibility: { level: "public" },
        target: "Hidden",
        methods: [createImplMethod()],
      },
    ];

    const model = createDocumentationModel({
      program: {
        entryModule: "src::main",
        modules: [module],
      },
    });

    expect(model.modules[0]?.impls).toHaveLength(0);
  });
});
