import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { createSdk, type CompileResult } from "@voyd/sdk";

const fixtureEntryPath = path.join(import.meta.dirname, "..", "fixtures", "value-types.voyd");

const expectCompileSuccess = (
  result: CompileResult
): Extract<CompileResult, { success: true }> => {
  if (!result.success) {
    throw new Error(result.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
  }
  expect(result.success).toBe(true);
  return result;
};

describe("smoke: value types", () => {
  let compiled: Extract<CompileResult, { success: true }>;

  beforeAll(async () => {
    const sdk = createSdk();
    compiled = expectCompileSuccess(await sdk.compile({ entryPath: fixtureEntryPath }));
  });

  it("copies values on assignment", async () => {
    const output = await compiled.run<number>({ entryName: "value_copy_semantics" });
    expect(output).toBe(1);
  });

  it("supports static trait-constrained calls with values", async () => {
    const output = await compiled.run<number>({ entryName: "value_static_trait_dispatch" });
    expect(output).toBe(7);
  });

  it("matches unions of values", async () => {
    const output = await compiled.run<number>({ entryName: "value_match" });
    expect(output).toBe(7);
  });

  it("stores values inside objects and reads them back", async () => {
    const output = await compiled.run<number>({ entryName: "value_inside_object" });
    expect(output).toBe(8);
  });

  it("does not re-evaluate inline optional bindings", async () => {
    const output = await compiled.run<number>({ entryName: "optional_binding_evaluates_once" });
    expect(output).toBe(1);
  });

  it("stores values inside arrays", async () => {
    const output = await compiled.run<number>({ entryName: "value_array_storage" });
    expect(output).toBe(9);
  });

  it("copies value elements when arrays grow", async () => {
    const output = await compiled.run<number>({ entryName: "value_array_resize_copy" });
    expect(output).toBe(7);
  });

  it("stores single-field value elements inline in arrays", async () => {
    const output = await compiled.run<number>({
      entryName: "value_single_lane_array_storage",
    });
    expect(output).toBe(7);
  });

  it("supports optional fields on value types", async () => {
    const output = await compiled.run<number>({
      entryName: "value_optional_field",
    });
    expect(output).toBe(5);
  });

  it("reads Some payloads back from optional value fields", async () => {
    const output = await compiled.run<number>({
      entryName: "value_optional_field_some_match",
    });
    expect(output).toBe(5);
  });

  it("reads None values back from optional value fields", async () => {
    const output = await compiled.run<number>({
      entryName: "value_optional_field_none_match",
    });
    expect(output).toBe(0);
  });

  it("allows value types to contain heap object references", async () => {
    const output = await compiled.run<number>({
      entryName: "value_contains_heap_reference",
    });
    expect(output).toBe(9);
  });

  it("spills value ABI lowering once a value exceeds four lanes", async () => {
    const output = await compiled.run<number>({
      entryName: "value_five_lane_round_trip",
    });
    expect(output).toBe(15);
  });

  it("passes wide mutable params by addressable storage", async () => {
    const output = await compiled.run<number>({
      entryName: "value_five_lane_mutable_param",
    });
    expect(output).toBe(11);
  });

  it("preserves immutable aliases when a wide copy is later materialized for mutation", async () => {
    const output = await compiled.run<number>({
      entryName: "value_five_lane_alias_then_mutate_copy",
    });
    expect(output).toBe(10);
  });

  it("reads wide array fields through read-only access paths", async () => {
    const output = await compiled.run<number>({
      entryName: "value_wide_array_field_access",
    });
    expect(output).toBe(12);
  });

  it("marshals wide values across closure call boundaries", async () => {
    const output = await compiled.run<number>({
      entryName: "value_five_lane_closure_round_trip",
    });
    expect(output).toBe(15);
  });

  it("stores wide captured values in lambda environments safely", async () => {
    const output = await compiled.run<number>({
      entryName: "value_five_lane_closure_capture",
    });
    expect(output).toBe(15);
  });
});
