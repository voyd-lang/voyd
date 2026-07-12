import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  generateAdapterRegistry,
  generatePackageAdapter,
} from "../generate-adapter.js";

const temporaryDirectories: string[] = [];
const repoRoot = path.resolve(import.meta.dirname, "../../../..");

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((dir) =>
      rm(dir, { recursive: true, force: true }),
    ),
  );
});

describe("adapter generation", () => {
  it("generates a typed package helper and WIT", async () => {
    const outDir = await temporaryDirectory();
    await generatePackageAdapter({
      index: path.join(repoRoot, "packages/markdown/src"),
      outDir,
    });

    const helper = await readFile(path.join(outDir, "voyd-adapter.ts"), "utf8");
    const wit = await readFile(path.join(outDir, "interface.wit"), "utf8");
    expect(helper).not.toContain("typeId");
    expect(helper).toContain('readonly "render_static": (this: VoydPackageAdapterInvocationContext, arg0: string) => {');
    expect(wit).toContain("package voyd:markdown@1.0.0;");
    expect(wit).toMatch(/record type-[0-9a-f]{16}/);
    expect(wit).toMatch(/render-static: func\(arg0: string\) -> type-[0-9a-f]{16}/);
  });

  it("generates static imports for reachable application adapters", async () => {
    const outDir = await temporaryDirectory();
    const outPath = path.join(outDir, "adapters.ts");
    await generateAdapterRegistry({
      index: path.join(repoRoot, "examples/markdown.voyd"),
      outPath,
    });

    await expect(readFile(outPath, "utf8")).resolves.toContain(
      'import adapter0 from "@voyd-lang/markdown/adapter"',
    );
  });

  it("generates Promise-aware bindings for external effects", async () => {
    const sourceDir = await temporaryDirectory();
    const outDir = path.join(sourceDir, "generated");
    await writeFile(path.join(sourceDir, "remote.voyd"), `@external(id: "example:remote/data@1")
pub eff Remote
  load(tail, id: i32) -> i32
`, "utf8");

    await generatePackageAdapter({ index: sourceDir, outDir });

    const helper = await readFile(path.join(outDir, "voyd-adapter.ts"), "utf8");
    const contract = await readFile(path.join(outDir, "contract.json"), "utf8");
    expect(helper).toContain("Promise<number> | number");
    expect(contract).toContain('"kind": "async"');
    expect(contract).not.toContain('"effect"');
  });

  it("emits structural contracts without compiler-local schema IDs", async () => {
    const sourceDir = await temporaryDirectory();
    const outDir = path.join(sourceDir, "generated");
    await writeFile(path.join(sourceDir, "left.voyd"), `
pub type Left = { value: i32 }

@external(id: "example:shapes/values@1")
pub fn left() -> Left
  left()
`, "utf8");
    await writeFile(path.join(sourceDir, "right.voyd"), `use std::string::type::String
pub type Right = { label: String }

@external(id: "example:shapes/values@1")
pub fn right() -> Right
  right()
`, "utf8");

    await generatePackageAdapter({ index: sourceDir, outDir });
    const contract = JSON.parse(
      await readFile(path.join(outDir, "contract.json"), "utf8"),
    ) as { functions: Array<{ result: { fields?: unknown[] } }> };
    expect(contract.functions.map((fn) => fn.result.fields)).toEqual([
      [expect.objectContaining({ name: "value" })],
      [expect.objectContaining({ name: "label" })],
    ]);
    expect(JSON.stringify(contract)).not.toContain("typeId");
  });

  it("rejects recursive DTOs that cannot become Component Model values", async () => {
    const sourceDir = await temporaryDirectory();
    const outDir = path.join(sourceDir, "generated");
    await writeFile(path.join(sourceDir, "tree.voyd"), `pub obj Node {
  api value: i32,
  api next?: Node
}

@external(id: "example:tree/model@1")
pub fn root() -> Node
  root()
`, "utf8");

    await expect(generatePackageAdapter({ index: sourceDir, outDir }))
      .rejects.toMatchObject({
        diagnostics: [expect.objectContaining({
          message: expect.stringMatching(/recursive.*Component Model/),
        })],
      });
  });

  it("preserves variant discriminators and payload field names", async () => {
    const sourceDir = await temporaryDirectory();
    const outDir = path.join(sourceDir, "generated");
    await writeFile(path.join(sourceDir, "variants.voyd"), `use std::optional::all

@external(id: "example:variants/options@1")
pub fn read(value: Option<i32>) -> Option<i32>
  read(value)

@external(id: "example:variants/options@1")
pub fn read_some(value: Some<i32>) -> Some<i32>
  read_some(value)
`, "utf8");

    await generatePackageAdapter({ index: sourceDir, outDir });
    const helper = await readFile(path.join(outDir, "voyd-adapter.ts"), "utf8");
    const wit = await readFile(path.join(outDir, "interface.wit"), "utf8");
    expect(helper).toContain('tag: "Some"');
    expect(wit).toMatch(/record type-[0-9a-f]{16}-some-payload \{\n\s+value: s32,/);
    expect(wit).toMatch(/record type-[0-9a-f]{16} \{\n\s+tag: string,/);
  });

  it("rejects variant payload fields named tag", async () => {
    const sourceDir = await temporaryDirectory();
    const outDir = path.join(sourceDir, "generated");
    await writeFile(path.join(sourceDir, "tag-collision.voyd"), `use std::enums::{ enum }
use std::string::type::String

enum TaggedResult
  Tagged { tag: String }
  Other {}

@external(id: "example:variants/tagged@1")
pub fn read(value: TaggedResult) -> TaggedResult
  read(value)
`, "utf8");

    await expect(generatePackageAdapter({ index: sourceDir, outDir }))
      .rejects.toMatchObject({
        diagnostics: [expect.objectContaining({
          message: expect.stringMatching(/payload fields named "tag".*discriminator/i),
        })],
      });
  });

  it("escapes WIT reserved field identifiers", async () => {
    const sourceDir = await temporaryDirectory();
    const outDir = path.join(sourceDir, "generated");
    await writeFile(path.join(sourceDir, "keywords.voyd"), `pub type Keyword = { type: i32 }

@external(id: "example:keywords/fields@1")
pub fn read(value: Keyword) -> i32
  read(value)
`, "utf8");

    await generatePackageAdapter({ index: sourceDir, outDir });
    const wit = await readFile(path.join(outDir, "interface.wit"), "utf8");
    expect(wit).toContain("%type: s32");
  });

  it("uses unescaped keyword fragments in generated WIT payload names", async () => {
    const sourceDir = await temporaryDirectory();
    const outDir = path.join(sourceDir, "generated");
    await writeFile(path.join(sourceDir, "keyword-variant.voyd"), `use std::enums::{ enum }

enum KeywordVariant
  Type { value: i32 }
  Other {}

@external(id: "example:keywords/variants@1")
pub fn read(value: KeywordVariant) -> KeywordVariant
  read(value)
`, "utf8");

    await generatePackageAdapter({ index: sourceDir, outDir });
    const wit = await readFile(path.join(outDir, "interface.wit"), "utf8");
    expect(wit).toMatch(/record type-[0-9a-f]{16}-type-payload/);
    expect(wit).not.toContain("-%type-payload");
  });

  it("rejects distinct API names that normalize to the same WIT name", async () => {
    const sourceDir = await temporaryDirectory();
    const outDir = path.join(sourceDir, "generated");
    await writeFile(path.join(sourceDir, "collisions.voyd"), `@external(id: "example:names/functions@1")
pub fn Read() -> i32
  Read()

@external(id: "example:names/functions@1")
pub fn read() -> i32
  read()
`, "utf8");

    await expect(generatePackageAdapter({ index: sourceDir, outDir }))
      .rejects.toThrow(/WIT name collision.*Read.*read/);
  });
});

const temporaryDirectory = async (): Promise<string> => {
  const dir = await mkdtemp(path.join(repoRoot, ".tmp-adapter-generation-"));
  temporaryDirectories.push(dir);
  return dir;
};
