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
      "pub fn take_labeled({ n: i32 }) -> i32",
      "  n",
      "",
      "pub fn fold_like<O>(count: i32, { hi: O }, { there: (acc: O, value: i32) -> O }) -> O",
      "  there(hi, count)",
      "",
      "pub obj Counter { value: i32 }",
      "",
      "impl Counter",
      "  fn double(self) -> i32",
      "    self.value * 2",
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
      expect(html.content).toContain("class=\"tok-kw\">fn</span>");
      expect(html.content).toContain("class=\"tok-name\">take_labeled</span>");
      expect(html.content).toContain("class=\"tok-type\">Counter</span>");
      expect(html.content).toContain("impl Counter");
      expect(html.content).toContain("double(self: Counter) -&gt; i32");
      expect(html.content).not.toContain("id=\"function-src-main-double\"");
      const objectIndex = html.content.indexOf("obj Counter");
      const implIndex = html.content.indexOf("impl Counter");
      expect(objectIndex).toBeGreaterThan(-1);
      expect(implIndex).toBeGreaterThan(objectIndex);

      const json = await generateDocumentation({
        entryPath: fixture.entryPath,
        format: "json",
      });
      const parsed = JSON.parse(json.content) as {
        modules: Array<{
          id: string;
          functions: Array<{
            name: string;
            signature: string;
            parameterDocs: Array<{ name: string; documentation: string }>;
          }>;
          impls: Array<{
            signature: string;
            members: Array<{ name: string; signature: string }>;
          }>;
        }>;
      };
      const mainModule = parsed.modules.find((module) => module.id === "src::main");
      expect(mainModule).toBeDefined();
      const addOne = mainModule?.functions.find((fn) => fn.name === "add_one");
      expect(addOne).toBeDefined();
      const valueDoc = addOne?.parameterDocs.find((param) => param.name === "value");
      expect(valueDoc?.documentation).toBe(" Input value.\n Keep newline.");
      const labeledFn = mainModule?.functions.find((fn) => fn.name === "take_labeled");
      expect(labeledFn?.signature).toContain("{ n: i32 }");
      const foldLike = mainModule?.functions.find((fn) => fn.name === "fold_like");
      expect(foldLike).toBeDefined();
      expect(foldLike?.signature).toContain("\n");
      expect(foldLike?.signature).toContain("  {");
      expect(foldLike?.signature).toContain("hi: O");
      expect(foldLike?.signature).toContain("there: (acc: O, value: i32) -> O");
      expect(foldLike?.signature).not.toContain("}, {");
      const duplicateMethodFn = mainModule?.functions.find((fn) => fn.name === "double");
      expect(duplicateMethodFn).toBeUndefined();
      const counterImpl = mainModule?.impls.find((impl) =>
        impl.signature.includes("Counter"),
      );
      expect(counterImpl).toBeDefined();
      const doubleMethod = counterImpl?.members.find((member) => member.name === "double");
      expect(doubleMethod).toBeDefined();
      expect(doubleMethod?.signature.startsWith("fn ")).toBe(false);
    } finally {
      await fs.rm(fixture.root, { recursive: true, force: true });
    }
  });
});
