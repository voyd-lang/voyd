import { describe, expect, it } from "vitest";
import { isForm, parse } from "../../parser/index.js";
import { toSourceSpan } from "../../semantics/utils.js";
import { parseUsePaths } from "../use-path.js";

const parseEntries = (source: string) => {
  const ast = parse(source, "use-path-test.voyd");
  const useForm = ast.rest.find((entry) => isForm(entry) && entry.calls("use"));
  if (!useForm || !isForm(useForm)) {
    throw new Error("expected a use statement");
  }
  return parseUsePaths(useForm.at(1), toSourceSpan(useForm));
};

describe("parseUsePaths selection intent", () => {
  it("treats direct std module imports as module selections", () => {
    const [entry] = parseEntries("use std::msgpack");
    expect(entry?.selectionKind).toBe("module");
    expect(entry?.importKind).toBe("self");
    expect(entry?.path).toEqual(["std", "msgpack"]);
  });

  it("treats grouped std selectors as named selections", () => {
    const [entry] = parseEntries("use std::{ id }");
    expect(entry?.selectionKind).toBe("name");
    expect(entry?.importKind).toBe("name");
    expect(entry?.moduleSegments).toEqual(["std"]);
    expect(entry?.targetName).toBe("id");
  });

  it("keeps grouped self selectors as module selections", () => {
    const [entry] = parseEntries("use std::{ self }");
    expect(entry?.selectionKind).toBe("module");
    expect(entry?.importKind).toBe("self");
    expect(entry?.path).toEqual(["std"]);
  });

  it("treats all selectors as all selections", () => {
    const [entry] = parseEntries("use std::all");
    expect(entry?.selectionKind).toBe("all");
    expect(entry?.importKind).toBe("all");
    expect(entry?.path).toEqual(["std"]);
  });
});
