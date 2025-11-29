import { describe, expect, it } from "vitest";
import { parse } from "../../parser/index.js";
import { semanticsPipeline } from "../pipeline.js";

const SOURCE = `
fn new_fixed_array<T>(size: i32) -> i32 0
fn get<T>(arr: i32, index: i32) -> i32 0
fn set<T>(arr: i32, index: i32, value: i32) -> i32 0
fn copy<T>(dest: i32, opts: { from: i32 }) -> i32 0
fn length<T>(arr: i32) -> i32 0
fn helper() -> i32 0
`;

const getMetadata = ({
  name,
  modulePath,
}: {
  name: string;
  modulePath: string;
}): Record<string, unknown> | undefined => {
  const { symbolTable } = semanticsPipeline(parse(SOURCE, modulePath));
  return symbolTable
    .snapshot()
    .symbols.find(
      (entry) => entry?.name === name && entry.kind === "value"
    )?.metadata as Record<string, unknown> | undefined;
};

describe("intrinsic tagging", () => {
  it("tags std_next fixed_array wrappers with intrinsic metadata", () => {
    const modulePath = "packages/std_next/fixed_array.voyd";
    const expectedMetadata: Record<string, Record<string, unknown>> = {
      new_fixed_array: {
        intrinsic: true,
        intrinsicName: "__array_new",
        intrinsicUsesSignature: false,
      },
      get: {
        intrinsic: true,
        intrinsicName: "__array_get",
        intrinsicUsesSignature: true,
      },
      set: {
        intrinsic: true,
        intrinsicName: "__array_set",
        intrinsicUsesSignature: true,
      },
      copy: {
        intrinsic: true,
        intrinsicName: "__array_copy",
        intrinsicUsesSignature: true,
      },
      length: {
        intrinsic: true,
        intrinsicName: "__array_len",
        intrinsicUsesSignature: false,
      },
    };

    Object.entries(expectedMetadata).forEach(([name, metadata]) => {
      expect(getMetadata({ name, modulePath })).toMatchObject(metadata);
    });
  });

  it("leaves other modules untouched", () => {
    expect(
      getMetadata({ name: "new_fixed_array", modulePath: "packages/std/fixed_array.voyd" })
    ).not.toMatchObject({ intrinsic: true });
    expect(
      getMetadata({ name: "helper", modulePath: "packages/std_next/fixed_array.voyd" })
    ).not.toMatchObject({ intrinsic: true });
  });
});
