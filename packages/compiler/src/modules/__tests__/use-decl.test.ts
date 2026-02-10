import { describe, expect, it } from "vitest";
import { isForm, parse } from "../../parser/index.js";
import { classifyTopLevelDecl } from "../use-decl.js";

const classifyFirst = (source: string) => {
  const ast = parse(source, "use-decl-test.voyd");
  const first = ast.rest[0];
  if (!isForm(first)) {
    throw new Error("expected first top-level entry to be a form");
  }
  return classifyTopLevelDecl(first);
};

describe("classifyTopLevelDecl", () => {
  it("classifies use declarations", () => {
    expect(classifyFirst("use src::util::all")).toMatchObject({
      kind: "use-decl",
      visibility: "module",
    });
  });

  it("classifies pub use declarations", () => {
    expect(classifyFirst("pub use self::util::all")).toMatchObject({
      kind: "use-decl",
      visibility: "pub",
    });
  });

  it("classifies bare pub module-expression exports", () => {
    expect(classifyFirst("pub self::util::all")).toMatchObject({
      kind: "use-decl",
      visibility: "pub",
    });
  });

  it("classifies inline module declarations", () => {
    expect(classifyFirst("mod util\n  fn one() -> i32\n    1")).toMatchObject({
      kind: "inline-module-decl",
      name: "util",
      visibility: "module",
    });
  });

  it("classifies unsupported mod declarations without bodies", () => {
    expect(classifyFirst("pub mod util")).toMatchObject({
      kind: "unsupported-mod-decl",
      visibility: "pub",
    });
  });

  it("classifies macro declarations", () => {
    expect(
      classifyFirst("pub macro inc(value)\n  syntax_template (+ $value 1.0)"),
    ).toMatchObject({
      kind: "macro-decl",
    });
  });

  it("returns other for non-use declarations", () => {
    expect(classifyFirst("pub fn main() -> i32\n  1")).toMatchObject({
      kind: "other",
    });
  });
});
