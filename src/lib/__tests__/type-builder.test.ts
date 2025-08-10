import { describe, test, expect } from "vitest";
import binaryen from "binaryen";
import { TypeBuilder } from "../binaryen-gc/type-builder.js";
import { AugmentedBinaryen } from "../binaryen-gc/types.js";

const bin = binaryen as unknown as AugmentedBinaryen;

const trackFree = () => {
  let impl = bin._free;
  let count = 0;
  Object.defineProperty(bin, "_free", {
    configurable: true,
    get() {
      return (ptr: number) => {
        count++;
        return impl(ptr);
      };
    },
    set(v) {
      impl = v;
    },
  });
  return {
    get count() {
      return count;
    },
    restore() {
      Object.defineProperty(bin, "_free", {
        value: impl,
        writable: true,
        configurable: true,
      });
    },
  };
};

describe("TypeBuilder", () => {
  test("dispose frees allocations on exception", () => {
    const tracker = trackFree();
    const builder = new TypeBuilder(1);
    try {
      builder.setStruct(0, {
        name: "Test",
        fields: [{ type: bin.i32, name: "x", mutable: true }],
      });
      throw new Error("fail");
    } catch {
      // ignore
    } finally {
      builder.dispose();
    }
    expect(tracker.count).toBeGreaterThanOrEqual(3);
    tracker.restore();
  });

  test("build frees allocations", () => {
    const tracker = trackFree();
    const builder = new TypeBuilder(1);
    builder.setStruct(0, {
      name: "Test",
      fields: [{ type: bin.i32, name: "x", mutable: true }],
    });
    builder.build();
    expect(tracker.count).toBeGreaterThanOrEqual(4);
    tracker.restore();
  });
});
