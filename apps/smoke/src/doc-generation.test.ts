import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { generateDocumentation } from "@voyd/sdk/doc-generation";

const createFixture = async (): Promise<{ root: string; entryPath: string }> => {
  const root = await fs.mkdtemp(path.join(tmpdir(), "voyd-doc-generation-smoke-"));
  const srcRoot = path.join(root, "src");
  const entryPath = path.join(srcRoot, "main.voyd");
  await fs.mkdir(srcRoot, { recursive: true });
  await fs.writeFile(
    entryPath,
    [
      "//! Package docs.",
      "",
      "/// Adds one.",
      "pub fn add_one(",
      "  /// Input value.",
      "  /// Keep newline.",
      "  value: i32",
      ") -> i32",
      "  value + 1",
      "",
      "pub fn main() -> i32",
      "  add_one(41)",
      "",
    ].join("\n"),
    "utf8",
  );
  return { root, entryPath };
};

describe("smoke: sdk doc-generation", () => {
  it("generates HTML and JSON documentation outputs", async () => {
    const fixture = await createFixture();

    try {
      const html = await generateDocumentation({
        entryPath: fixture.entryPath,
        format: "html",
      });
      expect(html.content).toContain("<!doctype html>");
      expect(html.content).toContain("Docs Index");
      expect(html.content).toContain("Input value.<br />");
      expect(html.content).toContain("Keep newline.</p>");

      const json = await generateDocumentation({
        entryPath: fixture.entryPath,
        format: "json",
      });
      const parsed = JSON.parse(json.content) as {
        modules: Array<{
          id: string;
          functions: Array<{
            name: string;
            parameterDocs: Array<{ name: string; documentation: string }>;
          }>;
        }>;
      };
      const mainModule = parsed.modules.find((module) => module.id === "src::main");
      expect(mainModule).toBeDefined();
      const addOne = mainModule?.functions.find((fn) => fn.name === "add_one");
      expect(addOne).toBeDefined();
      const valueDoc = addOne?.parameterDocs.find((param) => param.name === "value");
      expect(valueDoc?.documentation).toBe(" Input value.\n Keep newline.");
    } finally {
      await fs.rm(fixture.root, { recursive: true, force: true });
    }
  });
});
