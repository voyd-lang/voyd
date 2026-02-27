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
      "pub use src::util::all",
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
      "/// Builds enum declarations.",
      "/// For example:",
      "/// ```voyd",
      "/// enum Result<T, E>",
      "///   Ok<T> { value: T }",
      "///   Err<E> { error: E }",
      "/// ```",
      "pub macro enum(enum_name, variants_block)",
      "  syntax_template (void)",
      "",
      "/// See [query docs](https://example.com/docs?q=voyd&lang=en).",
      "pub fn linked_docs() -> i32",
      "  0",
      "",
      "pub eff Decode",
      "  /// Reads next input value.",
      "  decode_next(resume, input: i32) -> i32",
      "  finish(tail) -> void",
      "",
      "pub obj Counter { api value: i32, pri hidden: i32 }",
      "",
      "impl Counter",
      "  api fn double(self) -> i32",
      "    self.value * 2",
      "",
      "  fn hide(self) -> i32",
      "    self.hidden",
      "",
      "pub fn main() -> i32",
      "  add_one(41)",
      "",
    ].join("\n"),
    "utf8",
  );
  await fs.writeFile(
    path.join(srcRoot, "util.voyd"),
    [
      "pub fn util_value() -> i32",
      "  7",
      "",
    ].join("\n"),
    "utf8",
  );
  return { root, entryPath };
};

const createPackageRootFixture = async (): Promise<{
  root: string;
  entryPath: string;
}> => {
  const root = await fs.mkdtemp(path.join(tmpdir(), "voyd-doc-generation-pkg-root-"));
  const srcRoot = path.join(root, "src");
  const entryPath = path.join(srcRoot, "pkg.voyd");
  await fs.mkdir(srcRoot, { recursive: true });
  await fs.writeFile(
    entryPath,
    [
      "pub use self::visible::all",
      "",
      "mod hidden",
      "  pub fn internal() -> i32",
      "    0",
      "",
      "pub mod visible",
      "  pub fn shown() -> i32",
      "    1",
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
      expect(html.content).toContain("Re-Exports");
      expect(html.content).toContain("class=\"tok-kw\">use</span>");
      expect(html.content).toContain("class=\"tok-id\">util</span>");
      expect(html.content).toContain("class=\"tok-kw\">macro</span>");
      expect(html.content).toContain("class=\"tok-name\">enum</span>");
      expect(html.content).toContain("Builds enum declarations.");
      expect(html.content).toContain("<pre><code>enum Result&lt;T, E&gt;");
      expect(html.content).not.toContain("<p>```voyd");
      expect(html.content).toContain("class=\"tok-kw\">impl</span>");
      expect(html.content).toContain("class=\"tok-name\">double</span>");
      expect(html.content).toContain(
        "href=\"https://example.com/docs?q=voyd&amp;lang=en\"",
      );
      expect(html.content).not.toContain("href=\"https://example.com/docs?q=voyd&amp;amp;lang=en\"");
      expect(html.content).toContain("Reads next input value.");
      expect(html.content).not.toContain("id=\"function-src-main-double\"");
      const objectIndex = html.content.indexOf("id=\"object-src-main-counter\"");
      const implIndex = html.content.indexOf("id=\"impl-src-main-impl-0\"");
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
          macros: Array<{
            name: string;
            signature: string;
            documentation?: string;
          }>;
          impls: Array<{
            signature: string;
            members: Array<{ name: string; signature: string }>;
          }>;
          objects: Array<{
            name: string;
            members: Array<{ name: string; signature: string }>;
          }>;
          effects: Array<{
            name: string;
            members: Array<{
              name: string;
              signature: string;
              documentation?: string;
            }>;
          }>;
          reexports: Array<{
            signature: string;
          }>;
        }>;
      };
      const mainModule = parsed.modules.find((module) => module.id === "src::main");
      expect(mainModule).toBeDefined();
      const addOne = mainModule?.functions.find((fn) => fn.name === "add_one");
      expect(addOne).toBeDefined();
      const enumMacro = mainModule?.macros.find((macro) => macro.name === "enum");
      expect(enumMacro).toBeDefined();
      expect(enumMacro?.documentation).toContain(" Builds enum declarations.");
      expect(enumMacro?.documentation).toContain(" ```voyd");
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
      const hiddenMethodFn = mainModule?.functions.find((fn) => fn.name === "hide");
      expect(hiddenMethodFn).toBeUndefined();
      expect(mainModule?.reexports.map((item) => item.signature)).toContain(
        "pub use src::util::all",
      );
      const counterImpl = mainModule?.impls.find((impl) =>
        impl.signature.includes("Counter"),
      );
      expect(counterImpl).toBeDefined();
      const doubleMethod = counterImpl?.members.find((member) => member.name === "double");
      expect(doubleMethod).toBeDefined();
      expect(doubleMethod?.signature.startsWith("fn ")).toBe(false);
      const hiddenMethod = counterImpl?.members.find((member) => member.name === "hide");
      expect(hiddenMethod).toBeUndefined();
      const counterObject = mainModule?.objects.find((objectDecl) => objectDecl.name === "Counter");
      expect(counterObject?.members.map((member) => member.name)).toEqual(["value"]);
      const decodeEffect = mainModule?.effects.find((effectDecl) => effectDecl.name === "Decode");
      const decodeNextOp = decodeEffect?.members.find((member) => member.name === "decode_next");
      expect(decodeNextOp?.documentation).toBe(" Reads next input value.");
    } finally {
      await fs.rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("only renders modules exported by pkg.voyd", async () => {
    const fixture = await createPackageRootFixture();

    try {
      const html = await generateDocumentation({
        entryPath: fixture.entryPath,
        format: "html",
      });
      expect(html.content).toContain("id=\"module-src-pkg\"");
      expect(html.content).toContain("id=\"module-src-pkg-visible\"");
      expect(html.content).not.toContain("id=\"module-src-pkg-hidden\"");
    } finally {
      await fs.rm(fixture.root, { recursive: true, force: true });
    }
  });
});
