import { describe, expect, it } from "vitest";
import { decodeBoundaryArgs } from "../boundary-values.js";

describe("boundary DTO decoding", () => {
  it("restores adapter-facing tags for unions and standalone variants", () => {
    const [union, variant] = decodeBoundaryArgs({
      exportName: "external variants",
      schemas: [
        {
          kind: "union",
          variants: [
            { name: "None", fields: [] },
            { name: "Some", fields: [{ name: "value", schema: { kind: "i32" } }] },
          ],
        },
        {
          kind: "record",
          tag: "Some",
          fields: [{ name: "value", schema: { kind: "i32" } }],
        },
      ],
      args: [{ $variant: "Some", value: 3 }, { value: 4 }],
    });

    expect(union).toEqual({ tag: "Some", value: 3 });
    expect(variant).toEqual({ tag: "Some", value: 4 });
  });
});
