import { describe, test, expect } from "vitest";
import { ObjectType, Fn, Identifier, Parameter, List, Block, i32 } from "../../../syntax-objects/index.js";
import { Implementation } from "../../../syntax-objects/implementation.js";
import { resolveImplSignatures } from "../resolve-impl.js";

describe("resolveImplSignatures (lazy impl specialization)", () => {
  test("pre-registers methods and resolves only signatures, not bodies", () => {
    const obj = new ObjectType({ name: Identifier.from("Obj"), value: [] });

    const method = new Fn({
      name: Identifier.from("init"),
      parameters: [
        new Parameter({ name: Identifier.from("arg"), typeExpr: i32 }),
      ],
      body: new List({ value: [] }),
    });

    const impl = new Implementation({
      typeParams: [],
      targetTypeExpr: Identifier.from("Obj"),
      body: new Block({ body: [method] }),
    });

    resolveImplSignatures(impl, obj);

    const found = impl.methods.find((m: Fn) => m.name.value === "init");
    expect(found).toBeDefined();
    expect(found!.parameters[0]!.type).toBeDefined();
    expect(impl.typesResolved).not.toBe(true);
  });
});
