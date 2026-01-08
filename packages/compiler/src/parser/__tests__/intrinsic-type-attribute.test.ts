import { test } from "vitest";
import { isForm, parse } from "../index.js";

const parseFirstForm = (text: string) => {
  const ast = parse(text);
  const node = ast.rest[0];
  if (!isForm(node)) {
    throw new Error("expected a declaration form");
  }
  return node;
};

test("@intrinsic_type attaches intrinsicType to objects", (t) => {
  const obj = parseFirstForm(`@intrinsic_type(type: "optional-some")
obj Some<T> {
  value: T
}`);

  t.expect(obj.attributes?.intrinsicType).toBe("optional-some");
});

test("@intrinsic_type attaches intrinsicType to type aliases", (t) => {
  const alias = parseFirstForm(`@intrinsic_type(\"optional\")
type Optional<T> = Some<T> | None`);

  t.expect(alias.attributes?.intrinsicType).toBe("optional");
});

test("@intrinsic_type rejects unknown labels", (t) => {
  t.expect(() =>
    parse(`@intrinsic_type(name: \"optional\")
type Optional<T> = Some<T> | None`)
  ).toThrow(/unknown @intrinsic_type argument/);
});
