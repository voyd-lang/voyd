import { describe, it, expect } from "vitest";
import { FastShiftArray } from "../fast-shift-array.js";

describe("FastShiftArray index utilities", () => {
  it("handles negative indices with at", () => {
    const arr = new FastShiftArray(1, 2, 3);
    arr.shift();
    expect(arr.at(0)).toBe(2);
    expect(arr.at(-1)).toBe(3);
    expect(arr.at(-3)).toBe(undefined);
  });

  it("sets values using negative indices", () => {
    const arr = new FastShiftArray("a", "b", "c");
    arr.shift();
    expect(arr.set(-1, "z")).toBe(true);
    expect(arr.at(-1)).toBe("z");
    expect(arr.set(5, "w")).toBe(false);
  });

  it("slices based on resolved indices", () => {
    const arr = new FastShiftArray(1, 2, 3, 4);
    arr.shift();
    expect(arr.slice(0, 2)).toEqual([2, 3]);
    expect(arr.slice(-2)).toEqual([3, 4]);
  });

  it("splices using resolved indices", () => {
    const arr = new FastShiftArray(1, 2, 3);
    arr.shift();
    arr.splice(-1, 1, 4);
    expect(arr.toArray()).toEqual([2, 4]);
  });
});
