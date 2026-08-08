import { describe, test, expect } from "vitest";
import binaryen from "binaryen";
import { annotateStructNames } from "../binaryen-gc/index.js";
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
  test("releases temporary UTF-8 buffers used for type annotations", () => {
    const builder = new TypeBuilder(1);
    builder.setStruct(0, {
      name: "",
      fields: [{ type: bin.i32, name: "", mutable: true }],
    });
    const heapType = builder.build();
    const mod = new binaryen.Module();
    const allocations: number[] = [];
    const frees: number[] = [];
    const malloc = bin._malloc;
    const free = bin._free;
    Object.defineProperty(bin, "_malloc", {
      configurable: true,
      value: (size: number) => {
        const pointer = malloc(size);
        allocations.push(pointer);
        return pointer;
      },
    });
    Object.defineProperty(bin, "_free", {
      configurable: true,
      value: (pointer: number) => {
        frees.push(pointer);
        free(pointer);
      },
    });

    try {
      annotateStructNames(mod, heapType, {
        name: "Tést",
        fields: [{ type: bin.i32, name: "valué", mutable: true }],
      });
      expect(allocations).toHaveLength(2);
      expect(frees).toEqual(allocations);
    } finally {
      Object.defineProperty(bin, "_malloc", {
        configurable: true,
        writable: true,
        value: malloc,
      });
      Object.defineProperty(bin, "_free", {
        configurable: true,
        writable: true,
        value: free,
      });
      mod.dispose();
    }
  });

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
